import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { generateTransactionRef, generateReceiptNumber } from '../utils/idGenerators';
import { TERMINAL_CONTRACT_STATUSES } from '../constants/contracts';
import { applyStockMovement } from './inventoryService';
import { queueSms, deliverQueuedSms } from './smsService';

export class PaymentError extends Error {}

type Tx = Prisma.TransactionClient;

/**
 * Sums, per target (instalment or penalty), only the PaymentAllocation rows that
 * belong to "effective" payments — SUCCESS, not themselves a reversal, and not
 * reversed by a later payment. This is what makes totals recompute deterministically
 * from the ledger with zero drift (docs/00-legacy-study.md §4/§6): nothing is ever
 * incremented or mutated, everything is re-derived from source rows every time.
 */
async function getEffectivePayments(tx: Tx, contractId: string) {
  const reversalRows = await tx.payment.findMany({
    where: { contractId, status: 'SUCCESS', reversesPaymentId: { not: null } },
    select: { reversesPaymentId: true },
  });
  const reversedIds = new Set(reversalRows.map((r) => r.reversesPaymentId as string));

  return tx.payment.findMany({
    where: { contractId, status: 'SUCCESS', reversesPaymentId: null },
    include: { allocations: true },
  }).then((payments) => payments.filter((p) => !reversedIds.has(p.id)));
}

/**
 * Recomputes contract totals and every instalment/penalty's paid state purely
 * from the payments ledger. Called after every posted payment and every
 * reversal — never trust incrementally-updated running totals.
 */
async function recomputeContract(tx: Tx, contractId: string) {
  const contract = await tx.contract.findUniqueOrThrow({ where: { id: contractId } });
  const effectivePayments = await getEffectivePayments(tx, contractId);

  const totalPaidMinor = effectivePayments.reduce((sum, p) => sum + p.amountMinor, 0);

  const paidByInstalment = new Map<string, number>();
  const paidPenaltyIds = new Set<string>();
  for (const p of effectivePayments) {
    for (const a of p.allocations) {
      if (a.targetType === 'INSTALMENT' && a.instalmentId) {
        paidByInstalment.set(a.instalmentId, (paidByInstalment.get(a.instalmentId) ?? 0) + a.amountMinor);
      } else if (a.targetType === 'PENALTY' && a.penaltyId) {
        paidPenaltyIds.add(a.penaltyId);
      }
    }
  }

  const now = new Date();
  const instalments = await tx.instalment.findMany({ where: { contractId }, orderBy: { instalmentNo: 'asc' } });
  for (const inst of instalments) {
    const paid = paidByInstalment.get(inst.id) ?? 0;
    const status = paid >= inst.amountDueMinor ? 'PAID' : inst.dueDate < now ? 'OVERDUE' : paid > 0 ? 'PARTIAL' : 'PENDING';
    if (paid !== inst.amountPaidMinor || status !== inst.status) {
      await tx.instalment.update({
        where: { id: inst.id },
        data: { amountPaidMinor: paid, status, paidAt: status === 'PAID' ? (inst.paidAt ?? now) : null },
      });
    }
  }

  const penalties = await tx.penalty.findMany({ where: { contractId, isPaid: false } });
  for (const penalty of penalties) {
    if (paidPenaltyIds.has(penalty.id)) {
      await tx.penalty.update({ where: { id: penalty.id }, data: { isPaid: true, paidAt: now } });
    }
  }

  const balanceMinor = Math.max(0, contract.totalPayableMinor - totalPaidMinor);
  if (totalPaidMinor !== contract.totalPaidMinor || balanceMinor !== contract.balanceMinor) {
    await tx.contract.update({ where: { id: contractId }, data: { totalPaidMinor, balanceMinor } });
  }
}

/**
 * Domain-specific status transitions that follow a recompute. Kept separate
 * from recomputeContract (pure math) so the state machine per contract type
 * (docs/01-plan.md §5) lives in one obvious place.
 */
async function advanceContractStatus(tx: Tx, contractId: string): Promise<string[]> {
  const contract = await tx.contract.findUniqueOrThrow({ where: { id: contractId } });
  const now = new Date();
  const queuedSmsIds: string[] = [];

  if (contract.contractType === 'DEPOSIT_INSTALMENT' && contract.status === 'PENDING_DEPOSIT') {
    if (contract.totalPaidMinor >= contract.depositAmountMinor) {
      await tx.contract.update({ where: { id: contractId }, data: { status: 'ACTIVE', activatedAt: now } });
      if (contract.inventoryItemId) {
        await applyStockMovement({
          inventoryItemId: contract.inventoryItemId,
          type: 'ISSUE',
          referenceType: 'CONTRACT',
          referenceId: contract.id,
          reason: 'Deposit confirmed — device issued to customer',
          createdById: contract.createdById,
          tx,
        });
      }
      const sms = await queueSms({ contractId, templateKey: 'contract.activated', tx });
      if (sms) queuedSmsIds.push(sms.id);
    }
    return queuedSmsIds; // don't also fall through to completion check below in the same pass
  }

  // A DEFAULTED contract (see overdueService.markDefaultedContracts) is cured the
  // moment its arrears are cleared by a payment — recomputeContract above already
  // re-derived every instalment's status from the ledger, so "no OVERDUE rows left"
  // is the authoritative signal, not a separate balance check.
  let effectiveStatus = contract.status;
  if (effectiveStatus === 'DEFAULTED') {
    const stillOverdue = await tx.instalment.count({ where: { contractId, status: 'OVERDUE' } });
    if (stillOverdue === 0) {
      await tx.contract.update({ where: { id: contractId }, data: { status: 'ACTIVE' } });
      effectiveStatus = 'ACTIVE'; // may complete outright below, in the same payment that cured it
    }
  }

  if (effectiveStatus === 'ACTIVE' && contract.balanceMinor <= 0) {
    await tx.contract.update({ where: { id: contractId }, data: { status: 'COMPLETED', completedAt: now } });
  }
  return queuedSmsIds;
}

export interface PostPaymentParams {
  contractId: string;
  amountMinor: number;
  entryType: 'DEPOSIT' | 'INSTALMENT_PAYMENT';
  channel: 'CASH' | 'USSD' | 'DIRECT_DEBIT';
  mobileMoneyNetwork?: string;
  transactionRef?: string;
  externalRef?: string;
  notes?: string;
  rawGatewayPayload?: string;
  createdById?: string;
  initiatedByCustomerId?: string;
  receivedAt?: Date;
}

async function allocatePayment(tx: Tx, paymentId: string, contractId: string, amountMinor: number) {
  let remaining = amountMinor;

  const penalties = await tx.penalty.findMany({ where: { contractId, isPaid: false }, orderBy: { appliedDate: 'asc' } });
  for (const penalty of penalties) {
    if (remaining <= 0) break;
    if (remaining < penalty.amountMinor) continue; // penalties are all-or-nothing; leave for a later payment
    await tx.paymentAllocation.create({
      data: { paymentId, targetType: 'PENALTY', penaltyId: penalty.id, amountMinor: penalty.amountMinor },
    });
    remaining -= penalty.amountMinor;
  }

  const instalments = await tx.instalment.findMany({ where: { contractId }, orderBy: { instalmentNo: 'asc' } });
  for (const inst of instalments) {
    if (remaining <= 0) break;
    const outstanding = inst.amountDueMinor - inst.amountPaidMinor;
    if (outstanding <= 0) continue;
    const toApply = Math.min(remaining, outstanding);
    await tx.paymentAllocation.create({
      data: { paymentId, targetType: 'INSTALMENT', instalmentId: inst.id, amountMinor: toApply },
    });
    remaining -= toApply;
  }
  // Anything still `remaining` here is deliberately left unallocated: it's overpayment/credit.
  // It still counts toward totalPaidMinor (the raw payment amount is never split), and is
  // surfaced as creditMinor = max(0, totalPaidMinor - totalPayableMinor) wherever needed —
  // never stored, always derived, so it can't drift from the ledger.
}

/**
 * The one and only place a payment gets posted, for both channels (cash and
 * USSD) — mission requirement. Idempotent on transactionRef: replaying the
 * same reference (e.g. a duplicated gateway callback) returns the existing
 * row untouched rather than posting twice.
 */
export async function postPayment(params: PostPaymentParams) {
  if (params.amountMinor <= 0) throw new PaymentError('amountMinor must be positive');

  const transactionRef = params.transactionRef ?? generateTransactionRef();

  const existing = await prisma.payment.findUnique({ where: { transactionRef } });
  if (existing) return { payment: existing, idempotentReplay: true as const };

  const result = await prisma.$transaction(async (tx) => {
    const contract = await tx.contract.findUniqueOrThrow({ where: { id: params.contractId } });

    if (TERMINAL_CONTRACT_STATUSES.includes(contract.status)) {
      throw new PaymentError(`Cannot post a payment to a contract in status ${contract.status}`);
    }
    if (params.entryType === 'DEPOSIT' && contract.contractType !== 'DEPOSIT_INSTALMENT') {
      throw new PaymentError('Only DEPOSIT_INSTALMENT contracts accept a DEPOSIT payment');
    }
    // Once the deposit gate has cleared (contract left PENDING_DEPOSIT), further
    // money is instalment money — posting it as DEPOSIT again would inflate
    // totalPaidMinor/balanceMinor without allocating to any instalment (allocatePayment
    // only runs for INSTALMENT_PAYMENT), silently decoupling the balance from the schedule.
    if (params.entryType === 'DEPOSIT' && contract.status !== 'PENDING_DEPOSIT') {
      throw new PaymentError('Deposit has already been satisfied — post further payments as INSTALMENT_PAYMENT');
    }

    const payment = await tx.payment.create({
      data: {
        contractId: contract.id,
        entryType: params.entryType,
        amountMinor: params.amountMinor,
        channel: params.channel,
        mobileMoneyNetwork: params.mobileMoneyNetwork,
        transactionRef,
        externalRef: params.externalRef,
        status: 'SUCCESS',
        receiptNumber: params.channel === 'CASH' ? generateReceiptNumber() : undefined,
        notes: params.notes,
        rawGatewayPayload: params.rawGatewayPayload,
        createdById: params.createdById,
        initiatedByCustomerId: params.initiatedByCustomerId,
        receivedAt: params.receivedAt ?? new Date(),
      },
    });

    // SAVE_TO_OWN has no instalment schedule to allocate against (free-form savings —
    // any amount, any time, toward totalPayableMinor) — totalPaidMinor/balanceMinor
    // below are computed straight from the payments ledger regardless, so skipping
    // allocation here doesn't affect correctness, just avoids a pointless no-op query.
    if (params.entryType === 'INSTALMENT_PAYMENT' && contract.contractType !== 'SAVE_TO_OWN') {
      await allocatePayment(tx, payment.id, contract.id, payment.amountMinor);
    }

    await recomputeContract(tx, contract.id);
    const statusSmsIds = await advanceContractStatus(tx, contract.id);

    const paymentSms = await queueSms({ contractId: contract.id, templateKey: 'payment.success', paymentId: payment.id, tx });
    const queuedSmsIds = paymentSms ? [...statusSmsIds, paymentSms.id] : statusSmsIds;

    return { payment, idempotentReplay: false as const, queuedSmsIds };
  });

  // Deliver every SMS queued during this payment only after the transaction has
  // committed — an SMS provider failure must never roll back a posted payment.
  for (const smsId of result.queuedSmsIds) {
    void deliverQueuedSms(smsId).catch((e) => console.error('SMS delivery failed (non-blocking):', e));
  }

  return result;
}

/**
 * A reversal is a full, new SUCCESS payment row that points back at the
 * original via reversesPaymentId — the original is never mutated or deleted
 * (mission rule: nothing financial is hard-deleted). recomputeContract then
 * naturally excludes the reversed payment's contribution and effect on
 * instalments/penalties, since getEffectivePayments filters it out.
 *
 * Split into a tx-scoped core (reusable from inside another already-open
 * transaction — see reverseAllPaymentsForContract) and the public single-payment
 * entrypoint below, which opens its own transaction.
 */
async function reversePaymentInTx(tx: Tx, params: { paymentId: string; reason: string; reversedById: string }) {
  const original = await tx.payment.findUniqueOrThrow({ where: { id: params.paymentId } });
  if (original.status !== 'SUCCESS') throw new PaymentError('Only a SUCCESS payment can be reversed');
  if (original.reversesPaymentId) throw new PaymentError('Cannot reverse a reversal');

  const alreadyReversed = await tx.payment.findUnique({ where: { reversesPaymentId: original.id } });
  if (alreadyReversed) throw new PaymentError('This payment has already been reversed');

  const reversal = await tx.payment.create({
    data: {
      contractId: original.contractId,
      entryType: original.entryType,
      amountMinor: original.amountMinor,
      channel: original.channel,
      transactionRef: generateTransactionRef(),
      status: 'SUCCESS',
      reversesPaymentId: original.id,
      reversalReason: params.reason,
      createdById: params.reversedById,
      receivedAt: new Date(),
    },
  });

  await tx.payment.update({
    where: { id: original.id },
    data: { reversedById: params.reversedById, reversalReason: params.reason },
  });

  return reversal;
}

export async function reversePayment(params: { paymentId: string; reason: string; reversedById: string }) {
  return prisma.$transaction(async (tx) => {
    const reversal = await reversePaymentInTx(tx, params);
    await recomputeContract(tx, reversal.contractId);
    return reversal;
  });
}

/**
 * Reverses every effective (non-reversed) payment on a contract in one pass —
 * used when a customer withdraws from a contract the device was never handed
 * over on (see contractService.cancelContract): the deal fell through before
 * any product changed hands, so the whole ledger unwinds, not just a number
 * reported for staff to act on outside the system. Each payment still gets
 * its own reversal row with the same reason/user (mission rule: reversed, not
 * deleted, one row per original) — this just does that for all of them as
 * part of the same cancellation transaction.
 */
export async function reverseAllPaymentsForContract(tx: Tx, params: { contractId: string; reason: string; reversedById: string }) {
  const effectivePayments = await getEffectivePayments(tx, params.contractId);
  for (const payment of effectivePayments) {
    await reversePaymentInTx(tx, { paymentId: payment.id, reason: params.reason, reversedById: params.reversedById });
  }
  await recomputeContract(tx, params.contractId);
}
