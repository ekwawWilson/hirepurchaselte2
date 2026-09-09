import { prisma } from '../db/prisma';
import { generateTransactionRef } from '../utils/idGenerators';
import { DIRECT_DEBIT_NETWORKS, DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES, type ContractTypeName } from '../constants/contracts';
import { postPayment } from './paymentService';
import { appendWebhookToken } from '../auth/webhookSecurity';
import { isHubtelLiveMode, callHubtelReceiveMoney, callHubtelPreapprovalInitiate, HubtelApiError } from './hubtelClient';

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

/**
 * Requests a direct-debit mandate ("one-time approval"): the customer approves
 * ONCE — via a USSD prompt or an OTP Hubtel sends straight to their phone; this
 * app never sees or handles that code — after which the merchant can charge the
 * mandate repeatedly with no further customer action (docs/01-plan.md, modeled
 * on the legacy hirepurchase app's Hubtel Preapproval API). Reuses an existing
 * APPROVED mandate for the same customer+number+network instead of re-prompting.
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
    try {
      result = await callHubtelPreapprovalInitiate({
        msisdn: params.msisdn,
        network: params.network,
        clientReferenceId,
        callbackUrl: preapprovalCallbackUrl(),
      });
    } catch (e) {
      throw e instanceof HubtelApiError ? new PreapprovalError(e.message) : e;
    }
    // Stays PENDING — a real mandate is only APPROVED once the customer
    // completes the USSD prompt or OTP on their own phone; the preapproval
    // callback route flips it once Hubtel confirms. verificationType is
    // Hubtel's own decision (not something this app requests — see
    // callHubtelPreapprovalInitiate's docs), stored so staff can tell "still
    // waiting on the customer" (USSD) apart from "stuck — this number needs
    // OTP verification, which isn't implemented" (OTP) instead of both
    // looking like the same silent PENDING.
    const pending = await prisma.hubtelPreapproval.update({
      where: { id: preapproval.id },
      data: { hubtelPreapprovalId: result.hubtelPreapprovalId, verificationType: result.verificationType },
    });
    return { preapproval: pending, reused: false as const };
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

export async function cancelPreapproval(params: { preapprovalId: string }) {
  const preapproval = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: params.preapprovalId } });
  if (preapproval.status !== 'APPROVED') throw new PreapprovalError('Only an approved mandate can be cancelled');
  return prisma.hubtelPreapproval.update({
    where: { id: preapproval.id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });
}

/**
 * Attaches a mandate to a contract, enabling direct debit for it. SAVE_TO_OWN
 * is never eligible — it's free-form savings with no due schedule to
 * auto-collect against (contractService.ts).
 *
 * ACTIVE or (for DEPOSIT_INSTALMENT only) still PENDING_DEPOSIT qualify — the
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
    || (contract.contractType === 'DEPOSIT_INSTALMENT' && contract.status === 'PENDING_DEPOSIT');
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
    // runDirectDebitCollections stops considering this contract.
    data: { hubtelPreapprovalId: null, paymentMethod: 'CUSTOMER_INITIATED', updatedById: params.userId },
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
    throw e instanceof HubtelApiError ? new PreapprovalError(e.message) : e;
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
    where: { id: txn.id, status: 'PENDING' },
    data: { status: params.status, rawCallbackPayload: params.rawPayload },
  });
  if (claim.count === 0) return prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txn.id } });

  if (params.status === 'SUCCESS') {
    const result = await postPayment({
      contractId: txn.contractId,
      amountMinor: txn.amountMinor,
      entryType: 'INSTALMENT_PAYMENT',
      channel: 'DIRECT_DEBIT',
      transactionRef: txn.clientReference,
      externalRef: txn.clientReference,
      rawGatewayPayload: params.rawPayload,
    });
    await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { paymentId: result.payment.id } });
  } else if (txn.retryCount < RETRY_SCHEDULE_DAYS.length) {
    // Fixed schedule (1, 3, 7 days), capped at 3 attempts — a deliberately simple,
    // hardcoded policy rather than a configurable settings model (matches this
    // codebase's existing style, e.g. overdueService's fixed DEFAULT_THRESHOLD_DAYS).
    const nextRetryAt = new Date(Date.now() + RETRY_SCHEDULE_DAYS[txn.retryCount] * 24 * 60 * 60_000);
    await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { retryCount: { increment: 1 }, nextRetryAt } });
  }

  return prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txn.id } });
}

/**
 * Re-attempts every direct-debit charge whose scheduled retry time has arrived —
 * mirrors the legacy app's auto-retry (a failed charge is retried automatically,
 * manual/cash payments never are). Run on a schedule (instrumentation.ts).
 */
export async function retryFailedDirectDebits() {
  const due = await prisma.hubtelTransaction.findMany({
    where: { channel: 'DIRECT_DEBIT', status: 'FAILED', nextRetryAt: { lte: new Date() } },
  });

  let retried = 0;
  for (const txn of due) {
    const clientReference = `${txn.clientReference}-retry${txn.retryCount}`;
    await prisma.hubtelTransaction.create({
      data: {
        clientReference, contractId: txn.contractId, msisdn: txn.msisdn, amountMinor: txn.amountMinor,
        status: 'PENDING', channel: 'DIRECT_DEBIT', preapprovalId: txn.preapprovalId, retryCount: txn.retryCount,
      },
    });

    if (isHubtelLiveMode()) {
      const contract = await prisma.contract.findUniqueOrThrow({ where: { id: txn.contractId }, include: { customer: true } });
      const preapproval = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: txn.preapprovalId! } });
      await chargeDirectDebitLive({
        clientReference,
        contractNumber: contract.contractNumber,
        customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
        customerEmail: contract.customer.email,
        msisdn: txn.msisdn,
        network: preapproval.network,
        amountMinor: txn.amountMinor,
      });
    } else {
      await processDirectDebitCallback({ clientReference, status: 'SUCCESS', rawPayload: JSON.stringify({ mock: true, retry: true }) });
    }

    await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { nextRetryAt: null } }); // don't re-pick the original row up again
    retried += 1;
  }
  return retried;
}

function normalizePreapprovalStatus(raw: string): 'APPROVED' | 'CANCELLED' | 'FAILED' | null {
  const upper = raw.toUpperCase();
  if (upper === 'APPROVED') return 'APPROVED';
  if (['CANCELLED', 'CANCELED', 'EXPIRED'].includes(upper)) return 'CANCELLED';
  if (['DECLINED', 'FAILED', 'REJECTED'].includes(upper)) return 'FAILED';
  return null;
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

  const preapproval = await prisma.hubtelPreapproval.findUnique({ where: { clientReferenceId } });
  if (!preapproval) throw new PreapprovalError(`Unknown preapproval reference: ${clientReferenceId}`);

  if (hubtelPreapprovalId && preapproval.hubtelPreapprovalId && preapproval.hubtelPreapprovalId !== hubtelPreapprovalId) {
    throw new PreapprovalError(`Preapproval callback id mismatch for ${clientReferenceId}`);
  }

  const nextStatus = normalizePreapprovalStatus(rawStatus);
  if (!nextStatus) return; // an intermediate/unrecognized status — nothing to apply yet
  if (preapproval.status === 'APPROVED' && nextStatus !== 'APPROVED') return; // never downgrade an approved mandate
  if (preapproval.status === nextStatus) return; // duplicate callback

  await prisma.hubtelPreapproval.update({
    where: { id: preapproval.id },
    data: {
      status: nextStatus,
      approvedAt: nextStatus === 'APPROVED' ? new Date() : preapproval.approvedAt,
      cancelledAt: nextStatus === 'CANCELLED' ? new Date() : preapproval.cancelledAt,
    },
  });
}
