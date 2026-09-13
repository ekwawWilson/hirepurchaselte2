import { prisma } from '../db/prisma';
import { generateTransactionRef } from '../utils/idGenerators';
import { postPayment, postDeviceLoanPayment, getDeviceLoanState, PaymentError } from './paymentService';
import { appendWebhookToken } from '../auth/webhookSecurity';
import { isHubtelLiveMode, callHubtelReceiveMoney, resolveHubtelStatus, HubtelApiError, phoneVariants } from './hubtelClient';
import { logAudit } from './auditService';

export class HubtelError extends Error {}

/**
 * Kicks off a USSD/mobile-money payment. In mock mode (HUBTEL_PAYMENTS_MODE
 * != 'live', the bootstrap default), it resolves immediately as if Hubtel had
 * already called back with success — no live credentials needed. In live
 * mode, calls Hubtel's real Receive-Money API (the same product the legacy
 * hirepurchase app uses) and leaves the transaction PENDING for
 * /api/payments/hubtel/callback to resolve, unless Hubtel rejects the request
 * outright (bad channel, malformed payload) — that's settled immediately
 * since no callback will ever arrive for it.
 */
export async function initiateHubtelPayment(params: {
  contractId: string;
  msisdn: string;
  amountMinor: number;
  network?: string;
}) {
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
    const network = params.network ?? 'MTN';
    const callbackUrl = appendWebhookToken(process.env.HUBTEL_CALLBACK_URL || '');

    let result;
    try {
      result = await callHubtelReceiveMoney({
        customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
        msisdn: params.msisdn,
        customerEmail: contract.customer.email,
        amountMinor: params.amountMinor,
        network,
        isDirectDebit: false,
        description: `Payment for ${contract.contractNumber}`,
        clientReference,
        callbackUrl,
      });
    } catch (e) {
      throw e instanceof HubtelApiError ? new HubtelError(e.message) : e;
    }

    if (result.status === 'FAILED') {
      return processHubtelCallback({ clientReference, status: 'FAILED', rawPayload: JSON.stringify(result.raw) });
    }
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
    rawPayload: JSON.stringify({ mock: true, network: params.network ?? 'MTN', simulatedAt: new Date().toISOString() }),
  });
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

  const claim = await prisma.hubtelTransaction.updateMany({
    where: { id: txn.id, status: 'PENDING' },
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
 */
export async function reconcilePendingHubtelTransactions(staleAfterMinutes = 15) {
  // Imported lazily to avoid a module-load cycle (hubtelPreapprovalService doesn't
  // import this file, but both sit in the same service layer — keeping this one
  // import deferred is simplest and costs nothing at this call frequency).
  const { processDirectDebitCallback } = await import('./hubtelPreapprovalService');
  const { checkHubtelTransactionStatus } = await import('./hubtelStatusCheckService');

  const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000);
  const stale = await prisma.hubtelTransaction.findMany({ where: { status: 'PENDING', createdAt: { lt: cutoff } } });

  let succeeded = 0;
  let failed = 0;
  let stillPending = 0;
  for (const txn of stale) {
    let checkedStatus: 'SUCCESS' | 'FAILED' | 'PENDING';
    try {
      checkedStatus = (await checkHubtelTransactionStatus(txn.clientReference)).status;
    } catch {
      // The status check itself failed (network/misconfiguration) — don't guess;
      // leave this one PENDING for the next sweep rather than risk wrongly
      // failing a payment that may actually have succeeded.
      stillPending += 1;
      continue;
    }

    // 'PENDING' (mock mode, or Hubtel genuinely hasn't resolved it yet) falls
    // through to the stale-pending fallback, preserving today's mock behavior.
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

  return { checked: stale.length, succeeded, failed, stillPending, unrecordedRetried: unrecorded.length, recorded };
}
