import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { generateTransactionRef, generateReceiptNumber } from '../utils/idGenerators';
import { TERMINAL_CONTRACT_STATUSES, PRE_APPROVAL_STATUSES, defaultCutoffDate } from '../constants/contracts';
import { recordAgentDepositIfApplicable } from './agentLedgerService';
import { applyStockMovement } from './inventoryService';
import { queueSms, deliverQueuedSms } from './smsService';

export class PaymentError extends Error {}

type Tx = Prisma.TransactionClient;
// Every read-only helper below (getEffectivePayments, getDeviceLoanState) can
// run either inside an open transaction or standalone against the plain
// client — only the write path (postDeviceLoanPayment et al.) requires a real Tx.
type Db = Tx | typeof prisma;

/**
 * Sums, per target (instalment or penalty), only the PaymentAllocation rows that
 * belong to "effective" payments — SUCCESS, not themselves a reversal, and not
 * reversed by a later payment. This is what makes totals recompute deterministically
 * from the ledger with zero drift (docs/00-legacy-study.md §4/§6): nothing is ever
 * incremented or mutated, everything is re-derived from source rows every time.
 */
async function getEffectivePayments(db: Db, contractId: string) {
  const reversalRows = await db.payment.findMany({
    where: { contractId, status: 'SUCCESS', reversesPaymentId: { not: null } },
    select: { reversesPaymentId: true },
  });
  const reversedIds = new Set(reversalRows.map((r) => r.reversesPaymentId as string));

  return db.payment.findMany({
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

  // A WITHDRAWAL row stores its magnitude as a positive amountMinor (same
  // convention as every other payment — sign is never stored raw, see the
  // reversal rows below), but subtracts from the running total instead of
  // adding to it. Reversing a withdrawal (the existing reversal mechanism,
  // unchanged) simply drops it from effectivePayments, restoring the amount —
  // no separate "undo a withdrawal" logic needed.
  const totalPaidMinor = effectivePayments.reduce(
    (sum, p) => sum + (p.entryType === 'WITHDRAWAL' ? -p.amountMinor : p.amountMinor),
    0,
  );

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

  // SAVE_TO_OWN has no savings target to measure a balance against — it's
  // open-ended, so balanceMinor stays null and totalPaidMinor (what's actually
  // been deposited, net of withdrawals) is the only figure that moves.
  const balanceMinor = contract.contractType === 'SAVE_TO_OWN' || contract.totalPayableMinor === null
    ? null
    : Math.max(0, contract.totalPayableMinor - totalPaidMinor);
  if (totalPaidMinor !== contract.totalPaidMinor || balanceMinor !== contract.balanceMinor) {
    await tx.contract.update({ where: { id: contractId }, data: { totalPaidMinor, balanceMinor } });
  }
}

export interface PendingDirectDebitInit {
  contractId: string; customerId: string; network: string; msisdn: string; createdById: string;
}
interface AdvanceContractStatusResult {
  queuedSmsIds: string[];
  pendingDirectDebit?: PendingDirectDebitInit;
}

/**
 * Domain-specific status transitions that follow a recompute. Kept separate
 * from recomputeContract (pure math) so the state machine per contract type
 * (docs/01-plan.md §5) lives in one obvious place.
 */
async function advanceContractStatus(tx: Tx, contractId: string): Promise<AdvanceContractStatusResult> {
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
      // Fallback only: contractService.ts now tries this at creation time
      // (while still PENDING_DEPOSIT — enableDirectDebit accepts that status
      // for DEPOSIT_INSTALMENT), so hubtelPreapprovalId is normally already
      // set by the time a contract reaches here. Only fire this if that
      // didn't happen (a failed/unreachable Hubtel call at creation, or a
      // contract that didn't request direct debit until later) — never
      // re-initiate a mandate that's already attached, which would fire a
      // second Hubtel prompt at the customer for one that's already PENDING
      // approval or already APPROVED.
      const pendingDirectDebit = (!contract.hubtelPreapprovalId && contract.pendingDirectDebitNetwork && contract.pendingDirectDebitMsisdn)
        ? {
            contractId, customerId: contract.customerId,
            network: contract.pendingDirectDebitNetwork, msisdn: contract.pendingDirectDebitMsisdn,
            createdById: contract.createdById,
          }
        : undefined;
      return { queuedSmsIds, pendingDirectDebit };
    }
    return { queuedSmsIds }; // don't also fall through to completion check below in the same pass
  }

  // A DEFAULTED contract (see overdueService.markDefaultedContracts) is cured the
  // moment its arrears are cleared by a payment — recomputeContract above already
  // re-derived every instalment's status from the ledger, so "no OVERDUE rows left"
  // is the authoritative signal, not a separate balance check.
  // A DEVICE_LOAN defaulted on unpaid interest instead (no instalments) is
  // cured the same way, once no interest older than the threshold is unpaid.
  let effectiveStatus = contract.status;
  if (effectiveStatus === 'DEFAULTED') {
    const stillOverdue = await tx.instalment.count({ where: { contractId, status: 'OVERDUE' } });
    const staleInterest = contract.contractType === 'DEVICE_LOAN'
      ? await tx.penalty.count({
          where: { contractId, reason: 'DAILY_LOAN_INTEREST', isPaid: false, appliedDate: { lt: defaultCutoffDate(now) } },
        })
      : 0;
    if (stillOverdue === 0 && staleInterest === 0) {
      await tx.contract.update({ where: { id: contractId }, data: { status: 'ACTIVE' } });
      effectiveStatus = 'ACTIVE'; // may complete outright below, in the same payment that cured it
    }
  }

  if (effectiveStatus === 'ACTIVE' && contract.contractType === 'DEVICE_LOAN') {
    // DEVICE_LOAN completes only once BOTH the principal and every day of
    // accrued interest are cleared to zero — paying "the full loan amount"
    // alone (LOAN_PRINCIPAL_PAYMENT) only settles the principal; any interest
    // already accrued by that point is a separate balance still owed (see
    // loanService.accrueDailyLoanInterest and getDeviceLoanState).
    const effectivePayments = await getEffectivePayments(tx, contractId);
    const principalPaidMinor = effectivePayments
      .filter((p) => p.entryType === 'LOAN_PRINCIPAL_PAYMENT')
      .reduce((s, p) => s + p.amountMinor, 0);
    const unpaidInterestCount = await tx.penalty.count({ where: { contractId, reason: 'DAILY_LOAN_INTEREST', isPaid: false } });
    if (principalPaidMinor >= (contract.principalMinor ?? 0) && unpaidInterestCount === 0) {
      await tx.contract.update({ where: { id: contractId }, data: { status: 'COMPLETED', completedAt: now } });
    }
    return { queuedSmsIds };
  }

  // SAVE_TO_OWN never auto-completes — there's no savings target to reach
  // (balanceMinor is always null for it, see recomputeContract), so it just
  // stays ACTIVE until the customer withdraws or the balance is put toward a
  // purchase, both handled entirely outside this status machine.
  if (effectiveStatus === 'ACTIVE' && contract.contractType !== 'SAVE_TO_OWN' && contract.balanceMinor !== null && contract.balanceMinor <= 0) {
    await tx.contract.update({ where: { id: contractId }, data: { status: 'COMPLETED', completedAt: now } });
  }
  return { queuedSmsIds };
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
    // Awaiting or sent back for approval — the Agent module (schema.prisma's
    // Contract comment): nothing has been agreed yet, so no money can move.
    if (PRE_APPROVAL_STATUSES.includes(contract.status)) {
      throw new PaymentError(`Cannot post a payment to a contract awaiting approval (status ${contract.status})`);
    }
    if (contract.contractType === 'DEVICE_LOAN') {
      throw new PaymentError('DEVICE_LOAN payments must be posted via postDeviceLoanPayment — pay interest or the full loan amount, not a free-form amount');
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

    // The Agent module (schema.prisma's Contract comment): a deposit
    // collected in cash by an AGENT is money in THEIR hand, not the till's —
    // recordAgentDepositIfApplicable is itself a no-op for every other
    // channel/creator, where there is no such custody question at all.
    if (params.entryType === 'DEPOSIT' && params.channel === 'CASH') {
      await recordAgentDepositIfApplicable(tx, {
        contractId: contract.id, agentId: contract.createdById, depositAmountMinor: payment.amountMinor,
      });
    }

    await recomputeContract(tx, contract.id);
    const { queuedSmsIds: statusSmsIds, pendingDirectDebit } = await advanceContractStatus(tx, contract.id);

    const paymentSms = await queueSms({ contractId: contract.id, templateKey: 'payment.success', paymentId: payment.id, tx });
    const queuedSmsIds = paymentSms ? [...statusSmsIds, paymentSms.id] : statusSmsIds;

    return { payment, idempotentReplay: false as const, queuedSmsIds, pendingDirectDebit };
  });

  // Deliver every SMS queued during this payment only after the transaction has
  // committed — an SMS provider failure must never roll back a posted payment.
  for (const smsId of result.queuedSmsIds) {
    void deliverQueuedSms(smsId).catch((e) => console.error('SMS delivery failed (non-blocking):', e));
  }

  // Awaited (not fire-and-forget) — same reasoning as contractService's equivalent
  // hook: this sets real contract state (hubtelPreapprovalId) a caller checking the
  // contract right after this payment would expect to already be settled, and mock
  // mode resolves instantly. Still fully error-contained: never throws out of here,
  // so a Hubtel failure can't undo the payment that was just posted. The deposit that
  // just cleared may have activated a contract that had a direct-debit mandate
  // requested at creation (mandates require ACTIVE, which this contract wasn't until
  // this payment). Dynamic import avoids a circular static import —
  // hubtelPreapprovalService.ts reaches postPayment in this file through
  // hubtelPaymentService.ts.
  if (result.pendingDirectDebit) {
    try {
      const { initiatePreapproval, enableDirectDebit } = await import('./hubtelPreapprovalService');
      const { contractId, customerId, network, msisdn, createdById } = result.pendingDirectDebit;
      const { preapproval } = await initiatePreapproval({ customerId, msisdn, network, createdById });
      await enableDirectDebit({ contractId, preapprovalId: preapproval.id, userId: createdById });
    } catch (e) {
      console.error('Auto direct-debit initiation failed (non-blocking):', e);
    }
  }

  return result;
}

export interface PostWithdrawalParams {
  contractId: string;
  amountMinor: number;
  notes?: string;
  createdById: string;
}

/**
 * SAVE_TO_OWN's counterpart to postPayment: the customer can pull part of
 * their savings back out (a real need — an emergency, a change of mind on
 * how much to save) rather than the money being locked in until the full
 * target is reached. Deliberately its own function rather than a branch of
 * postPayment: it only ever makes sense for SAVE_TO_OWN, never allocates
 * against an instalment/penalty (SAVE_TO_OWN has none), and is capped by
 * what's actually been saved rather than validated against amountMinor alone.
 *
 * Stored as a normal SUCCESS payment row (entryType WITHDRAWAL, amountMinor
 * always a positive magnitude — same "never store a raw negative" convention
 * every other payment follows) so it rides the existing ledger unchanged:
 * recomputeContract subtracts it, reversePayment (existing, untouched) undoes
 * it by simply excluding it again, and it appears in the Payments list and
 * every cash report like any other entry — nothing needed a parallel table.
 */
export async function postWithdrawal(params: PostWithdrawalParams) {
  if (params.amountMinor <= 0) throw new PaymentError('amountMinor must be positive');

  const transactionRef = generateTransactionRef();

  return prisma.$transaction(async (tx) => {
    const contract = await tx.contract.findUniqueOrThrow({ where: { id: params.contractId } });

    if (contract.contractType !== 'SAVE_TO_OWN') {
      throw new PaymentError('Withdrawals are only available on Save to Own contracts');
    }
    if (TERMINAL_CONTRACT_STATUSES.includes(contract.status) || PRE_APPROVAL_STATUSES.includes(contract.status)) {
      throw new PaymentError(`Cannot withdraw from a contract in status ${contract.status}`);
    }
    if (params.amountMinor > contract.totalPaidMinor) {
      throw new PaymentError('Cannot withdraw more than the customer has saved so far');
    }

    const payment = await tx.payment.create({
      data: {
        contractId: contract.id,
        entryType: 'WITHDRAWAL',
        amountMinor: params.amountMinor,
        channel: 'CASH',
        transactionRef,
        status: 'SUCCESS',
        receiptNumber: generateReceiptNumber(),
        notes: params.notes,
        createdById: params.createdById,
        receivedAt: new Date(),
      },
    });

    await recomputeContract(tx, contract.id);
    return payment;
  });
}

export interface DeviceLoanState {
  principalMinor: number;
  // Once the customer has paid a LOAN_PRINCIPAL_PAYMENT covering the full
  // principalMinor, this flips false and daily interest stops accruing
  // (loanService.accrueDailyLoanInterest) — but any interest already accrued
  // by that point is a separate balance, not forgiven (see advanceContractStatus).
  principalOutstanding: boolean;
  // Sum of every still-unpaid DAILY_LOAN_INTEREST Penalty row — what "pay
  // interest" currently costs, exactly.
  accruedInterestMinor: number;
  // Total ever paid via LOAN_INTEREST_PAYMENT (effective, reversal-aware) —
  // history, not what's currently owed. Used by reportService.loanBookReport.
  interestPaidMinor: number;
  totalOwedMinor: number;
}

/**
 * Derives a DEVICE_LOAN's current state purely from the ledger (payments +
 * penalties) — same "never trust a stored running total" rule recomputeContract
 * follows. Usable both inside an open transaction (postDeviceLoanPayment,
 * loanService's accrual sweep) and standalone (the contract detail API, the
 * USSD prompt) via the optional `db` param.
 */
export async function getDeviceLoanState(contractId: string, db: Db = prisma): Promise<DeviceLoanState> {
  const contract = await db.contract.findUniqueOrThrow({ where: { id: contractId } });
  const principalMinor = contract.principalMinor ?? 0;

  const effectivePayments = await getEffectivePayments(db, contractId);
  const principalPaidMinor = effectivePayments
    .filter((p) => p.entryType === 'LOAN_PRINCIPAL_PAYMENT')
    .reduce((s, p) => s + p.amountMinor, 0);
  const principalOutstanding = principalPaidMinor < principalMinor;
  const interestPaidMinor = effectivePayments
    .filter((p) => p.entryType === 'LOAN_INTEREST_PAYMENT')
    .reduce((s, p) => s + p.amountMinor, 0);

  const unpaidInterest = await db.penalty.findMany({ where: { contractId, reason: 'DAILY_LOAN_INTEREST', isPaid: false } });
  const accruedInterestMinor = unpaidInterest.reduce((s, p) => s + p.amountMinor, 0);

  return {
    principalMinor,
    principalOutstanding,
    accruedInterestMinor,
    interestPaidMinor,
    totalOwedMinor: (principalOutstanding ? principalMinor : 0) + accruedInterestMinor,
  };
}

export interface PostDeviceLoanPaymentParams {
  contractId: string;
  // Exactly two choices — no free-form amount (docs: prevent under/over payment).
  // 'INTEREST' clears every currently-unpaid day of accrued interest in one go.
  // 'PRINCIPAL' clears the original loan amount only — interest already
  // accrued by that point is unaffected, still owed separately.
  option: 'INTEREST' | 'PRINCIPAL';
  amountMinor: number;
  channel: 'CASH' | 'USSD';
  transactionRef?: string;
  rawGatewayPayload?: string;
  createdById?: string;
  initiatedByCustomerId?: string;
  // Gateway callbacks only. The customer confirmed an interest amount on
  // their phone, and more interest may have accrued before Hubtel's callback
  // arrived. When set, an INTEREST amount smaller than what's owed now is
  // still accepted if it pays off exactly the oldest days of interest, which
  // are the ones the customer confirmed. The staff counter stays exact-match.
  acceptOldestInterestDays?: boolean;
}

/**
 * The oldest unpaid interest rows whose amounts add up to exactly
 * `amountMinor`, or null if no run of oldest rows lands on that figure.
 */
function oldestInterestRowsSummingTo<T extends { amountMinor: number }>(rowsOldestFirst: T[], amountMinor: number): T[] | null {
  let sum = 0;
  for (let i = 0; i < rowsOldestFirst.length; i++) {
    sum += rowsOldestFirst[i].amountMinor;
    if (sum === amountMinor) return rowsOldestFirst.slice(0, i + 1);
    if (sum > amountMinor) return null;
  }
  return null;
}

/**
 * DEVICE_LOAN's counterpart to postPayment — deliberately its own function
 * (postPayment refuses DEVICE_LOAN outright, see above) because the two
 * payment options are exact-match only, never a free amount: `amountMinor`
 * must equal exactly what's currently owed for the chosen option, checked
 * against getDeviceLoanState computed inside the same transaction the
 * payment is created in, so a concurrent accrual/payment can't race it.
 */
export async function postDeviceLoanPayment(params: PostDeviceLoanPaymentParams) {
  if (params.amountMinor <= 0) throw new PaymentError('amountMinor must be positive');

  const transactionRef = params.transactionRef ?? generateTransactionRef();
  const existing = await prisma.payment.findUnique({ where: { transactionRef } });
  if (existing) return { payment: existing, idempotentReplay: true as const };

  const result = await prisma.$transaction(async (tx) => {
    const contract = await tx.contract.findUniqueOrThrow({ where: { id: params.contractId } });
    if (contract.contractType !== 'DEVICE_LOAN') throw new PaymentError('Only DEVICE_LOAN contracts accept this payment');
    if (TERMINAL_CONTRACT_STATUSES.includes(contract.status) || PRE_APPROVAL_STATUSES.includes(contract.status)) {
      throw new PaymentError(`Cannot post a payment to a contract in status ${contract.status}`);
    }

    const state = await getDeviceLoanState(contract.id, tx);
    // The interest rows this payment settles, oldest first — every unpaid row
    // for an exact match, or only the oldest ones (see acceptOldestInterestDays).
    let interestRowsToPay: { id: string; amountMinor: number }[] = [];
    if (params.option === 'PRINCIPAL') {
      if (!state.principalOutstanding) throw new PaymentError('The loan amount has already been paid');
      if (params.amountMinor !== state.principalMinor) {
        throw new PaymentError(`Amount must be exactly the full loan amount (${state.principalMinor}) to pay it off`);
      }
    } else {
      if (state.accruedInterestMinor <= 0) throw new PaymentError('No interest is currently owed');
      const unpaid = await tx.penalty.findMany({
        where: { contractId: contract.id, reason: 'DAILY_LOAN_INTEREST', isPaid: false },
        orderBy: { appliedDate: 'asc' },
      });
      if (params.amountMinor === state.accruedInterestMinor) {
        interestRowsToPay = unpaid;
      } else {
        const oldest = params.acceptOldestInterestDays ? oldestInterestRowsSummingTo(unpaid, params.amountMinor) : null;
        if (!oldest) {
          throw new PaymentError(`Amount must be exactly the accrued interest owed (${state.accruedInterestMinor})`);
        }
        interestRowsToPay = oldest;
      }
    }

    const payment = await tx.payment.create({
      data: {
        contractId: contract.id,
        entryType: params.option === 'PRINCIPAL' ? 'LOAN_PRINCIPAL_PAYMENT' : 'LOAN_INTEREST_PAYMENT',
        amountMinor: params.amountMinor,
        channel: params.channel,
        transactionRef,
        status: 'SUCCESS',
        receiptNumber: params.channel === 'CASH' ? generateReceiptNumber() : undefined,
        rawGatewayPayload: params.rawGatewayPayload,
        createdById: params.createdById,
        initiatedByCustomerId: params.initiatedByCustomerId,
        receivedAt: new Date(),
      },
    });

    // Allocate against the interest rows chosen above — recomputeContract below
    // reads these allocations back to flip each Penalty's isPaid, the exact
    // same mechanism applyLatePenalties's own rows already use.
    for (const penalty of interestRowsToPay) {
      await tx.paymentAllocation.create({
        data: { paymentId: payment.id, targetType: 'PENALTY', penaltyId: penalty.id, amountMinor: penalty.amountMinor },
      });
    }

    await recomputeContract(tx, contract.id);
    const { queuedSmsIds } = await advanceContractStatus(tx, contract.id);
    const paymentSms = await queueSms({ contractId: contract.id, templateKey: 'payment.success', paymentId: payment.id, tx });
    const allSmsIds = paymentSms ? [...queuedSmsIds, paymentSms.id] : queuedSmsIds;

    return { payment, idempotentReplay: false as const, queuedSmsIds: allSmsIds };
  });

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
