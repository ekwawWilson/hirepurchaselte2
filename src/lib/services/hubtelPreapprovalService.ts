import { prisma } from '../db/prisma';
import { generateTransactionRef } from '../utils/idGenerators';
import { DIRECT_DEBIT_NETWORKS, DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES, isInstalmentSale, type ContractTypeName } from '../constants/contracts';
import { recordSuccessfulHubtelCharge, claimableStatuses } from './hubtelPaymentService';
import { appendWebhookToken } from '../auth/webhookSecurity';
import {
  isHubtelLiveMode, callHubtelReceiveMoney, callHubtelPreapprovalInitiate, callHubtelPreapprovalVerifyOtp,
  callHubtelPreapprovalStatus, callHubtelPreapprovalCancel, callHubtelPreapprovalReactivate, HubtelApiError,
} from './hubtelClient';

import { getControlSettings } from './controlSettingsService';

export class PreapprovalError extends Error {}

/**
 * Preapproval's own callback URL, derived the same way the legacy hirepurchase
 * app derives it when HUBTEL_PREAPPROVAL_CALLBACK_URL isn't set explicitly:
 * swap the trailing /callback on the payment callback URL for
 * /preapproval/callback.
 */
export function preapprovalCallbackUrl(): string {
  const explicit = process.env.HUBTEL_PREAPPROVAL_CALLBACK_URL;
  if (explicit) return appendWebhookToken(explicit);
  const base = process.env.HUBTEL_CALLBACK_URL || '';
  if (!base) return '';
  try {
    const parsed = new URL(base);
    parsed.pathname = parsed.pathname.replace(/\/callback\/?$/, '/preapproval/callback');
    return appendWebhookToken(parsed.toString());
  } catch {
    return appendWebhookToken(base.replace(/\/callback\/?$/, '/preapproval/callback'));
  }
}

const RETRY_SCHEDULE_DAYS = [1, 3, 7];
/** A partial attempt is never for less than this (GHS 1) unless less than this is all that is due. */
const MIN_PARTIAL_DEBIT_MINOR = 100;

/**
 * What a retry asks for after an attempt for `previousMinor` bounced. With
 * partial debits on, half of it: a wallet that could not cover the whole
 * instalment often holds part of it, and part collected today is better than
 * the whole of it refused again. Never more than is due right now.
 */
export function retryAmountMinor(previousMinor: number, dueNowMinor: number, partial: boolean): number {
  const wanted = partial ? Math.max(Math.ceil(previousMinor / 2), MIN_PARTIAL_DEBIT_MINOR) : previousMinor;
  return Math.min(wanted, dueNowMinor);
}

/**
 * Requests a direct-debit mandate ("one-time approval"): the customer approves
 * ONCE, after which the merchant can charge the mandate repeatedly with no
 * further customer action (Hubtel's Direct Debit Preapproval API). Hubtel picks
 * how the customer approves, and says which in its answer:
 *  - USSD: a prompt on the customer's own phone. Nothing for staff to do but
 *    wait for the callback.
 *  - OTP: the number is already preapproved with another merchant, so Hubtel
 *    texts a code instead, which staff submit through submitPreapprovalOtp.
 * Reuses an existing APPROVED mandate for the same customer+number+network
 * instead of re-prompting.
 */
export async function initiatePreapproval(params: {
  customerId: string;
  msisdn: string;
  network: string;
  createdById: string;
}) {
  if (!(DIRECT_DEBIT_NETWORKS as readonly string[]).includes(params.network)) {
    throw new PreapprovalError(`Direct debit is only available on ${DIRECT_DEBIT_NETWORKS.join(', ')} — not ${params.network}`);
  }

  const existing = await prisma.hubtelPreapproval.findFirst({
    where: { customerId: params.customerId, customerMsisdn: params.msisdn, network: params.network, status: 'APPROVED' },
  });
  if (existing) return { preapproval: existing, reused: true as const };

  const clientReferenceId = generateTransactionRef();
  const preapproval = await prisma.hubtelPreapproval.create({
    data: {
      customerId: params.customerId,
      customerMsisdn: params.msisdn,
      network: params.network,
      clientReferenceId,
      status: 'PENDING',
      createdById: params.createdById,
    },
  });

  if (isHubtelLiveMode()) {
    let result;
    let immediate;
    try {
      result = await callHubtelPreapprovalInitiate({
        msisdn: params.msisdn,
        network: params.network,
        clientReferenceId,
        callbackUrl: preapprovalCallbackUrl(),
      });
      immediate = normalizePreapprovalStatus(result.preapprovalStatus ?? '');
      if (immediate && immediate !== 'APPROVED') {
        throw new HubtelApiError(result.message || 'Hubtel rejected the mandate request');
      }
    } catch (e) {
      // The call never reached Hubtel (network failure, bad credentials) or
      // was rejected outright — either way Hubtel is not tracking a request
      // it will ever call back about, and the row is not attached to a
      // contract yet (enableDirectDebit hasn't run), so staff could not even
      // see it to clean it up. Delete it rather than leave an invisible row.
      await prisma.hubtelPreapproval.delete({ where: { id: preapproval.id } });
      throw e instanceof HubtelApiError ? new PreapprovalError(e.message) : e;
    }
    // Normally stays PENDING — a mandate is only APPROVED once the customer
    // completes the USSD prompt or the OTP is verified, and the preapproval
    // callback flips it then. The exception is a number already preapproved
    // for this merchant: Hubtel answers APPROVED on the spot, prompts nobody,
    // and so never calls back, which would otherwise leave it PENDING for
    // good. verificationType/otpPrefix are stored so staff can tell "waiting
    // on the customer's phone" (USSD) from "enter the code" (OTP).
    const requested = await prisma.hubtelPreapproval.update({
      where: { id: preapproval.id },
      data: {
        hubtelPreapprovalId: result.hubtelPreapprovalId,
        verificationType: result.verificationType,
        otpPrefix: result.otpPrefix,
        ...(immediate === 'APPROVED' && { status: 'APPROVED', approvedAt: new Date() }),
      },
    });
    return { preapproval: requested, reused: false as const };
  }

  // Mock mode resolves the mandate synchronously — same convention as
  // hubtelPaymentService.initiateHubtelPayment's mock charge — no live
  // USSD-prompt/OTP/callback infrastructure needed to demo or test against.
  const approved = await prisma.hubtelPreapproval.update({
    where: { id: preapproval.id },
    data: { status: 'APPROVED', approvedAt: new Date(), hubtelPreapprovalId: `MOCK-${clientReferenceId}` },
  });
  return { preapproval: approved, reused: false as const };
}

/**
 * Submits the 4-digit OTP Hubtel texted the customer (see
 * initiatePreapproval's verificationType 'OTP' — happens when the number
 * already has a mandate with a different Hubtel merchant). Only clears the
 * OTP step: the mandate itself stays PENDING and only reaches its final
 * APPROVED/FAILED status once the usual preapproval callback arrives, same
 * as the plain USSD path.
 */
export async function submitPreapprovalOtp(params: { preapprovalId: string; otpCode: string }) {
  if (!/^\d{4}$/.test(params.otpCode)) throw new PreapprovalError('Enter the 4-digit code Hubtel texted the customer');

  const preapproval = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: params.preapprovalId } });
  if (preapproval.status !== 'PENDING') throw new PreapprovalError(`This mandate is ${preapproval.status.toLowerCase()}, not awaiting OTP`);
  if (preapproval.verificationType !== 'OTP') throw new PreapprovalError('This mandate is not waiting on an OTP');
  if (!preapproval.hubtelPreapprovalId || !preapproval.otpPrefix) {
    throw new PreapprovalError('This mandate has no OTP prefix on file — it may predate OTP support; disable it and request a new one');
  }

  let result;
  try {
    result = await callHubtelPreapprovalVerifyOtp({
      msisdn: preapproval.customerMsisdn,
      hubtelPreapprovalId: preapproval.hubtelPreapprovalId,
      clientReferenceId: preapproval.clientReferenceId,
      otpCode: `${preapproval.otpPrefix}-${params.otpCode}`,
    });
  } catch (e) {
    throw e instanceof HubtelApiError ? new PreapprovalError(e.message) : e;
  }
  if (!result.accepted) throw new PreapprovalError(result.message || 'Hubtel rejected that code');

  // Hubtel's sample answers PENDING here and settles it by callback, but the
  // field is the same one initiate uses, so a final status is taken if given.
  return applyPreapprovalStatus(preapproval, result.preapprovalStatus ?? '');
}

/**
 * Asks Hubtel where a mandate request stands — the failsafe for a preapproval
 * callback that never arrived, whichever way the customer was verifying.
 * Mock mode has nothing to ask: it settles every mandate synchronously.
 */
export async function checkPreapprovalStatus(params: { preapprovalId: string }) {
  const preapproval = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: params.preapprovalId } });
  if (!isHubtelLiveMode()) return preapproval;

  let result;
  try {
    result = await callHubtelPreapprovalStatus(preapproval.clientReferenceId);
  } catch (e) {
    throw e instanceof HubtelApiError ? new PreapprovalError(e.message) : e;
  }
  return applyPreapprovalStatus(preapproval, result.preapprovalStatus ?? '');
}

// Past this age a request Hubtel still reports as pending is left to staff's
// own "Check status" button rather than polled every sweep indefinitely.
const PREAPPROVAL_SWEEP_MAX_AGE_HOURS = 72;

/**
 * Status-checks every mandate still PENDING a while after it was requested.
 * Run on a schedule (instrumentation.ts) alongside the transaction sweep.
 * A check that itself fails leaves the mandate alone for the next run.
 */
export async function reconcilePendingPreapprovals(staleAfterMinutes = 5) {
  if (!isHubtelLiveMode()) return { checked: 0, resolved: 0 };

  const now = Date.now();
  const stale = await prisma.hubtelPreapproval.findMany({
    where: {
      status: 'PENDING',
      updatedAt: { lt: new Date(now - staleAfterMinutes * 60_000), gt: new Date(now - PREAPPROVAL_SWEEP_MAX_AGE_HOURS * 3_600_000) },
    },
  });

  let resolved = 0;
  for (const preapproval of stale) {
    try {
      const checked = await checkPreapprovalStatus({ preapprovalId: preapproval.id });
      if (checked.status !== 'PENDING') resolved += 1;
    } catch (e) {
      console.error(`[hubtel] preapproval status check for ${preapproval.clientReferenceId} failed:`, e);
    }
  }
  return { checked: stale.length, resolved };
}

/**
 * Revokes the mandate with Hubtel, not just in this app: the customer's
 * wallet stops being debitable by this merchant at all. Hubtel cancels by
 * wallet number, so every contract sharing this mandate loses it together —
 * disableDirectDebit is the one that takes a single contract off a mandate.
 */
export async function cancelPreapproval(params: { preapprovalId: string }) {
  const preapproval = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: params.preapprovalId } });
  if (preapproval.status !== 'APPROVED' && preapproval.status !== 'PENDING') {
    throw new PreapprovalError(`This mandate is already ${preapproval.status.toLowerCase()}`);
  }

  if (isHubtelLiveMode()) {
    let result;
    try {
      result = await callHubtelPreapprovalCancel(preapproval.customerMsisdn);
    } catch (e) {
      throw e instanceof HubtelApiError ? new PreapprovalError(e.message) : e;
    }
    if (!result.cancelled) throw new PreapprovalError(result.message || 'Hubtel did not cancel the mandate');
  }

  return prisma.hubtelPreapproval.update({
    where: { id: preapproval.id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
}

/**
 * Restores a cancelled mandate. Hubtel treats this like a new request — the
 * customer approves again, by USSD prompt or OTP as Hubtel decides — so the
 * mandate returns to PENDING and goes through the same verification as a
 * first-time one.
 */
export async function reactivatePreapproval(params: { preapprovalId: string }) {
  const preapproval = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: params.preapprovalId } });
  if (preapproval.status !== 'CANCELLED') throw new PreapprovalError('Only a cancelled mandate can be reactivated');

  if (!isHubtelLiveMode()) {
    return prisma.hubtelPreapproval.update({
      where: { id: preapproval.id },
      data: { status: 'APPROVED', approvedAt: new Date(), cancelledAt: null },
    });
  }

  let result;
  try {
    result = await callHubtelPreapprovalReactivate({ msisdn: preapproval.customerMsisdn, callbackUrl: preapprovalCallbackUrl() });
  } catch (e) {
    throw e instanceof HubtelApiError ? new PreapprovalError(e.message) : e;
  }
  const immediate = normalizePreapprovalStatus(result.preapprovalStatus ?? '');
  if (immediate && immediate !== 'APPROVED') throw new PreapprovalError(result.message || 'Hubtel rejected the reactivation');

  // Hubtel's answer names the reference its callback will carry. It is only
  // adopted when no other mandate row already holds it (the column is
  // unique); processPreapprovalCallback also matches on hubtelPreapprovalId,
  // so the callback still finds this row either way.
  const adoptReference = result.clientReferenceId && result.clientReferenceId !== preapproval.clientReferenceId
    && !(await prisma.hubtelPreapproval.findUnique({ where: { clientReferenceId: result.clientReferenceId } }));

  return prisma.hubtelPreapproval.update({
    where: { id: preapproval.id },
    data: {
      status: immediate === 'APPROVED' ? 'APPROVED' : 'PENDING',
      approvedAt: immediate === 'APPROVED' ? new Date() : null,
      cancelledAt: null,
      hubtelPreapprovalId: result.hubtelPreapprovalId ?? preapproval.hubtelPreapprovalId,
      verificationType: result.verificationType,
      otpPrefix: result.otpPrefix,
      ...(adoptReference && { clientReferenceId: result.clientReferenceId! }),
    },
  });
}

/**
 * Attaches a mandate to a contract, enabling direct debit for it. SAVE_TO_OWN
 * is never eligible — it's free-form savings with no due schedule to
 * auto-collect against (contractService.ts).
 *
 * ACTIVE or (for an instalment sale only) still PENDING_DEPOSIT qualify — the
 * latter so the mandate can be requested at contract creation, the moment
 * staff have the customer at the counter, rather than only after the deposit
 * clears and the customer may already be gone. Attaching it this early is
 * harmless: runDirectDebitCollections and chargeDirectDebit both separately
 * require the CONTRACT to be ACTIVE before ever charging anything, so a
 * mandate attached while still PENDING_DEPOSIT simply sits unused until then.
 */
/**
 * `paymentMethod` (DIRECT_DEBIT or BOTH — never CUSTOMER_INITIATED here, that
 * would mean no mandate at all) is optional: pass it when the caller is
 * actively choosing a collection mode (the manual "set up direct debit" route),
 * omit it when the contract already has the right value stored from creation
 * (contractService.ts's own creation-time flow) so this doesn't clobber it.
 */
export async function enableDirectDebit(params: { contractId: string; preapprovalId: string; userId: string; paymentMethod?: 'DIRECT_DEBIT' | 'BOTH' }) {
  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: params.contractId } });
  if (!DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES.includes(contract.contractType as ContractTypeName)) {
    throw new PreapprovalError(`${contract.contractType} contracts have no due schedule — direct debit isn't available for them`);
  }
  const statusEligible = contract.status === 'ACTIVE'
    || (isInstalmentSale(contract.contractType) && contract.status === 'PENDING_DEPOSIT');
  if (!statusEligible) {
    throw new PreapprovalError(`Direct debit can only be enabled on an ACTIVE contract (currently ${contract.status})`);
  }
  const preapproval = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: params.preapprovalId } });
  // PENDING is allowed too — in live mode a mandate starts PENDING and is
  // only flipped to APPROVED asynchronously once the customer completes the
  // USSD/OTP prompt on their phone (the preapproval callback route does that
  // flip). chargeDirectDebit itself still refuses to charge anything short of
  // APPROVED, so attaching a still-pending mandate here is harmless — it just
  // means the contract can't be charged yet.
  if (preapproval.status !== 'APPROVED' && preapproval.status !== 'PENDING') {
    throw new PreapprovalError(`This mandate is ${preapproval.status.toLowerCase()} and can't be attached to a contract`);
  }
  if (preapproval.customerId !== contract.customerId) throw new PreapprovalError('This mandate belongs to a different customer');

  return prisma.contract.update({
    where: { id: contract.id },
    data: {
      hubtelPreapprovalId: preapproval.id,
      updatedById: params.userId,
      ...(params.paymentMethod && { paymentMethod: params.paymentMethod }),
    },
  });
}

export async function disableDirectDebit(params: { contractId: string; userId: string }) {
  return prisma.contract.update({
    where: { id: params.contractId },
    // No mandate left to collect against — reset to CUSTOMER_INITIATED so
    // runDirectDebitCollections stops considering this contract. The
    // creation-time request is dropped with it: left in place, the deposit
    // clearing would read it as "never attempted" and prompt the customer for
    // a fresh mandate staff had just turned off (paymentService.advanceContractStatus).
    data: {
      hubtelPreapprovalId: null, paymentMethod: 'CUSTOMER_INITIATED',
      pendingDirectDebitNetwork: null, pendingDirectDebitMsisdn: null, updatedById: params.userId,
    },
  });
}

/**
 * Charges the mandate directly — no customer approval needed, that's the whole
 * point of a preapproval. Used both by a staff-triggered "charge now" action and
 * the automated collections run (collectionsService.ts). Requires an ACTIVE
 * contract even though the mandate itself may have been approved earlier, while
 * still PENDING_DEPOSIT (enableDirectDebit now allows requesting one at contract
 * creation) — the up-front deposit is deliberately never auto-debited, and this
 * is the one guard standing between "mandate approved" and "money actually
 * moves," since runDirectDebitCollections' own ACTIVE-only query only protects
 * the automated sweep, not this manual entrypoint.
 */
export async function chargeDirectDebit(params: { contractId: string; amountMinor: number }) {
  const contract = await prisma.contract.findUniqueOrThrow({
    where: { id: params.contractId },
    include: { hubtelPreapproval: true, customer: true },
  });
  if (!contract.hubtelPreapproval || contract.hubtelPreapproval.status !== 'APPROVED') {
    throw new PreapprovalError('This contract has no approved direct-debit mandate');
  }
  if (contract.status !== 'ACTIVE') {
    throw new PreapprovalError(`Direct debit can only charge an ACTIVE contract (currently ${contract.status})`);
  }
  // balanceMinor is only ever null for SAVE_TO_OWN (open-ended savings), which
  // can never reach here — it's excluded from DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES,
  // so no mandate can exist for one. The ?? 0 fallback is defensive only: it
  // would reject the charge, never silently allow an unbounded one.
  if (params.amountMinor <= 0 || params.amountMinor > (contract.balanceMinor ?? 0)) {
    throw new PreapprovalError('Charge amount must be positive and not exceed the outstanding balance');
  }

  const clientReference = generateTransactionRef();
  await prisma.hubtelTransaction.create({
    data: {
      clientReference,
      contractId: contract.id,
      msisdn: contract.hubtelPreapproval.customerMsisdn,
      amountMinor: params.amountMinor,
      status: 'PENDING',
      channel: 'DIRECT_DEBIT',
      preapprovalId: contract.hubtelPreapproval.id,
    },
  });

  if (isHubtelLiveMode()) {
    return chargeDirectDebitLive({
      clientReference,
      contractNumber: contract.contractNumber,
      customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
      customerEmail: contract.customer.email,
      msisdn: contract.hubtelPreapproval.customerMsisdn,
      network: contract.hubtelPreapproval.network,
      amountMinor: params.amountMinor,
    });
  }

  return processDirectDebitCallback({ clientReference, status: 'SUCCESS', rawPayload: JSON.stringify({ mock: true }) });
}

/**
 * The actual live Receive-Money call for a direct-debit charge — same
 * endpoint as a regular payment, just with the -direct-debit channel suffix
 * (Hubtel doesn't have a separate "charge this mandate" endpoint). Shared by
 * chargeDirectDebit and retryFailedDirectDebits so both go through Hubtel for
 * real in live mode rather than one of them silently short-circuiting.
 */
async function chargeDirectDebitLive(params: {
  clientReference: string;
  contractNumber: string;
  customerName: string;
  customerEmail: string | null;
  msisdn: string;
  network: string;
  amountMinor: number;
}) {
  let result;
  try {
    result = await callHubtelReceiveMoney({
      customerName: params.customerName,
      msisdn: params.msisdn,
      customerEmail: params.customerEmail,
      amountMinor: params.amountMinor,
      network: params.network,
      isDirectDebit: true,
      description: `Direct debit charge for ${params.contractNumber}`,
      clientReference: params.clientReference,
      callbackUrl: appendWebhookToken(process.env.HUBTEL_CALLBACK_URL || ''),
    });
  } catch (e) {
    if (!(e instanceof HubtelApiError)) throw e;
    // Refused outright: no callback will come, so it fails (and schedules
    // its retry) now. Merely unanswered stays PENDING for the status check.
    if (e.rejected) {
      await processDirectDebitCallback({
        clientReference: params.clientReference, status: 'FAILED', rawPayload: JSON.stringify({ refused: true, response: e.rejected.raw }),
      });
    }
    throw new PreapprovalError(e.message);
  }

  if (result.status === 'FAILED') {
    return processDirectDebitCallback({ clientReference: params.clientReference, status: 'FAILED', rawPayload: JSON.stringify(result.raw) });
  }
  await prisma.hubtelTransaction.update({
    where: { clientReference: params.clientReference },
    data: { rawCallbackPayload: JSON.stringify({ initiated: true, ...(result.raw as object) }) },
  });
  return prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference: params.clientReference } });
}

/**
 * Idempotent via the same conditional-update pattern as the USSD/Hubtel path
 * (paymentService.ts, hubtelPaymentService.ts) — a replayed callback can only
 * ever flip a PENDING transaction once.
 */
export async function processDirectDebitCallback(params: { clientReference: string; status: 'SUCCESS' | 'FAILED'; rawPayload: string }) {
  const txn = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference: params.clientReference } });

  const claim = await prisma.hubtelTransaction.updateMany({
    where: { id: txn.id, status: { in: claimableStatuses(params.status) } },
    // A late success on a charge already written off also calls off its retry.
    data: { status: params.status, rawCallbackPayload: params.rawPayload, ...(params.status === 'SUCCESS' && { nextRetryAt: null }) },
  });
  if (claim.count === 0) return prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txn.id } });

  if (params.status === 'SUCCESS') {
    // Same never-drop-a-collected-charge handling as a USSD payment.
    await recordSuccessfulHubtelCharge(txn.id, params.rawPayload);
  } else if (txn.retryCount < RETRY_SCHEDULE_DAYS.length) {
    // Fixed schedule (1, 3, 7 days), capped at 3 attempts — a deliberately simple,
    // hardcoded policy rather than a configurable settings model (matches this
    // codebase's existing style, e.g. overdueService's fixed DEFAULT_THRESHOLD_DAYS).
    // Counted in whole days from the start of today, so the morning run that
    // many days on finds it due — "24 hours after an 08:01 failure" would miss
    // the next day's 08:00 run by a minute and wait a day more.
    const nextRetryAt = new Date(new Date().setHours(0, 0, 0, 0) + RETRY_SCHEDULE_DAYS[txn.retryCount] * 24 * 60 * 60_000);
    await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { retryCount: { increment: 1 }, nextRetryAt } });
  }

  return prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txn.id } });
}

/**
 * Re-attempts every direct-debit charge whose scheduled retry time has arrived —
 * mirrors the legacy app's auto-retry (a failed charge is retried automatically,
 * manual/cash payments never are). Run on a schedule (instrumentation.ts).
 *
 * A retry collects what is still due, not what was asked for days ago: if the
 * customer has paid in the meantime, the contract has closed or the mandate
 * has gone, it is dropped. With partial debits on (Settings > Controls) each
 * retry asks for half of the attempt before it — see retryAmountMinor.
 */
export async function retryFailedDirectDebits() {
  const due = await prisma.hubtelTransaction.findMany({
    where: { channel: 'DIRECT_DEBIT', status: 'FAILED', nextRetryAt: { lte: new Date() } },
    orderBy: { nextRetryAt: 'asc' },
  });
  if (due.length === 0) return 0;
  const { partialDirectDebitEnabled } = await getControlSettings();

  let retried = 0;
  for (const txn of due) {
    const contract = await prisma.contract.findUniqueOrThrow({
      where: { id: txn.contractId },
      include: {
        customer: true, hubtelPreapproval: true,
        instalments: { where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lte: new Date() } } },
      },
    });
    const mandate = contract.hubtelPreapproval;
    const dueNowMinor = Math.min(
      contract.instalments.reduce((sum, i) => sum + (i.amountDueMinor - i.amountPaidMinor), 0),
      contract.balanceMinor ?? 0,
    );
    const callOff = () => prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { nextRetryAt: null } });
    if (contract.status !== 'ACTIVE' || !mandate || mandate.status !== 'APPROVED' || dueNowMinor <= 0) {
      await callOff();
      continue;
    }
    // Another attempt on this contract has not been answered yet: wait for it
    // rather than risk both succeeding. This retry stays due for the next run.
    const unanswered = await prisma.hubtelTransaction.count({ where: { contractId: contract.id, channel: 'DIRECT_DEBIT', status: 'PENDING' } });
    if (unanswered > 0) continue;

    const amountMinor = retryAmountMinor(txn.amountMinor, dueNowMinor, partialDirectDebitEnabled);
    const fullAmountMinor = txn.baseAmountMinor ?? txn.amountMinor;
    // A reference of its own: Hubtel never accepts one twice, and a suffix on
    // the original would take it past the 36 characters Hubtel allows.
    const clientReference = generateTransactionRef();
    await prisma.hubtelTransaction.create({
      data: {
        clientReference, contractId: txn.contractId, msisdn: mandate.customerMsisdn, amountMinor,
        baseAmountMinor: amountMinor < fullAmountMinor ? fullAmountMinor : null,
        status: 'PENDING', channel: 'DIRECT_DEBIT', preapprovalId: mandate.id, retryCount: txn.retryCount,
      },
    });
    await callOff(); // the new row carries the chain on; never pick the original up again

    try {
      if (isHubtelLiveMode()) {
        await chargeDirectDebitLive({
          clientReference,
          contractNumber: contract.contractNumber,
          customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
          customerEmail: contract.customer.email,
          msisdn: mandate.customerMsisdn,
          network: mandate.network,
          amountMinor,
        });
      } else {
        await processDirectDebitCallback({ clientReference, status: 'SUCCESS', rawPayload: JSON.stringify({ mock: true, retry: true }) });
      }
    } catch (e) {
      // One contract's refusal must not stop the rest of the run.
      console.error(`[collections] direct debit retry failed for contract ${contract.id}:`, e);
    }
    retried += 1;
  }
  return retried;
}

/**
 * Null for PENDING or anything unrecognized — nothing to apply yet. EXPIRED
 * is a request the customer never answered, so it is FAILED (ask again), not
 * CANCELLED, which is reserved for a mandate that was revoked and that
 * Hubtel's Reactivate call can restore.
 */
function normalizePreapprovalStatus(raw: string): 'APPROVED' | 'CANCELLED' | 'FAILED' | null {
  const upper = raw.toUpperCase();
  if (upper === 'APPROVED') return 'APPROVED';
  if (['CANCELLED', 'CANCELED'].includes(upper)) return 'CANCELLED';
  if (['DECLINED', 'FAILED', 'REJECTED', 'EXPIRED'].includes(upper)) return 'FAILED';
  return null;
}

/**
 * The one place a status reported by Hubtel — in a callback, a status check,
 * or the answer to an OTP — lands on a mandate. Idempotent: a repeat of the
 * current status changes nothing, and an approved mandate is never downgraded
 * by a late or out-of-order report (only cancelPreapproval revokes one).
 */
async function applyPreapprovalStatus<T extends { id: string; status: string; approvedAt: Date | null; cancelledAt: Date | null }>(
  preapproval: T, rawStatus: string,
) {
  const nextStatus = normalizePreapprovalStatus(rawStatus);
  if (!nextStatus || preapproval.status === nextStatus) return preapproval;
  if (preapproval.status === 'APPROVED') return preapproval;

  return prisma.hubtelPreapproval.update({
    where: { id: preapproval.id },
    data: {
      status: nextStatus,
      approvedAt: nextStatus === 'APPROVED' ? new Date() : preapproval.approvedAt,
      cancelledAt: nextStatus === 'CANCELLED' ? new Date() : preapproval.cancelledAt,
    },
  });
}

/**
 * Applies Hubtel's real preapproval callback (`{CustomerMsisdn, VerificationType,
 * PreapprovalStatus, HubtelPreapprovalId, ClientReferenceId, ...}`, casing not
 * always consistent — mirrors the legacy hirepurchase app's own
 * normalizePreapprovalCallback) — flips a PENDING mandate to APPROVED/CANCELLED
 * once the customer completes the USSD/OTP prompt Hubtel sent them.
 * Idempotent: ignores a downgrade away from APPROVED and a repeat of the same status.
 */
export async function processPreapprovalCallback(body: unknown): Promise<void> {
  const b = body as Record<string, unknown> | null | undefined;
  const clientReferenceId = (b?.ClientReferenceId ?? b?.clientReferenceId) as string | undefined;
  const hubtelPreapprovalId = (b?.HubtelPreapprovalId ?? b?.hubtelPreapprovalId) as string | undefined;
  const rawStatus = String(b?.PreapprovalStatus ?? b?.preapprovalStatus ?? '');

  if (!clientReferenceId) throw new PreapprovalError('ClientReferenceId is required');

  // By reference first; by Hubtel's own id when the reference is one this app
  // never issued, which a reactivated mandate's callback can carry
  // (reactivatePreapproval). The id is not unique here, so the mandate most
  // recently acted on is the one a fresh callback is about.
  const byReference = await prisma.hubtelPreapproval.findUnique({ where: { clientReferenceId } });
  const preapproval = byReference
    ?? (hubtelPreapprovalId
      ? await prisma.hubtelPreapproval.findFirst({ where: { hubtelPreapprovalId }, orderBy: { updatedAt: 'desc' } })
      : null);
  if (!preapproval) throw new PreapprovalError(`Unknown preapproval reference: ${clientReferenceId}`);

  if (hubtelPreapprovalId && preapproval.hubtelPreapprovalId && preapproval.hubtelPreapprovalId !== hubtelPreapprovalId) {
    throw new PreapprovalError(`Preapproval callback id mismatch for ${clientReferenceId}`);
  }

  await applyPreapprovalStatus(preapproval, rawStatus);
}
