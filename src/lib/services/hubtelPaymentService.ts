import { prisma } from '../db/prisma';
import { generateTransactionRef } from '../utils/idGenerators';
import { postPayment, postDeviceLoanPayment, getDeviceLoanState, PaymentError } from './paymentService';
import { appendWebhookToken } from '../auth/webhookSecurity';
import {
  isHubtelLiveMode, callHubtelReceiveMoney, getHubtelChannel, resolveHubtelStatus, describeHubtelRejection, HubtelApiError, phoneVariants,
} from './hubtelClient';
import { logAudit } from './auditService';
import { isOwnPhoneNumber } from './customerPortalService';
import { networkForPhone } from '../constants/customers';
import { TERMINAL_CONTRACT_STATUSES, PRE_APPROVAL_STATUSES } from '../constants/contracts';
import { paymentAmountProblem, waitingPromptProblem } from './paymentLimitsService';

/**
 * `message` is fit to show whoever is paying. `staffDetail`, when set, is
 * what Hubtel actually said — for staff, who can act on "this server's IP is
 * not whitelisted" where a customer cannot.
 */
export class HubtelError extends Error {
  constructor(message: string, readonly staffDetail?: string) {
    super(message);
  }
}

/**
 * Why a mobile money prompt may not be sent for this contract, amount and
 * number — or null if it may. One set of rules for every place a prompt is
 * asked for by hand (the customer portal, staff at the counter), so neither
 * decides for itself what may be charged or to whom.
 */
export async function mobileMoneyRequestProblem(params: {
  contract: { id: string; status: string; contractType: string };
  customer: { phone: string | null; phone2: string | null; phone3: string | null };
  amountMinor: number;
  msisdn: string;
}): Promise<{ status: 400 | 409; error: string } | null> {
  const { contract } = params;
  if (TERMINAL_CONTRACT_STATUSES.includes(contract.status)) {
    return { status: 409, error: `This contract is ${contract.status.toLowerCase()} and takes no further payments` };
  }
  if (PRE_APPROVAL_STATUSES.includes(contract.status)) {
    return { status: 409, error: 'This contract has not been approved yet and takes no payments' };
  }

  // Hubtel requires this of every Receive Money integration: a prompt may
  // only go to a number the business already holds for that customer, never
  // to one typed in at payment time — otherwise anyone could be sent
  // unsolicited payment prompts through this merchant account.
  if (!isOwnPhoneNumber(params.customer, params.msisdn)) {
    return { status: 400, error: 'Payments can only be requested on a mobile money number registered to this customer' };
  }

  // A device loan is only ever paid as one of two exact amounts — the same
  // two the USSD menu offers (paymentService.postDeviceLoanPayment).
  if (contract.contractType !== 'DEVICE_LOAN') {
    const amountProblem = await paymentAmountProblem(contract.id, params.amountMinor);
    if (amountProblem) return { status: 400, error: amountProblem };
  }
  const waiting = await waitingPromptProblem(contract.id, params.msisdn);
  if (waiting) return { status: 409, error: waiting };
  if (contract.contractType === 'DEVICE_LOAN') {
    const state = await getDeviceLoanState(contract.id);
    const isInterest = state.accruedInterestMinor > 0 && params.amountMinor === state.accruedInterestMinor;
    const isPrincipal = state.principalOutstanding && params.amountMinor === state.principalMinor;
    if (!isInterest && !isPrincipal) {
      return { status: 400, error: 'Pay either the interest owed or the full loan amount — a device loan takes no other amount' };
    }
  }
  return null;
}

/**
 * Kicks off a USSD/mobile-money payment. In mock mode (HUBTEL_PAYMENTS_MODE
 * != 'live', the bootstrap default), it resolves immediately as if Hubtel had
 * already called back with success — no live credentials needed. In live
 * mode, calls Hubtel's real Receive-Money API (the same product the legacy
 * hirepurchase app uses) and leaves the transaction PENDING for
 * /api/payments/hubtel/callback to resolve, unless Hubtel rejects the request
 * outright (bad channel, malformed payload) — that's settled immediately
 * since no callback will ever arrive for it, and thrown as a HubtelError
 * whose message is fit to show the person paying.
 *
 * `network` is the wallet's own, and Hubtel fails a number sent down another
 * network's channel. A caller that knows it (the USSD gateway names the
 * dialling line's operator; a customer may pick it) passes it; otherwise it
 * is read from the number's prefix. There is no default.
 */
export async function initiateHubtelPayment(params: {
  contractId: string;
  msisdn: string;
  amountMinor: number;
  network?: string;
}) {
  const network = params.network ?? networkForPhone(params.msisdn);
  if (isHubtelLiveMode()) {
    if (!network) throw new HubtelError('We could not tell which network this number is on. Choose the network and try again.');
    try {
      getHubtelChannel(network);
    } catch (e) {
      throw e instanceof HubtelApiError ? new HubtelError(e.message) : e;
    }
  }

  const clientReference = generateTransactionRef();

  await prisma.hubtelTransaction.create({
    data: {
      clientReference,
      contractId: params.contractId,
      msisdn: params.msisdn,
      amountMinor: params.amountMinor,
      status: 'PENDING',
    },
  });

  if (isHubtelLiveMode()) {
    const contract = await prisma.contract.findUniqueOrThrow({
      where: { id: params.contractId },
      include: { customer: true },
    });
    const callbackUrl = appendWebhookToken(process.env.HUBTEL_CALLBACK_URL || '');

    let result;
    try {
      result = await callHubtelReceiveMoney({
        customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
        msisdn: params.msisdn,
        customerEmail: contract.customer.email,
        amountMinor: params.amountMinor,
        network: network!,
        isDirectDebit: false,
        description: `Payment for ${contract.contractNumber}`,
        clientReference,
        callbackUrl,
      });
    } catch (e) {
      if (!(e instanceof HubtelApiError)) throw e;
      // Not refused, just unanswered (a gateway error, say): Hubtel may have
      // taken the request, so it stays PENDING for the status check to settle.
      if (!e.rejected) throw new HubtelError('We could not reach the mobile money service. Please try again in a few minutes.', e.message);
      return refuseHubtelPayment(clientReference, e.rejected.responseCode, e.message, e.rejected.raw);
    }

    // Anything but "0001 — accepted, expect a callback" is a refusal too.
    if (result.status === 'FAILED') return refuseHubtelPayment(clientReference, result.responseCode, result.message, result.raw);
    // PENDING — stash the initial response for traceability; the transaction
    // itself stays PENDING until the callback (or the reconcile sweep's
    // status check) settles it.
    await prisma.hubtelTransaction.update({
      where: { clientReference },
      data: { rawCallbackPayload: JSON.stringify({ initiated: true, ...(result.raw as object) }) },
    });
    return prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference } });
  }

  return processHubtelCallback({
    clientReference,
    status: 'SUCCESS',
    rawPayload: JSON.stringify({ mock: true, network: network ?? 'MTN', simulatedAt: new Date().toISOString() }),
  });
}

/**
 * Hubtel turned the request down: nothing was charged and no callback will
 * come, so the transaction is settled FAILED on the spot rather than left for
 * the sweep, and the caller gets a reason it can show (Hubtel's own text is
 * kept in the transaction and the server log, since much of it is about this
 * merchant account rather than the customer).
 */
async function refuseHubtelPayment(clientReference: string, responseCode: string | null, message: string, raw: unknown): Promise<never> {
  console.error(`[hubtel] receive-money ${clientReference} refused (${responseCode ?? 'no code'}): ${message}`);
  await processHubtelCallback({ clientReference, status: 'FAILED', rawPayload: JSON.stringify({ refused: true, response: raw }) });
  throw new HubtelError(describeHubtelRejection(responseCode, message), message);
}

/**
 * Processes a Hubtel callback (real or mock) and posts to the ledger on
 * SUCCESS. Idempotent via a conditional update — `status: 'PENDING'` in the
 * WHERE clause means a replayed/duplicate callback can only ever flip the
 * transaction once; postPayment's own transactionRef uniqueness is a second,
 * independent layer of the same guarantee (see docs/00-legacy-study.md §4).
 */
export async function processHubtelCallback(params: {
  clientReference: string;
  status: 'SUCCESS' | 'FAILED';
  rawPayload: string;
}) {
  const txn = await prisma.hubtelTransaction.findUnique({ where: { clientReference: params.clientReference } });
  if (!txn) throw new HubtelError(`Unknown Hubtel transaction reference: ${params.clientReference}`);

  // A direct-debit charge rides the same Receive Money endpoint and so the
  // same callback URL, but a failed one also has a retry to schedule.
  if (txn.channel === 'DIRECT_DEBIT') {
    const { processDirectDebitCallback } = await import('./hubtelPreapprovalService');
    return processDirectDebitCallback(params);
  }

  const claim = await prisma.hubtelTransaction.updateMany({
    where: { id: txn.id, status: { in: claimableStatuses(params.status) } },
    data: { status: params.status, rawCallbackPayload: params.rawPayload },
  });

  if (claim.count === 0) {
    // Already processed by an earlier (possibly duplicate) callback — no-op.
    return prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txn.id } });
  }

  if (params.status === 'SUCCESS') await recordSuccessfulHubtelCharge(txn.id, params.rawPayload);

  return prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txn.id } });
}

/**
 * Which transactions a reported outcome may still land on. A failure only
 * ever settles one that is PENDING. A success also overrides FAILED: the
 * sweep gives up on a transaction Hubtel still calls Unpaid after a while,
 * and a customer who approves the prompt after that has still paid — the
 * money must not go unrecorded because this app stopped waiting.
 */
export function claimableStatuses(incoming: 'SUCCESS' | 'FAILED'): string[] {
  return incoming === 'SUCCESS' ? ['PENDING', 'FAILED'] : ['PENDING'];
}

/**
 * Posts a HubtelTransaction that is already SUCCESS — the customer's money
 * has left their wallet — to the payments ledger, for both USSD and
 * DIRECT_DEBIT charges.
 *
 * A charge must never be silently dropped:
 *  - If the ledger refuses it on a business rule (the contract completed or
 *    was cancelled in the meantime, a loan amount no longer matches anything
 *    owed), the transaction becomes NEEDS_REVIEW and a
 *    HUBTEL_PAYMENT_UNRECORDED audit entry records why, so staff can refund
 *    or post it by hand.
 *  - Any other error (database down, process killed) is rethrown and leaves
 *    the transaction SUCCESS with no paymentId, which
 *    reconcilePendingHubtelTransactions retries. Retrying is safe:
 *    postPayment and postDeviceLoanPayment are idempotent on the
 *    clientReference used as transactionRef.
 */
export async function recordSuccessfulHubtelCharge(txnId: string, rawPayload: string) {
  const txn = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txnId } });
  if (txn.status !== 'SUCCESS' || txn.paymentId) return;

  try {
    const paymentId = await postHubtelCharge(txn, rawPayload);
    await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { paymentId } });
  } catch (e) {
    if (!(e instanceof PaymentError || e instanceof HubtelError)) throw e;
    console.error(`[hubtel] charge ${txn.clientReference} was collected but could not be recorded: ${e.message}`);
    await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { status: 'NEEDS_REVIEW' } });
    const { raiseAlert } = await import('./alertService');
    await raiseAlert({
      kind: 'PAYMENT_NEEDS_REVIEW',
      message: `A mobile money payment was collected but could not be applied to its contract (${e.message}). See Mobile Money > Needs review.`,
      dedupeKey: `payment-needs-review:${txn.id}`,
    });
    await logAudit({
      userId: null,
      action: 'HUBTEL_PAYMENT_UNRECORDED',
      entityType: 'HubtelTransaction',
      entityId: txn.id,
      newValues: {
        clientReference: txn.clientReference, contractId: txn.contractId, msisdn: txn.msisdn,
        amountMinor: txn.amountMinor, channel: txn.channel, reason: e.message,
      },
    });
  }
}

async function postHubtelCharge(
  txn: { clientReference: string; contractId: string; msisdn: string; amountMinor: number; channel: string },
  rawPayload: string,
): Promise<string> {
  if (txn.channel === 'DIRECT_DEBIT') {
    const result = await postPayment({
      contractId: txn.contractId,
      amountMinor: txn.amountMinor,
      entryType: 'INSTALMENT_PAYMENT',
      channel: 'DIRECT_DEBIT',
      transactionRef: txn.clientReference,
      externalRef: txn.clientReference,
      rawGatewayPayload: rawPayload,
    });
    return result.payment.id;
  }

  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: txn.contractId } });
  const variants = phoneVariants(txn.msisdn);
  const initiatedByCustomerId = (await prisma.customer.findFirst({
    where: { OR: variants.flatMap((v) => [{ phone: v }, { phone2: v }, { phone3: v }]) },
  }))?.id;

  if (contract.contractType === 'DEVICE_LOAN') {
    // DEVICE_LOAN has no free-form entryType — the USSD prompt only ever
    // offers two exact amounts (ussdService.ts), so the charged amount itself
    // identifies which one was chosen. Anything that isn't the full loan
    // amount is interest: more may have accrued between the customer
    // confirming and this callback, so the oldest days of interest are
    // matched (acceptOldestInterestDays) rather than requiring today's total.
    const state = await getDeviceLoanState(contract.id);
    const option = state.principalOutstanding && txn.amountMinor === state.principalMinor ? 'PRINCIPAL' : 'INTEREST';
    const result = await postDeviceLoanPayment({
      contractId: txn.contractId,
      option,
      amountMinor: txn.amountMinor,
      channel: 'USSD',
      transactionRef: txn.clientReference,
      rawGatewayPayload: rawPayload,
      initiatedByCustomerId,
      acceptOldestInterestDays: true,
    });
    return result.payment.id;
  }

  const entryType = contract.contractType === 'DEPOSIT_INSTALMENT' && contract.status === 'PENDING_DEPOSIT'
    ? 'DEPOSIT'
    : 'INSTALMENT_PAYMENT';
  const result = await postPayment({
    contractId: txn.contractId,
    amountMinor: txn.amountMinor,
    entryType,
    channel: 'USSD',
    transactionRef: txn.clientReference,
    externalRef: txn.clientReference,
    rawGatewayPayload: rawPayload,
    initiatedByCustomerId,
  });
  return result.payment.id;
}

/**
 * Normalizes Hubtel's real receive-money callback body (`{ResponseCode,
 * Message, Data: {ClientReference, TransactionId, ExternalTransactionId, ...}}`)
 * into the internal {clientReference, status} shape processHubtelCallback
 * expects — same field paths/casing the legacy hirepurchase app's own
 * normalizeHubtelCallback tolerates, since Hubtel's exact casing isn't
 * perfectly consistent across accounts/products.
 */
export function normalizeHubtelPaymentCallback(body: unknown): { clientReference: string | null; status: 'SUCCESS' | 'FAILED' | 'PENDING' } {
  const b = body as Record<string, unknown> | null | undefined;
  const data = (b?.Data ?? b?.data ?? {}) as Record<string, unknown>;
  const clientReference = (data.ClientReference ?? data.clientReference ?? null) as string | null;
  return { clientReference, status: resolveHubtelStatus(body) };
}

/**
 * Resolves stale PENDING transactions. Meaningful mainly for live mode, where
 * a Hubtel callback can be delayed or lost; mock mode resolves synchronously
 * so nothing should linger PENDING there. Run periodically (see
 * src/instrumentation.ts) rather than only on demand.
 *
 * Before assuming a stale transaction failed, this asks Hubtel's own
 * Transaction Status Check API what actually happened — required per Hubtel's
 * docs precisely because a lost callback for a payment that really succeeded
 * must never be silently written off as FAILED (money would leave the
 * customer's wallet with nothing posted to their contract balance).
 *
 * Hubtel's rule is to check once five minutes have passed with no callback.
 * Paid or Refunded settles the transaction then. Unpaid does not: the prompt
 * may still be sitting on the customer's phone, so it is checked again each
 * sweep and only written off once `giveUpAfterMinutes` old.
 */
/** How long a payment may go unanswered, with the status check failing, before someone is told. */
const STATUS_CHECK_ALERT_AFTER_MS = 30 * 60_000;

export async function reconcilePendingHubtelTransactions(staleAfterMinutes = 5, giveUpAfterMinutes = 15) {
  // Imported lazily to avoid a module-load cycle (hubtelPreapprovalService doesn't
  // import this file, but both sit in the same service layer — keeping this one
  // import deferred is simplest and costs nothing at this call frequency).
  const { processDirectDebitCallback } = await import('./hubtelPreapprovalService');
  const { checkHubtelTransactionStatus } = await import('./hubtelStatusCheckService');

  const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000);
  const giveUpCutoff = new Date(Date.now() - Math.max(staleAfterMinutes, giveUpAfterMinutes) * 60_000);
  const stale = await prisma.hubtelTransaction.findMany({ where: { status: 'PENDING', createdAt: { lt: cutoff } } });

  let succeeded = 0;
  let failed = 0;
  let stillPending = 0;
  let statusCheckErrors = 0;
  let lastStatusCheckError: string | null = null;
  let oldestUnanswered: Date | null = null;
  for (const txn of stale) {
    let checkedStatus: 'SUCCESS' | 'FAILED' | 'PENDING';
    try {
      checkedStatus = (await checkHubtelTransactionStatus(txn.clientReference)).status;
    } catch (e) {
      // The status check itself failed (network/misconfiguration) — don't guess;
      // leave this one PENDING for the next sweep rather than risk wrongly
      // failing a payment that may actually have succeeded. But say why: a
      // check that never works leaves payments waiting with no one told.
      lastStatusCheckError = e instanceof Error ? (e.cause instanceof Error ? `${e.message} (${e.cause.message})` : e.message) : String(e);
      console.error(`[hubtel] status check for ${txn.channel} payment ${txn.clientReference} failed: ${lastStatusCheckError}`);
      statusCheckErrors += 1;
      if (!oldestUnanswered || txn.createdAt < oldestUnanswered) oldestUnanswered = txn.createdAt;
      stillPending += 1;
      continue;
    }
    if (checkedStatus === 'PENDING' && txn.createdAt > giveUpCutoff) {
      stillPending += 1;
      continue;
    }

    // 'PENDING' this long after (mock mode, or Hubtel still reporting it
    // Unpaid) is written off; a success that turns up later still lands
    // (claimableStatuses).
    const rawPayload = JSON.stringify({
      reconciliation: true,
      reason: checkedStatus === 'PENDING' ? 'stale-pending-unresolved' : 'status-check',
      staleAfterMinutes,
    });
    const finalStatus = checkedStatus === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
    const result = txn.channel === 'DIRECT_DEBIT'
      ? await processDirectDebitCallback({ clientReference: txn.clientReference, status: finalStatus, rawPayload })
      : await processHubtelCallback({ clientReference: txn.clientReference, status: finalStatus, rawPayload });
    if (result.status === 'SUCCESS') succeeded += 1;
    if (result.status === 'FAILED') failed += 1;
  }

  // Charges marked SUCCESS whose ledger posting never completed — the process
  // died, or the database errored, between the claim and the posting (see
  // recordSuccessfulHubtelCharge). Retried here until they post or are
  // flagged NEEDS_REVIEW.
  const unrecorded = await prisma.hubtelTransaction.findMany({
    where: { status: 'SUCCESS', paymentId: null, updatedAt: { lt: cutoff } },
  });
  let recorded = 0;
  for (const txn of unrecorded) {
    try {
      await recordSuccessfulHubtelCharge(txn.id, txn.rawCallbackPayload ?? JSON.stringify({ reconciliation: true }));
      recorded += 1;
    } catch (e) {
      console.error(`[hubtel] retrying ledger posting for ${txn.clientReference} failed:`, e);
    }
  }

  // Thirty minutes is well past both Hubtel's callback and its own five-minute
  // status-check rule: these payments will not resolve on their own.
  if (oldestUnanswered && Date.now() - oldestUnanswered.getTime() > STATUS_CHECK_ALERT_AFTER_MS) {
    const { raiseAlert } = await import('./alertService');
    await raiseAlert({
      kind: 'HUBTEL_STATUS_CHECK_FAILING',
      message: `${statusCheckErrors} mobile money payment(s) have had no result from Hubtel for over 30 minutes, and Hubtel's status check is not answering (${lastStatusCheckError}). They stay pending until Hubtel answers or sends the payment result. Check with Hubtel that this server's IP address is whitelisted for the status check, and that the Service Fulfilment URL is set.`,
      dedupeKey: 'hubtel-status-check-failing',
    });
  }

  return { checked: stale.length, succeeded, failed, stillPending, statusCheckErrors, unrecordedRetried: unrecorded.length, recorded };
}
