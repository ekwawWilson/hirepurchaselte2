import { prisma } from '../db/prisma';
import { generateTransactionRef } from '../utils/idGenerators';
import { postPayment, postDeviceLoanPayment, getDeviceLoanState } from './paymentService';
import { appendWebhookToken } from '../auth/webhookSecurity';
import { isHubtelLiveMode, callHubtelReceiveMoney, resolveHubtelStatus, HubtelApiError } from './hubtelClient';

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

  if (params.status === 'SUCCESS') {
    const contract = await prisma.contract.findUniqueOrThrow({ where: { id: txn.contractId } });
    const initiatedByCustomerId = (await prisma.customer.findFirst({
      where: { OR: [{ phone: txn.msisdn }, { phone2: txn.msisdn }, { phone3: txn.msisdn }] },
    }))?.id;

    if (contract.contractType === 'DEVICE_LOAN') {
      // DEVICE_LOAN has no free-form entryType — the USSD prompt only ever
      // offers two exact amounts (ussdService.ts), so the charged amount
      // itself identifies which one was chosen.
      const state = await getDeviceLoanState(contract.id);
      const option: 'PRINCIPAL' | 'INTEREST' | null =
        state.principalOutstanding && txn.amountMinor === state.principalMinor ? 'PRINCIPAL'
          : state.accruedInterestMinor > 0 && txn.amountMinor === state.accruedInterestMinor ? 'INTEREST'
            : null;
      if (!option) {
        // The amount owed shifted between the customer confirming it and
        // Hubtel actually charging it (e.g. a day's interest accrued in
        // between) — fail loudly rather than silently misrecord a real charge.
        throw new HubtelError(
          `Hubtel charged GHS${(txn.amountMinor / 100).toFixed(2)} for a DEVICE_LOAN payment that no longer matches ` +
          `either the accrued interest or the full loan amount — refusing to record it automatically`,
        );
      }
      const result = await postDeviceLoanPayment({
        contractId: txn.contractId,
        option,
        amountMinor: txn.amountMinor,
        channel: 'USSD',
        transactionRef: txn.clientReference,
        rawGatewayPayload: params.rawPayload,
        initiatedByCustomerId,
      });
      await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { paymentId: result.payment.id } });
    } else {
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
        rawGatewayPayload: params.rawPayload,
        initiatedByCustomerId,
      });

      await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { paymentId: result.payment.id } });
    }
  }

  return prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txn.id } });
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
  return { checked: stale.length, succeeded, failed, stillPending };
}
