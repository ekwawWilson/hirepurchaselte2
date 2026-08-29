import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { generateContractNumber } from '../utils/idGenerators';
import { getActivePriceChartEntry } from './priceChartService';
import { applyStockMovement } from './inventoryService';
import { generateStraightLineSchedule, generateLoanSchedule, derivePrincipalFromTotalPayable } from './scheduleService';
import { queueSms, deliverQueuedSms } from './smsService';
import { reverseAllPaymentsForContract } from './paymentService';
import { initiatePreapproval, enableDirectDebit } from './hubtelPreapprovalService';
import { CONTRACT_STATUSES_BY_TYPE, DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES, type ContractTypeName, type PaymentFrequencyName } from '../constants/contracts';

export class ContractError extends Error {}

export interface CreateContractParams {
  contractType: ContractTypeName;
  customerId: string;
  // Required for SAVE_TO_OWN/DEPOSIT_INSTALMENT — a specific serialized unit is
  // reserved/issued from this branch's stock. DEVICE_LOAN disburses cash for the
  // customer to buy a device outside the store, so it has no unit to reserve —
  // pass productId instead (docs/01-plan.md).
  inventoryItemId?: string;
  productId?: string;
  termMonths: number;
  paymentFrequency?: PaymentFrequencyName;
  startDate?: Date;
  gracePeriodDays?: number;
  penaltyRateBps?: number;
  directDebitNetwork?: string;
  directDebitMsisdn?: string;
  branchId: string;
  createdById: string;
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

  let item: { id: string; productId: string } | null = null;
  let productId: string;

  if (params.contractType === 'DEVICE_LOAN') {
    if (!params.productId) {
      throw new ContractError('productId is required for a DEVICE_LOAN contract — cash is disbursed against a priced product, not a specific stock unit');
    }
    const product = await prisma.product.findUnique({ where: { id: params.productId } });
    if (!product) throw new ContractError('Product not found');
    productId = product.id;
  } else {
    if (!params.inventoryItemId) throw new ContractError('inventoryItemId is required for this contract type');
    const found = await prisma.inventoryItem.findUnique({ where: { id: params.inventoryItemId } });
    if (!found) throw new ContractError('Inventory item not found');
    if (found.status !== 'AVAILABLE') throw new ContractError(`Inventory item is not available (status: ${found.status})`);
    if (found.branchId !== params.branchId) throw new ContractError('Inventory item does not belong to this branch');
    item = found;
    productId = found.productId;
  }

  const paymentFrequency = params.paymentFrequency ?? 'MONTHLY';
  const chartEntry = await getActivePriceChartEntry(productId, params.contractType, params.termMonths, paymentFrequency);
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
      return await runContractTransaction(params, item, productId, chartEntry, startDate);
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
  item: { id: string; productId: string } | null,
  productId: string,
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
    let scheduleKind: 'STRAIGHT_LINE' | 'LOAN' | 'NONE';

    switch (params.contractType) {
      case 'SAVE_TO_OWN':
        status = 'ACTIVE';
        scheduleFinanceAmount = totalPayableMinor; // no deposit — pays from zero
        // Free-form savings: the customer deposits any amount, any time, toward
        // totalPayableMinor — no due dates, no fixed instalment amount, no
        // OVERDUE/arrears/defaulting concept for this type. So unlike the other
        // two types, no Instalment schedule is generated at all.
        scheduleKind = 'NONE';
        break;

      case 'DEPOSIT_INSTALMENT':
        status = 'PENDING_DEPOSIT';
        depositAmountMinor = chartEntry.depositAmountMinor; // absolute amount set by admin, not derived
        scheduleFinanceAmount = totalPayableMinor - depositAmountMinor;
        scheduleKind = 'STRAIGHT_LINE';
        break;

      case 'DEVICE_LOAN':
        status = 'ACTIVE'; // cash disbursed unconditionally, no down-payment gate (docs/01-plan.md §5) — no device/unit involved at all (§20)
        interestRateBps = chartEntry.interestRateBps;
        if (interestRateBps === null) throw new ContractError('Price chart entry is missing interestRateBps for a DEVICE_LOAN');
        principalMinor = derivePrincipalFromTotalPayable(totalPayableMinor, interestRateBps, params.termMonths);
        scheduleFinanceAmount = principalMinor; // unused directly — loan schedule uses principal+rate below
        scheduleKind = 'LOAN';
        break;
    }

    const directDebitEligible = DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES.includes(params.contractType);

    const contract = await tx.contract.create({
      data: {
        contractNumber,
        contractType: params.contractType,
        customerId: params.customerId,
        productId,
        inventoryItemId: item?.id ?? null,
        branchId: params.branchId,
        priceChartEntryId: chartEntry.id,
        totalPriceMinor: totalPayableMinor,
        depositAmountMinor,
        termMonths: params.termMonths,
        paymentFrequency: chartEntry.paymentFrequency,
        instalmentAmountMinor: chartEntry.instalmentAmountMinor,
        principalMinor,
        interestRateBps,
        rateBasis: params.contractType === 'DEVICE_LOAN' ? 'FLAT' : null,
        gracePeriodDays: params.gracePeriodDays ?? 7,
        penaltyRateBps: params.penaltyRateBps ?? 0,
        pendingDirectDebitNetwork: directDebitEligible ? (params.directDebitNetwork ?? null) : null,
        pendingDirectDebitMsisdn: directDebitEligible ? (params.directDebitMsisdn ?? null) : null,
        status,
        totalPayableMinor,
        totalPaidMinor: 0,
        balanceMinor: totalPayableMinor,
        startDate,
        activatedAt: status === 'ACTIVE' ? new Date() : null,
        createdById: params.createdById,
      },
    });

    if (scheduleKind !== 'NONE') {
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
    }

    // SAVE_TO_OWN reserves the device until fully paid; DEPOSIT_INSTALMENT reserves it
    // until the deposit clears (see paymentService.advanceContractStatus). DEVICE_LOAN
    // has no `item` at all — it disburses cash for the customer to buy a device outside
    // the store, so there's no stock unit to touch (§20).
    if (item) {
      await applyStockMovement({
        inventoryItemId: item.id,
        type: 'RESERVE',
        referenceType: 'CONTRACT',
        referenceId: contract.id,
        reason: `Contract ${contractNumber} created`,
        createdById: params.createdById,
        tx,
      });
    }

    let queuedSmsId: string | null = null;
    if (status === 'ACTIVE') {
      const sms = await queueSms({ contractId: contract.id, templateKey: 'contract.activated', tx });
      queuedSmsId = sms?.id ?? null;
    }

    return { contract, queuedSmsId };
  }).then(async ({ contract, queuedSmsId }) => {
    if (queuedSmsId) void deliverQueuedSms(queuedSmsId).catch((e) => console.error('SMS delivery failed (non-blocking):', e));
    // DEVICE_LOAN is ACTIVE immediately (no deposit gate) — a DEPOSIT_INSTALMENT contract
    // is still PENDING_DEPOSIT here, so its pending direct debit is initiated later, from
    // paymentService.advanceContractStatus, the moment the deposit clears.
    if (contract.status === 'ACTIVE') {
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
