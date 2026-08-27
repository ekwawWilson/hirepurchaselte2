import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { generateContractNumber } from '../utils/idGenerators';
import { getActivePriceChartEntry } from './priceChartService';
import { applyStockMovement } from './inventoryService';
import { generateStraightLineSchedule, generateLoanSchedule, derivePrincipalFromTotalPayable } from './scheduleService';
import { queueSms, deliverQueuedSms } from './smsService';
import { CONTRACT_STATUSES_BY_TYPE, type ContractTypeName, type PaymentFrequencyName } from '../constants/contracts';

export class ContractError extends Error {}

export interface CreateContractParams {
  contractType: ContractTypeName;
  customerId: string;
  inventoryItemId: string;
  termMonths: number;
  paymentFrequency?: PaymentFrequencyName;
  startDate?: Date;
  branchId: string;
  createdById: string;
}

export async function createContract(params: CreateContractParams) {
  const customer = await prisma.customer.findUnique({ where: { id: params.customerId } });
  if (!customer) throw new ContractError('Customer not found');
  if (customer.branchId !== params.branchId) throw new ContractError('Customer does not belong to this branch');

  const item = await prisma.inventoryItem.findUnique({ where: { id: params.inventoryItemId } });
  if (!item) throw new ContractError('Inventory item not found');
  if (item.status !== 'AVAILABLE') throw new ContractError(`Inventory item is not available (status: ${item.status})`);
  if (item.branchId !== params.branchId) throw new ContractError('Inventory item does not belong to this branch');

  const paymentFrequency = params.paymentFrequency ?? 'MONTHLY';
  const chartEntry = await getActivePriceChartEntry(item.productId, params.contractType, params.termMonths, paymentFrequency);
  if (!chartEntry) {
    throw new ContractError(
      `No active price chart entry for this product, ${params.contractType}, ${params.termMonths} months, ${paymentFrequency} — configure one first`,
    );
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
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await runContractTransaction(params, item, chartEntry, startDate);
    } catch (e) {
      const isContractNumberCollision =
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002' &&
        Array.isArray(e.meta?.target) &&
        (e.meta.target as string[]).includes('contractNumber');
      if (isContractNumberCollision && attempt < MAX_ATTEMPTS) continue;
      throw e;
    }
  }
  throw new ContractError('Could not create contract after multiple attempts, please retry');
}

async function runContractTransaction(
  params: CreateContractParams,
  item: { id: string; productId: string },
  chartEntry: NonNullable<Awaited<ReturnType<typeof getActivePriceChartEntry>>>,
  startDate: Date,
) {
  const contractNumber = await generateContractNumber();

  return prisma.$transaction(async (tx) => {
    let status: string;
    let depositAmountMinor = 0;
    let principalMinor: number | null = null;
    let interestRateBps: number | null = null;
    const totalPayableMinor = chartEntry.totalPayableMinor;
    let scheduleFinanceAmount: number;
    let scheduleKind: 'STRAIGHT_LINE' | 'LOAN';

    switch (params.contractType) {
      case 'SAVE_TO_OWN':
        status = 'ACTIVE';
        scheduleFinanceAmount = totalPayableMinor; // no deposit — pays from zero
        scheduleKind = 'STRAIGHT_LINE';
        break;

      case 'DEPOSIT_INSTALMENT':
        status = 'PENDING_DEPOSIT';
        depositAmountMinor = Math.round((totalPayableMinor * chartEntry.depositPercentage) / 100);
        scheduleFinanceAmount = totalPayableMinor - depositAmountMinor;
        scheduleKind = 'STRAIGHT_LINE';
        break;

      case 'DEVICE_LOAN':
        status = 'ACTIVE'; // released unconditionally at disbursement, no down-payment gate (docs/01-plan.md §5)
        interestRateBps = chartEntry.interestRateBps;
        if (interestRateBps === null) throw new ContractError('Price chart entry is missing interestRateBps for a DEVICE_LOAN');
        principalMinor = derivePrincipalFromTotalPayable(totalPayableMinor, interestRateBps, params.termMonths);
        scheduleFinanceAmount = principalMinor; // unused directly — loan schedule uses principal+rate below
        scheduleKind = 'LOAN';
        break;
    }

    const contract = await tx.contract.create({
      data: {
        contractNumber,
        contractType: params.contractType,
        customerId: params.customerId,
        productId: item.productId,
        inventoryItemId: item.id,
        branchId: params.branchId,
        priceChartEntryId: chartEntry.id,
        totalPriceMinor: totalPayableMinor,
        depositAmountMinor,
        depositPercentage: chartEntry.depositPercentage,
        termMonths: params.termMonths,
        paymentFrequency: chartEntry.paymentFrequency,
        instalmentAmountMinor: chartEntry.instalmentAmountMinor,
        principalMinor,
        interestRateBps,
        rateBasis: params.contractType === 'DEVICE_LOAN' ? 'FLAT' : null,
        status,
        totalPayableMinor,
        totalPaidMinor: 0,
        balanceMinor: totalPayableMinor,
        startDate,
        activatedAt: status === 'ACTIVE' ? new Date() : null,
        createdById: params.createdById,
      },
    });

    const scheduleFrequency = chartEntry.paymentFrequency as PaymentFrequencyName;
    const schedule = scheduleKind === 'LOAN'
      ? generateLoanSchedule(principalMinor as number, interestRateBps as number, params.termMonths, startDate, scheduleFrequency)
      : generateStraightLineSchedule(scheduleFinanceAmount, params.termMonths, startDate, scheduleFrequency);

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

    // SAVE_TO_OWN reserves the device until fully paid; DEPOSIT_INSTALMENT reserves it
    // until the deposit clears (see paymentService.advanceContractStatus); DEVICE_LOAN
    // issues it immediately since there's no gate to wait on.
    await applyStockMovement({
      inventoryItemId: item.id,
      type: params.contractType === 'DEVICE_LOAN' ? 'ISSUE' : 'RESERVE',
      referenceType: 'CONTRACT',
      referenceId: contract.id,
      reason: `Contract ${contractNumber} created`,
      createdById: params.createdById,
      tx,
    });

    let queuedSmsId: string | null = null;
    if (status === 'ACTIVE') {
      const sms = await queueSms({ contractId: contract.id, templateKey: 'contract.activated', tx });
      queuedSmsId = sms?.id ?? null;
    }

    return { contract, queuedSmsId };
  }).then(async ({ contract, queuedSmsId }) => {
    if (queuedSmsId) void deliverQueuedSms(queuedSmsId).catch((e) => console.error('SMS delivery failed (non-blocking):', e));
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

    if (contract.inventoryItemId) {
      const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: contract.inventoryItemId } });
      if (item.status === 'RESERVED') {
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

    // Cancellation doesn't move money by itself (payments are only ever reversed
    // explicitly, one at a time, with their own reason/user — mission rule: nothing
    // financial is auto-mutated). What it must do is surface, unambiguously, how
    // much the customer has paid toward a contract that will now never complete,
    // so staff know what's owed back to them.
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
