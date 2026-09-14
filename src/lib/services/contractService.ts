import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { generateContractNumber } from '../utils/idGenerators';
import { applyStockMovement } from './inventoryService';
import { generateStraightLineSchedule } from './scheduleService';
import { queueSms, deliverQueuedSms } from './smsService';
import { reverseAllPaymentsForContract } from './paymentService';
import { initiatePreapproval, enableDirectDebit } from './hubtelPreapprovalService';
import { getLoanSettings } from './loanSettingsService';
import { getWorkingDays } from './operatingSettingsService';
import { getContractTypeSettings, isContractTypeEnabled } from './contractTypeSettingsService';
import { contractTypeLabel } from '../utils';
import {
  CONTRACT_STATUSES_BY_TYPE, DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES,
  DEPOSIT_INSTALMENT_FREQUENCIES, DEPOSIT_INSTALMENT_MIN_TERM_WEEKS, DEPOSIT_INSTALMENT_MAX_TERM_WEEKS,
  PRE_APPROVAL_STATUSES, INITIAL_STATUS_BY_TYPE,
  type ContractTypeName, type PaymentFrequencyName, type PaymentMethodName,
} from '../constants/contracts';

export class ContractError extends Error {}

export interface CreateContractParams {
  contractType: ContractTypeName;
  customerId: string;
  branchId: string;
  createdById: string;
  startDate?: Date;
  // Set by the API route from the acting user's own role (never client-supplied —
  // a caller claiming AGENT-ness to skip approval, or claiming otherwise to skip
  // it, would defeat the whole point). true routes the new contract to
  // PENDING_APPROVAL instead of its type's usual first status — see
  // INITIAL_STATUS_BY_TYPE and the Agent module docs on Contract in schema.prisma.
  requiresApproval?: boolean;
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
  // Save to Own and Device Loan are only offered once activated in Settings.
  // Checked here, not in the route, so every caller (the API, demoSeed) obeys it.
  if (!isContractTypeEnabled(await getContractTypeSettings(), params.contractType)) {
    throw new ContractError(`${contractTypeLabel(params.contractType)} is not activated — an admin can turn it on in Settings > Contract types`);
  }

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
  const requiresApproval = params.requiresApproval ?? false;

  return prisma.$transaction(async (tx) => {
    const contract = await tx.contract.create({
      data: {
        contractNumber,
        contractType: 'SAVE_TO_OWN',
        customerId: params.customerId,
        branchId: params.branchId,
        paymentMethod: 'CUSTOMER_INITIATED', // never direct-debit eligible — no due schedule to auto-collect against
        status: requiresApproval ? 'PENDING_APPROVAL' : 'ACTIVE',
        startDate,
        activatedAt: requiresApproval ? null : new Date(),
        submittedForApprovalAt: requiresApproval ? new Date() : null,
        createdById: params.createdById,
      },
    });

    // The welcome/activation SMS only makes sense once the account is real —
    // an agent-submitted account isn't yet (approveContract sends it then).
    const sms = requiresApproval ? null : await queueSms({ contractId: contract.id, templateKey: 'contract.activated', tx });
    return { contract, queuedSmsId: sms?.id ?? null };
  }).then(async ({ contract, queuedSmsId }) => {
    if (queuedSmsId) void deliverQueuedSms(queuedSmsId).catch((e) => console.error('SMS delivery failed (non-blocking):', e));
    return contract;
  });
}

/**
 * DEVICE_LOAN's own creation path: no product/inventory item, no schedule —
 * a daily-simple-interest loan (loanService.accrueDailyLoanInterest charges
 * 1%/working day against principalMinor until it's paid off; see
 * paymentService.postDeviceLoanPayment for how it's repaid). interestRateBps
 * and gracePeriodDays are snapshotted from the current LoanSettings — later
 * changes to those global settings never reprice a loan already created.
 */
async function runDeviceLoanTransaction(params: CreateContractParams, startDate: Date) {
  const contractNumber = await generateContractNumber();
  const loanAmountMinor = params.loanAmountMinor as number;
  const requiresApproval = params.requiresApproval ?? false;

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
        // cash disbursed unconditionally, no down-payment gate (docs/01-plan.md §5) —
        // UNLESS an agent submitted it, in which case it must be approved first,
        // exactly like every other type (schema.prisma's Contract comment).
        status: requiresApproval ? 'PENDING_APPROVAL' : 'ACTIVE',
        totalPaidMinor: 0,
        startDate,
        activatedAt: requiresApproval ? null : new Date(),
        submittedForApprovalAt: requiresApproval ? new Date() : null,
        createdById: params.createdById,
      },
    });

    const sms = requiresApproval ? null : await queueSms({ contractId: contract.id, templateKey: 'contract.activated', tx });
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
  const requiresApproval = params.requiresApproval ?? false;

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
        status: requiresApproval ? 'PENDING_APPROVAL' : 'PENDING_DEPOSIT',
        totalPayableMinor,
        totalPaidMinor: 0,
        balanceMinor: totalPayableMinor,
        startDate,
        activatedAt: null,
        submittedForApprovalAt: requiresApproval ? new Date() : null,
        createdById: params.createdById,
      },
    });

    // termMonths passed here is irrelevant — instalmentCount is always
    // explicit for this weeks-based term (scheduleService.ts's guard is
    // relaxed accordingly whenever an explicit count is given). Working days
    // are read once here and baked into the dates written below: changing
    // the setting later never moves an existing schedule the customer has
    // already agreed to.
    const workingDays = await getWorkingDays(tx);
    const schedule = generateStraightLineSchedule(financeAmountMinor, 1, startDate, frequency, instalmentCount, workingDays);
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
    // deposit clears and activates the contract, unchanged. Never attempted
    // at all while pending approval — the customer shouldn't get a mandate
    // prompt for a deal that hasn't been approved yet; approveContract tries
    // this exact same thing once it is.
    if (!requiresApproval && contract.pendingDirectDebitNetwork && contract.pendingDirectDebitMsisdn) {
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
    // Also doubles as an approver's outright "reject" of an agent-submitted
    // contract — no payment can exist yet on either pre-approval status
    // (postPayment refuses both), and any reserved stock is simply returned
    // below, same as cancelling a PENDING_DEPOSIT contract always has.
    if (![...PRE_APPROVAL_STATUSES, 'ACTIVE', 'PENDING_DEPOSIT', 'DEFAULTED'].includes(contract.status)) {
      throw new ContractError(`Cannot cancel a contract in status ${contract.status}`);
    }

    const updated = await tx.contract.update({
      where: { id: contract.id },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: params.reason, updatedById: params.userId },
    });

    // Whether anything physical was ever handed over is what decides how cancellation
    // handles the money — not the contract type. SAVE_TO_OWN is never linked to a
    // product/item at all (open-ended savings, contractService.ts), so there's
    // trivially nothing that could have gone out — always a full withdrawal.
    // DEPOSIT_INSTALMENT can be cancelled either before the deposit clears
    // (item RESERVED) or after (ISSUED, device already with the customer).
    let deviceWasNeverHandedOver = contract.contractType === 'SAVE_TO_OWN';
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
  // Also DEVICE_LOAN's only way to reject an agent-submitted contract outright
  // (it has no CANCELLED state at all — docs/01-plan.md §5/CONTRACT_STATUSES_BY_TYPE).
  if (![...PRE_APPROVAL_STATUSES, 'ACTIVE', 'DEFAULTED'].includes(contract.status)) {
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

// ---------------------------------------------------------------------------
// Agent approval workflow (docs/01-plan.md's Agent module)
// ---------------------------------------------------------------------------

/**
 * An approver (contract.approve — BRANCH_MANAGER/ADMIN/SUPER_ADMIN) accepts an
 * agent-submitted contract: it jumps straight to its type's real first status
 * (INITIAL_STATUS_BY_TYPE) exactly as if a non-agent had just created it —
 * SAVE_TO_OWN/DEVICE_LOAN go ACTIVE right away (and now get the
 * contract.activated SMS withheld at creation); DEPOSIT_INSTALMENT still
 * waits for its deposit (PENDING_DEPOSIT), same as always.
 */
export async function approveContract(params: { contractId: string; approvedById: string }) {
  const result = await prisma.$transaction(async (tx) => {
    const contract = await tx.contract.findUniqueOrThrow({ where: { id: params.contractId } });
    if (contract.status !== 'PENDING_APPROVAL') {
      throw new ContractError(`Only a contract awaiting approval can be approved (this one is ${contract.status})`);
    }

    const initialStatus = INITIAL_STATUS_BY_TYPE[contract.contractType as ContractTypeName];
    const now = new Date();
    const updated = await tx.contract.update({
      where: { id: contract.id },
      data: {
        status: initialStatus,
        approvedById: params.approvedById,
        approvedAt: now,
        revisionReason: null,
        activatedAt: initialStatus === 'ACTIVE' ? now : null,
      },
    });

    const sms = initialStatus === 'ACTIVE'
      ? await queueSms({ contractId: contract.id, templateKey: 'contract.activated', tx })
      : null;
    return { contract: updated, queuedSmsId: sms?.id ?? null };
  });

  if (result.queuedSmsId) {
    void deliverQueuedSms(result.queuedSmsId).catch((e) => console.error('SMS delivery failed (non-blocking):', e));
  }

  // Same "try the mandate the moment it's actually usable" as a non-agent
  // contract's own creation — only ever reachable for DEPOSIT_INSTALMENT,
  // the only type pendingDirectDebitNetwork/Msisdn is set on, and only if it
  // wasn't already tried (contractService's creation path attempts this too,
  // but skips it entirely while requiresApproval — see runDepositInstalmentTransaction).
  if (!result.contract.hubtelPreapprovalId && result.contract.pendingDirectDebitNetwork && result.contract.pendingDirectDebitMsisdn) {
    const updated = await initiateDirectDebitIfRequested({
      contractId: result.contract.id, customerId: result.contract.customerId,
      network: result.contract.pendingDirectDebitNetwork, msisdn: result.contract.pendingDirectDebitMsisdn,
      createdById: result.contract.createdById,
    });
    if (updated) return updated;
  }
  return result.contract;
}

/**
 * An approver sends an agent-submitted contract back with a reason instead
 * of approving it. The agent (and only the agent who created it — enforced
 * by the API route, same as every other ownership check in this app) edits
 * and calls resubmitContract below.
 */
export async function requestContractRevision(params: { contractId: string; reason: string }) {
  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: params.contractId } });
  if (contract.status !== 'PENDING_APPROVAL') {
    throw new ContractError(`Only a contract awaiting approval can be sent back for revision (this one is ${contract.status})`);
  }
  if (!params.reason.trim()) throw new ContractError('A reason is required');

  return prisma.contract.update({
    where: { id: contract.id },
    data: { status: 'REVISION_REQUESTED', revisionReason: params.reason.trim() },
  });
}

export interface ResubmitContractUpdates {
  totalPayableMinor?: number;
  depositAmountMinor?: number;
  termWeeks?: number;
  paymentFrequency?: PaymentFrequencyName;
  gracePeriodDays?: number;
  penaltyRateBps?: number;
  startDate?: Date;
  loanAmountMinor?: number;
}

/**
 * The agent edits a REVISION_REQUESTED contract's terms and sends it back
 * for another look. SAVE_TO_OWN has nothing to edit (no term at all) — it
 * just returns to PENDING_APPROVAL unchanged. A DEPOSIT_INSTALMENT's
 * instalment schedule is rebuilt from scratch on any term change: nothing on
 * the old one can have been paid — postPayment refuses both PENDING_APPROVAL
 * and REVISION_REQUESTED (PRE_APPROVAL_STATUSES) — so there is nothing to
 * preserve.
 */
export async function resubmitContract(params: { contractId: string; updates: ResubmitContractUpdates }) {
  return prisma.$transaction(async (tx) => {
    const contract = await tx.contract.findUniqueOrThrow({ where: { id: params.contractId } });
    if (contract.status !== 'REVISION_REQUESTED') {
      throw new ContractError(`Only a contract sent back for revision can be resubmitted (this one is ${contract.status})`);
    }

    const data: Prisma.ContractUpdateInput = {
      status: 'PENDING_APPROVAL',
      revisionReason: null,
      submittedForApprovalAt: new Date(),
    };

    if (contract.contractType === 'DEVICE_LOAN' && params.updates.loanAmountMinor !== undefined) {
      if (params.updates.loanAmountMinor <= 0) throw new ContractError('loanAmountMinor must be positive');
      data.principalMinor = params.updates.loanAmountMinor;
    }

    if (contract.contractType === 'DEPOSIT_INSTALMENT') {
      const totalPayableMinor = params.updates.totalPayableMinor ?? contract.totalPayableMinor!;
      const depositAmountMinor = params.updates.depositAmountMinor ?? contract.depositAmountMinor;
      const termWeeks = params.updates.termWeeks ?? contract.termWeeks!;
      const frequency = (params.updates.paymentFrequency ?? contract.paymentFrequency) as PaymentFrequencyName;
      const startDate = params.updates.startDate ?? contract.startDate;

      if (totalPayableMinor <= 0) throw new ContractError('totalPayableMinor must be positive');
      if (depositAmountMinor < 0 || depositAmountMinor >= totalPayableMinor) {
        throw new ContractError('depositAmountMinor must be non-negative and less than totalPayableMinor');
      }
      if (termWeeks < DEPOSIT_INSTALMENT_MIN_TERM_WEEKS || termWeeks > DEPOSIT_INSTALMENT_MAX_TERM_WEEKS) {
        throw new ContractError(`termWeeks must be between ${DEPOSIT_INSTALMENT_MIN_TERM_WEEKS} and ${DEPOSIT_INSTALMENT_MAX_TERM_WEEKS}`);
      }
      if (!(DEPOSIT_INSTALMENT_FREQUENCIES as readonly string[]).includes(frequency)) {
        throw new ContractError(`paymentFrequency must be one of: ${DEPOSIT_INSTALMENT_FREQUENCIES.join(', ')}`);
      }

      const financeAmountMinor = totalPayableMinor - depositAmountMinor;
      const instalmentCount = frequency === 'DAILY' ? termWeeks * 7 : termWeeks;
      const instalmentAmountMinor = Math.ceil(financeAmountMinor / instalmentCount);

      Object.assign(data, {
        totalPriceMinor: totalPayableMinor,
        totalPayableMinor,
        balanceMinor: totalPayableMinor,
        depositAmountMinor,
        termWeeks,
        paymentFrequency: frequency,
        instalmentAmountMinor,
        startDate,
        gracePeriodDays: params.updates.gracePeriodDays ?? contract.gracePeriodDays,
        penaltyRateBps: params.updates.penaltyRateBps ?? contract.penaltyRateBps,
      });

      // Replace the schedule entirely.
      await tx.instalment.deleteMany({ where: { contractId: contract.id } });
      const workingDays = await getWorkingDays(tx);
      const schedule = generateStraightLineSchedule(financeAmountMinor, 1, startDate, frequency, instalmentCount, workingDays);
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
    }

    return tx.contract.update({ where: { id: contract.id }, data });
  });
}
