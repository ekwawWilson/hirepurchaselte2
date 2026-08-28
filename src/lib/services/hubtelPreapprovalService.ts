import { prisma } from '../db/prisma';
import { generateTransactionRef } from '../utils/idGenerators';
import { DIRECT_DEBIT_NETWORKS, DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES, type ContractTypeName } from '../constants/contracts';
import { postPayment } from './paymentService';

export class PreapprovalError extends Error {}

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

  if (process.env.HUBTEL_PAYMENTS_MODE === 'live') {
    throw new PreapprovalError('HUBTEL_PAYMENTS_MODE=live is not wired to a real Hubtel account in this build — use mock mode.');
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
 * Attaches an APPROVED mandate to a contract, enabling direct debit for it.
 * SAVE_TO_OWN is never eligible — it's free-form savings with no due schedule to
 * auto-collect against (contractService.ts). Only an ACTIVE contract qualifies:
 * a DEPOSIT_INSTALMENT contract still PENDING_DEPOSIT has no instalment schedule
 * to charge against yet, and the up-front deposit itself is deliberately never
 * auto-debited.
 */
export async function enableDirectDebit(params: { contractId: string; preapprovalId: string; userId: string }) {
  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: params.contractId } });
  if (!DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES.includes(contract.contractType as ContractTypeName)) {
    throw new PreapprovalError(`${contract.contractType} contracts have no due schedule — direct debit isn't available for them`);
  }
  if (contract.status !== 'ACTIVE') {
    throw new PreapprovalError(`Direct debit can only be enabled on an ACTIVE contract (currently ${contract.status})`);
  }
  const preapproval = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: params.preapprovalId } });
  if (preapproval.status !== 'APPROVED') throw new PreapprovalError('The mandate must be APPROVED before it can be attached to a contract');
  if (preapproval.customerId !== contract.customerId) throw new PreapprovalError('This mandate belongs to a different customer');

  return prisma.contract.update({
    where: { id: contract.id },
    data: { hubtelPreapprovalId: preapproval.id, updatedById: params.userId },
  });
}

export async function disableDirectDebit(params: { contractId: string; userId: string }) {
  return prisma.contract.update({
    where: { id: params.contractId },
    data: { hubtelPreapprovalId: null, updatedById: params.userId },
  });
}

/**
 * Charges the mandate directly — no customer approval needed, that's the whole
 * point of a preapproval. Used both by a staff-triggered "charge now" action and
 * the automated collections run (collectionsService.ts).
 */
export async function chargeDirectDebit(params: { contractId: string; amountMinor: number }) {
  const contract = await prisma.contract.findUniqueOrThrow({
    where: { id: params.contractId },
    include: { hubtelPreapproval: true },
  });
  if (!contract.hubtelPreapproval || contract.hubtelPreapproval.status !== 'APPROVED') {
    throw new PreapprovalError('This contract has no approved direct-debit mandate');
  }
  if (params.amountMinor <= 0 || params.amountMinor > contract.balanceMinor) {
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

  if (process.env.HUBTEL_PAYMENTS_MODE === 'live') {
    throw new PreapprovalError('HUBTEL_PAYMENTS_MODE=live is not wired to a real Hubtel account in this build — use mock mode.');
  }

  return processDirectDebitCallback({ clientReference, status: 'SUCCESS', rawPayload: JSON.stringify({ mock: true }) });
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
    await processDirectDebitCallback({ clientReference, status: 'SUCCESS', rawPayload: JSON.stringify({ mock: true, retry: true }) });
    await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { nextRetryAt: null } }); // don't re-pick the original row up again
    retried += 1;
  }
  return retried;
}
