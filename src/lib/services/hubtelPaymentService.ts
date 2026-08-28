import { prisma } from '../db/prisma';
import { generateTransactionRef } from '../utils/idGenerators';
import { postPayment } from './paymentService';

export class HubtelError extends Error {}

/**
 * Kicks off a USSD/mobile-money payment. In mock mode (HUBTEL_PAYMENTS_MODE
 * != 'live', the bootstrap default), it resolves immediately as if Hubtel had
 * already called back with success — no live credentials needed, but the
 * shape (create PENDING transaction, then process a "callback") is identical
 * to the live path, so switching modes later is a one-line change here, not a
 * rewrite of the USSD menu or the ledger posting logic.
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

  if (process.env.HUBTEL_PAYMENTS_MODE === 'live') {
    // A real integration would call Hubtel's receive-money API here and leave
    // the transaction PENDING until /api/payments/hubtel/callback fires.
    throw new HubtelError('HUBTEL_PAYMENTS_MODE=live is not wired to a real Hubtel account in this build — use mock mode.');
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
      initiatedByCustomerId: (await prisma.customer.findFirst({
        where: { OR: [{ phone: txn.msisdn }, { phone2: txn.msisdn }, { phone3: txn.msisdn }] },
      }))?.id,
    });

    await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { paymentId: result.payment.id } });
  }

  return prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txn.id } });
}

/**
 * Marks stale PENDING transactions FAILED. Meaningful mainly for live mode,
 * where a Hubtel callback can be delayed or lost; mock mode resolves
 * synchronously so nothing should linger PENDING there. Run periodically
 * (see src/instrumentation.ts) rather than only on demand.
 */
export async function reconcilePendingHubtelTransactions(staleAfterMinutes = 15) {
  // Imported lazily to avoid a module-load cycle (hubtelPreapprovalService doesn't
  // import this file, but both sit in the same service layer — keeping this one
  // import deferred is simplest and costs nothing at this call frequency).
  const { processDirectDebitCallback } = await import('./hubtelPreapprovalService');

  const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000);
  const stale = await prisma.hubtelTransaction.findMany({ where: { status: 'PENDING', createdAt: { lt: cutoff } } });

  let failed = 0;
  for (const txn of stale) {
    const rawPayload = JSON.stringify({ reconciliation: true, reason: 'stale-pending', staleAfterMinutes });
    const result = txn.channel === 'DIRECT_DEBIT'
      ? await processDirectDebitCallback({ clientReference: txn.clientReference, status: 'FAILED', rawPayload })
      : await processHubtelCallback({ clientReference: txn.clientReference, status: 'FAILED', rawPayload });
    if (result.status === 'FAILED') failed += 1;
  }
  return { checked: stale.length, failed };
}
