import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { generateContractNumber } from '../utils/idGenerators';
import { applyStockMovement } from './inventoryService';
import { generateStraightLineSchedule } from './scheduleService';
import { queueSms, deliverQueuedSms } from './smsService';
import { reverseAllPaymentsForContract } from './paymentService';
import { initiatePreapproval, enableDirectDebit } from './hubtelPreapprovalService';
import { getLoanSettings } from './loanSettingsService';
import {
  CONTRACT_STATUSES_BY_TYPE, DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES,
  DEPOSIT_INSTALMENT_FREQUENCIES, DEPOSIT_INSTALMENT_MIN_TERM_WEEKS, DEPOSIT_INSTALMENT_MAX_TERM_WEEKS,
  type ContractTypeName, type PaymentFrequencyName, type PaymentMethodName,
} from '../constants/contracts';

export class ContractError extends Error {}

export interface CreateContractParams {
  contractType: ContractTypeName;
  customerId: string;
  branchId: string;
  createdById: string;
  startDate?: Date;
  // DIRECT_DEBIT/BOTH require directDebitNetwork+directDebitMsisdn (validated below);
  // CUSTOMER_INITIATED (the default) needs neither. Only DEPOSIT_INSTALMENT is
  // eligible at all now — see DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES.
  paymentMethod?: PaymentMethodName;
  directDebitNetwork?: string;
  directDebitMsisdn?: string;

  // DEPOSIT_INSTALMENT only — a specific serialized unit is reserved from this
  // branch's stock, and every deal term is entered directly here, never looked
  // up from a price chart (no contract type reads PriceChartEntry anymore).
  inventoryItemId?: string;
  totalPayableMinor?: number;
  depositAmountMinor?: number;
  // The instalment period, in weeks (1-24) — WEEKLY frequency collects one
  // instalment per week (instalment count == termWeeks); DAILY collects one
  // per day across that same span (instalment count == termWeeks * 7).
  termWeeks?: number;
  paymentFrequency?: PaymentFrequencyName; // DAILY | WEEKLY only for this type
  gracePeriodDays?: number;
  penaltyRateBps?: number;

  // DEVICE_LOAN only — not linked to a product at all. The loan amount is
  // entered directly; the daily interest rate and the grace period before
  // interest starts accruing come from LoanSettings, snapshotted onto the
  // contract at creation (see runDeviceLoanTransaction).
  loanAmountMinor?: number;
}

/**
 * Awaited (not fire-and-forget like SMS): unlike an SMS send, this sets real
 * contract state (hubtelPreapprovalId) that the caller reasonably expects the
 * just-created/just-activated contract to already reflect, and mock mode
 * resolves instantly anyway — there's no real network latency to shield
 * against yet. Still fully error-contained: a failure here must never undo a
 * contract creation or a posted payment. Returns the updated contract row
 * when initiation actually ran, so the caller can return the current state
 * instead of a stale pre-initiation snapshot.
 */
async function initiateDirectDebitIfRequested(params: {
  contractId: string; customerId: string; network: string | null; msisdn: string | null; createdById: string;
}) {
  if (!params.network || !params.msisdn) return null;
  try {
    const { preapproval } = await initiatePreapproval({
      customerId: params.customerId, msisdn: params.msisdn, network: params.network, createdById: params.createdById,
    });
    return await enableDirectDebit({ contractId: params.contractId, preapprovalId: preapproval.id, userId: params.createdById });
  } catch (e) {
    console.error('Auto direct-debit initiation failed (non-blocking):', e);
    return null;
  }
}

export async function createContract(params: CreateContractParams) {
  const customer = await prisma.customer.findUnique({ where: { id: params.customerId } });
  if (!customer) throw new ContractError('Customer not found');
  if (customer.branchId !== params.branchId) throw new ContractError('Customer does not belong to this branch');

  // If direct-debit details are given without an explicit paymentMethod, infer
  // DIRECT_DEBIT rather than defaulting to CUSTOMER_INITIATED — a caller that
  // provided a network+number very obviously wants the mandate to actually be
  // used to collect, not silently ignored by runDirectDebitCollections.
  const paymentMethod: PaymentMethodName =
    params.paymentMethod ?? (params.directDebitNetwork && params.directDebitMsisdn ? 'DIRECT_DEBIT' : 'CUSTOMER_INITIATED');
  if (paymentMethod !== 'CUSTOMER_INITIATED') {
    if (!DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES.includes(params.contractType)) {
      throw new ContractError(`${params.contractType} contracts have no due schedule to auto-charge — direct debit isn't available for them`);
    }
    if (!params.directDebitNetwork || !params.directDebitMsisdn) {
      throw new ContractError('directDebitNetwork and directDebitMsisdn are required for DIRECT_DEBIT/BOTH');
    }
  }

  const startDate = params.startDate ?? new Date();

  // generateContractNumber's own internal retry only protects against a number
  // that a PRIOR request already committed — two truly concurrent requests can
  // both read the same "next" candidate before either commits. That collision
  // only surfaces as a unique-constraint violation at insert time, so retry
  // just the number-generation + transaction step with a fresh number —
  // never for any other error (e.g. the inventory item losing its race to
  // another contract, which must fail cleanly, not retry into a different item).
  const MAX_ATTEMPTS = 3;
  const isContractNumberCollision = (e: unknown) =>
    e instanceof Prisma.PrismaClientKnownRequestError &&
    e.code === 'P2002' &&
    Array.isArray(e.meta?.target) &&
    (e.meta.target as string[]).includes('contractNumber');

  if (params.contractType === 'SAVE_TO_OWN') {
    // Open-ended savings — no product, no price chart entry, no term. The
    // customer deposits any amount, any time, until they withdraw or the
    // saved balance goes toward a purchase (handled entirely outside contract
    // creation — see postWithdrawal in paymentService.ts).
    if (params.inventoryItemId) {
      throw new ContractError('SAVE_TO_OWN accounts are not linked to a product');
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await runSaveToOwnTransaction(params, startDate);
      } catch (e) {
        if (isContractNumberCollision(e) && attempt < MAX_ATTEMPTS) continue;
        throw e;
      }
    }
    throw new ContractError('Could not create contract after multiple attempts, please retry');
  }

  if (params.contractType === 'DEVICE_LOAN') {
    // Also not linked to a product — a daily-simple-interest loan, the amount
    // entered directly. See runDeviceLoanTransaction/loanService.ts.
    if (params.inventoryItemId) {
      throw new ContractError('DEVICE_LOAN accounts are not linked to a product');
    }
    if (params.loanAmountMinor === undefined || !Number.isInteger(params.loanAmountMinor) || params.loanAmountMinor <= 0) {
      throw new ContractError('loanAmountMinor must be a positive integer');
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await runDeviceLoanTransaction(params, startDate);
      } catch (e) {
        if (isContractNumberCollision(e) && attempt < MAX_ATTEMPTS) continue;
        throw e;
      }
    }
    throw new ContractError('Could not create contract after multiple attempts, please retry');
  }

  // DEPOSIT_INSTALMENT — the one type still linked to a specific reserved unit.
  if (!params.inventoryItemId) throw new ContractError('inventoryItemId is required for this contract type');
  const item = await prisma.inventoryItem.findUnique({ where: { id: params.inventoryItemId } });
  if (!item) throw new ContractError('Inventory item not found');
  if (item.status !== 'AVAILABLE') throw new ContractError(`Inventory item is not available (status: ${item.status})`);
  if (item.branchId !== params.branchId) throw new ContractError('Inventory item does not belong to this branch');

  if (params.totalPayableMinor === undefined || !Number.isInteger(params.totalPayableMinor) || params.totalPayableMinor <= 0) {
    throw new ContractError('totalPayableMinor must be a positive integer');
  }
  if (params.depositAmountMinor === undefined || !Number.isInteger(params.depositAmountMinor) || params.depositAmountMinor < 0) {
    throw new ContractError('depositAmountMinor must be a non-negative integer');
  }
  if (params.depositAmountMinor >= params.totalPayableMinor) {
    throw new ContractError('depositAmountMinor must be less than totalPayableMinor — there has to be something left to finance');
  }
  if (
    params.termWeeks === undefined || !Number.isInteger(params.termWeeks) ||
    params.termWeeks < DEPOSIT_INSTALMENT_MIN_TERM_WEEKS || params.termWeeks > DEPOSIT_INSTALMENT_MAX_TERM_WEEKS
  ) {
    throw new ContractError(`termWeeks must be an integer between ${DEPOSIT_INSTALMENT_MIN_TERM_WEEKS} and ${DEPOSIT_INSTALMENT_MAX_TERM_WEEKS}`);
  }
  const frequency = params.paymentFrequency ?? 'WEEKLY';
  if (!(DEPOSIT_INSTALMENT_FREQUENCIES as readonly string[]).includes(frequency)) {
    throw new ContractError(`paymentFrequency must be one of: ${DEPOSIT_INSTALMENT_FREQUENCIES.join(', ')}`);
  }

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runDepositInstalmentTransaction(params, item, startDate, paymentMethod);
    } catch (e) {
      if (isContractNumberCollision(e) && attempt < MAX_ATTEMPTS) continue;
      throw e;
    }
  }
  throw new ContractError('Could not create contract after multiple attempts, please retry');
}

/**
 * SAVE_TO_OWN's own creation path: no product/inventory item, no price chart
 * entry, no term, no schedule, no stock movement. Just an ACTIVE savings
 * account the customer deposits into (postPayment) and can withdraw from
 * (postWithdrawal) — see paymentService.ts.
 */
async function runSaveToOwnTransaction(params: CreateContractParams, startDate: Date) {
  const contractNumber = await generateContractNumber();

  return prisma.$transaction(async (tx) => {
    const contract = await tx.contract.create({
      data: {
        contractNumber,
        contractType: 'SAVE_TO_OWN',
        customerId: params.customerId,
        branchId: params.branchId,
        paymentMethod: 'CUSTOMER_INITIATED', // never direct-debit eligible — no due schedule to auto-collect against
        status: 'ACTIVE',
        startDate,
        activatedAt: new Date(),
        createdById: params.createdById,
      },
    });

    const sms = await queueSms({ contractId: contract.id, templateKey: 'contract.activated', tx });
    return { contract, queuedSmsId: sms?.id ?? null };
  }).then(async ({ contract, queuedSmsId }) => {
    if (queuedSmsId) void deliverQueuedSms(queuedSmsId).catch((e) => console.error('SMS delivery failed (non-blocking):', e));
    return contract;
  });
}

/**
 * DEVICE_LOAN's own creation path: no product/inventory item, no schedule —
 * a daily-simple-interest loan (loanService.accrueDailyLoanInterest charges
 * 1%/weekday against principalMinor until it's paid off; see
 * paymentService.postDeviceLoanPayment for how it's repaid). interestRateBps
 * and gracePeriodDays are snapshotted from the current LoanSettings — later
 * changes to those global settings never reprice a loan already created.
 */
async function runDeviceLoanTransaction(params: CreateContractParams, startDate: Date) {
  const contractNumber = await generateContractNumber();
  const loanAmountMinor = params.loanAmountMinor as number;

  return prisma.$transaction(async (tx) => {
    const loanSettings = await getLoanSettings(tx);

    const contract = await tx.contract.create({
      data: {
        contractNumber,
        contractType: 'DEVICE_LOAN',
        customerId: params.customerId,
        branchId: params.branchId,
        principalMinor: loanAmountMinor,
        interestRateBps: loanSettings.dailyInterestRateBps,
        rateBasis: 'DAILY_SIMPLE',
        gracePeriodDays: loanSettings.interestGraceDays,
        paymentMethod: 'CUSTOMER_INITIATED', // never direct-debit eligible — no single "amount due" to auto-charge
        status: 'ACTIVE', // cash disbursed unconditionally, no down-payment gate (docs/01-plan.md §5)
        totalPaidMinor: 0,
        startDate,
        activatedAt: new Date(),
        createdById: params.createdById,
      },
    });

    const sms = await queueSms({ contractId: contract.id, templateKey: 'contract.activated', tx });
    return { contract, queuedSmsId: sms?.id ?? null };
  }).then(async ({ contract, queuedSmsId }) => {
    if (queuedSmsId) void deliverQueuedSms(queuedSmsId).catch((e) => console.error('SMS delivery failed (non-blocking):', e));
    return contract;
  });
}

/**
 * DEPOSIT_INSTALMENT's own creation path — the one type still linked to a
 * reserved stock unit, still on a fixed schedule with a real target
 * (totalPayableMinor/balanceMinor). Every deal term (total price, deposit,
 * term in weeks, frequency) is entered directly here now, never looked up
 * from a price chart.
 */
async function runDepositInstalmentTransaction(
  params: CreateContractParams,
  item: { id: string; productId: string },
  startDate: Date,
  paymentMethod: PaymentMethodName,
) {
  const contractNumber = await generateContractNumber();
  const totalPayableMinor = params.totalPayableMinor as number;
  const depositAmountMinor = params.depositAmountMinor as number;
  const termWeeks = params.termWeeks as number;
  const frequency = (params.paymentFrequency ?? 'WEEKLY') as PaymentFrequencyName;
  const financeAmountMinor = totalPayableMinor - depositAmountMinor;
  // WEEKLY collects one instalment per week (count == termWeeks); DAILY
  // collects one per day across that same span (count == termWeeks * 7).
  const instalmentCount = frequency === 'DAILY' ? termWeeks * 7 : termWeeks;
  const instalmentAmountMinor = Math.ceil(financeAmountMinor / instalmentCount);

  return prisma.$transaction(async (tx) => {
    const contract = await tx.contract.create({
      data: {
        contractNumber,
        contractType: 'DEPOSIT_INSTALMENT',
        customerId: params.customerId,
        productId: item.productId,
        inventoryItemId: item.id,
        branchId: params.branchId,
        totalPriceMinor: totalPayableMinor,
        depositAmountMinor,
        termWeeks,
        paymentFrequency: frequency,
        instalmentAmountMinor,
        gracePeriodDays: params.gracePeriodDays ?? 7,
        penaltyRateBps: params.penaltyRateBps ?? 0,
        pendingDirectDebitNetwork: params.directDebitNetwork ?? null,
        pendingDirectDebitMsisdn: params.directDebitMsisdn ?? null,
        paymentMethod,
        status: 'PENDING_DEPOSIT',
        totalPayableMinor,
        totalPaidMinor: 0,
        balanceMinor: totalPayableMinor,
        startDate,
        activatedAt: null,
        createdById: params.createdById,
      },
    });

    // termMonths passed here is irrelevant — instalmentCount is always
    // explicit for this weeks-based term (scheduleService.ts's guard is
    // relaxed accordingly whenever an explicit count is given).
    const schedule = generateStraightLineSchedule(financeAmountMinor, 1, startDate, frequency, instalmentCount);
    await tx.instalment.createMany({
      data: schedule.map((s) => ({
        contractId: contract.id,
        instalmentNo: s.instalmentNo,
        dueDate: s.dueDate,
        amountDueMinor: s.amountDueMinor,
        principalPortionMinor: s.principalPortionMinor,
        interestPortionMinor: s.interestPortionMinor,
      })),
    });

    // Reserved until the deposit clears (see paymentService.advanceContractStatus).
    await applyStockMovement({
      inventoryItemId: item.id,
      type: 'RESERVE',
      referenceType: 'CONTRACT',
      referenceId: contract.id,
      reason: `Contract ${contractNumber} created`,
      createdById: params.createdById,
      tx,
    });

    return { contract, queuedSmsId: null as string | null }; // PENDING_DEPOSIT — no activation SMS yet
  }).then(async ({ contract, queuedSmsId }) => {
    if (queuedSmsId) void deliverQueuedSms(queuedSmsId).catch((e) => console.error('SMS delivery failed (non-blocking):', e));
    // Tried right away, at creation, even though the contract is still
    // PENDING_DEPOSIT here — enableDirectDebit accepts that status too
    // (hubtelPreapprovalService.ts), specifically so the customer gets the
    // USSD/OTP mandate prompt while still at the counter, not only after the
    // deposit clears (which may be a separate visit). If this fails or was
    // never requested, postPayment's own pendingDirectDebit fallback
    // (paymentService.advanceContractStatus) still catches it the moment the
    // deposit clears and activates the contract, unchanged.
    if (contract.pendingDirectDebitNetwork && contract.pendingDirectDebitMsisdn) {
      const updated = await initiateDirectDebitIfRequested({
        contractId: contract.id, customerId: contract.customerId,
        network: contract.pendingDirectDebitNetwork, msisdn: contract.pendingDirectDebitMsisdn,
        createdById: contract.createdById,
      });
      if (updated) return updated;
    }
    return contract;
  });
}

/**
 * CANCELLED only exists in the SAVE_TO_OWN and DEPOSIT_INSTALMENT state
 * machines (docs/01-plan.md §5 / CONTRACT_STATUSES_BY_TYPE) — DEVICE_LOAN's
 * only exits are COMPLETED, DEFAULTED and WRITTEN_OFF, so a disbursed loan
 * can never be "cancelled" away.
 */
export async function cancelContract(params: { contractId: string; reason: string; userId: string }) {
  return prisma.$transaction(async (tx) => {
    const contract = await tx.contract.findUniqueOrThrow({ where: { id: params.contractId } });
    const allowedStatuses = CONTRACT_STATUSES_BY_TYPE[contract.contractType as ContractTypeName];
    if (!allowedStatuses.includes('CANCELLED')) {
      throw new ContractError(`${contract.contractType} contracts cannot be cancelled — use write-off instead`);
    }
    if (!['ACTIVE', 'PENDING_DEPOSIT', 'DEFAULTED'].includes(contract.status)) {
      throw new ContractError(`Cannot cancel a contract in status ${contract.status}`);
    }

    const updated = await tx.contract.update({
      where: { id: contract.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: params.reason, updatedById: params.userId },
    });

    // Whether the device was ever actually handed over is what decides how cancellation
    // handles the money — not the contract type. SAVE_TO_OWN never issues until COMPLETED,
    // so it's always still RESERVED here; DEPOSIT_INSTALMENT can be cancelled either before
    // the deposit clears (RESERVED) or after (ISSUED, device already with the customer).
    let deviceWasNeverHandedOver = false;
    if (contract.inventoryItemId) {
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: contract.inventoryItemId } });
      if (item.status === 'RESERVED') {
        deviceWasNeverHandedOver = true;
        await applyStockMovement({
          inventoryItemId: item.id,
          type: 'RETURN',
          referenceType: 'CONTRACT',
          referenceId: contract.id,
          reason: `Contract ${contract.contractNumber} cancelled: ${params.reason}`,
          createdById: params.userId,
          tx,
        });
      }
    }

    if (deviceWasNeverHandedOver && contract.totalPaidMinor > 0) {
      // The deal fell through before any product changed hands — this is a full
      // withdrawal, not a partial dispute, so every payment unwinds via its own
      // reversal row (mission rule: reversed, not deleted, one row per original).
      // If the device already went out (DEPOSIT_INSTALMENT cancelled from ACTIVE),
      // this is deliberately skipped — auto-refunding while the customer keeps the
      // device would be a straight business loss, so that case stays a reported
      // figure for staff to resolve manually.
      await reverseAllPaymentsForContract(tx, { contractId: contract.id, reason: params.reason, reversedById: params.userId });
    }

    // refundDueMinor is what needs to be handed back to the customer, regardless of
    // whether the ledger has already been reversed to reflect it (deviceWasNeverHandedOver)
    // or is left as a figure for staff to act on (device already issued).
    return { ...updated, refundDueMinor: contract.totalPaidMinor };
  });
}

export async function writeOffContract(params: { contractId: string; reason: string; userId: string }) {
  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: params.contractId } });
  if (!CONTRACT_STATUSES_BY_TYPE[contract.contractType as ContractTypeName].includes('WRITTEN_OFF')) {
    throw new ContractError(`${contract.contractType} contracts cannot be written off`);
  }
  if (!['ACTIVE', 'DEFAULTED'].includes(contract.status)) {
    throw new ContractError(`Cannot write off a contract in status ${contract.status}`);
  }
  return prisma.contract.update({
    where: { id: contract.id },
    data: { status: 'WRITTEN_OFF', writtenOffAt: new Date(), writeOffReason: params.reason, updatedById: params.userId },
  });
}

/** Explicit, staff-triggered hand-over of the device once a SAVE_TO_OWN contract is fully paid. */
export async function releaseContract(params: { contractId: string; userId: string }) {
  return prisma.$transaction(async (tx) => {
    const contract = await tx.contract.findUniqueOrThrow({ where: { id: params.contractId } });
    if (contract.contractType !== 'SAVE_TO_OWN') throw new ContractError('Only SAVE_TO_OWN contracts are released');
    if (contract.status !== 'COMPLETED') throw new ContractError('Contract must be COMPLETED before release');
    if (!contract.inventoryItemId) throw new ContractError('Contract has no inventory item to release');

    await applyStockMovement({
      inventoryItemId: contract.inventoryItemId,
      type: 'ISSUE',
      referenceType: 'CONTRACT',
      referenceId: contract.id,
      reason: `Contract ${contract.contractNumber} released to customer`,
      createdById: params.userId,
      tx,
    });

    return tx.contract.update({
      where: { id: contract.id },
      data: { status: 'RELEASED', releasedAt: new Date(), updatedById: params.userId },
    });
  });
}
