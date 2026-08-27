/**
 * Regression coverage for the per-contract-type lifecycle rules audited and
 * fixed in this pass (docs/01-plan.md §5 / CONTRACT_STATUSES_BY_TYPE):
 *  - DEVICE_LOAN has no CANCELLED state — only SAVE_TO_OWN/DEPOSIT_INSTALMENT can be cancelled.
 *  - Cancelling a contract surfaces the amount already paid as a refund owed to the customer.
 *  - A DEPOSIT entryType payment is only valid while the contract is still PENDING_DEPOSIT.
 *  - DEFAULTED is reachable (an ACTIVE DEPOSIT_INSTALMENT/DEVICE_LOAN contract with an
 *    instalment overdue past the threshold gets flipped), SAVE_TO_OWN is exempt (it has
 *    no DEFAULTED state), and a DEFAULTED contract cures back to ACTIVE/COMPLETED once
 *    a payment clears its arrears.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { createContract, cancelContract, ContractError } from '@/lib/services/contractService';
import { postPayment, PaymentError } from '@/lib/services/paymentService';
import { markDefaultedContracts } from '@/lib/services/overdueService';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);

describe('Contract-type-specific business rules', () => {
  let branchId: string;
  let adminUserId: string;

  beforeAll(async () => {
    const branch = await prisma.branch.findFirstOrThrow();
    branchId = branch.id;
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hplite.test' } });
    adminUserId = admin.id;
  });

  async function makeProduct(label: string) {
    const product = await prisma.product.create({
      data: { sku: `RULES-SKU-${label}-${runId}`, name: `Rules Phone ${label}`, cashPriceMinor: 100000 },
    });
    return product.id;
  }

  async function makeCustomerAndItem(productId: string, label: string) {
    const customer = await prisma.customer.create({
      data: {
        membershipId: `RULES-MEM-${label}-${runId}`, firstName: 'Rules', lastName: label,
        phone: `029${runId}${label}`, branchId, createdById: adminUserId,
      },
    });
    const item = await prisma.inventoryItem.create({
      data: { productId, branchId, serialNumber: `IMEI-RULES-${label}-${runId}` },
    });
    return { customerId: customer.id, inventoryItemId: item.id };
  }

  it('DEVICE_LOAN contracts cannot be cancelled — CANCELLED is not in that type\'s state list', async () => {
    const productId = await makeProduct('LOAN-CANCEL');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEVICE_LOAN', termMonths: 6, depositPercentage: 0,
        totalPayableMinor: 120000, instalmentAmountMinor: 20000, interestRateBps: 2400, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'A');
    const contract = await createContract({
      contractType: 'DEVICE_LOAN', customerId, inventoryItemId, termMonths: 6, branchId, createdById: adminUserId,
    });

    await expect(cancelContract({ contractId: contract.id, reason: 'changed mind', userId: adminUserId }))
      .rejects.toThrow(ContractError);
  });

  it('cancelling a SAVE_TO_OWN contract with prior payments is a full withdrawal: reports the refund and actually reverses the ledger to zero', async () => {
    const productId = await makeProduct('SAVE-CANCEL');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'SAVE_TO_OWN', termMonths: 6, depositPercentage: 0,
        totalPayableMinor: 60000, instalmentAmountMinor: 10000, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'B');
    const contract = await createContract({
      contractType: 'SAVE_TO_OWN', customerId, inventoryItemId, termMonths: 6, branchId, createdById: adminUserId,
    });

    await postPayment({ contractId: contract.id, amountMinor: 15000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
    await postPayment({ contractId: contract.id, amountMinor: 5000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });

    const cancelled = await cancelContract({ contractId: contract.id, reason: 'customer withdrew', userId: adminUserId });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.refundDueMinor).toBe(20000); // the figure to physically hand back

    // The device was never handed over (SAVE_TO_OWN reserves, never issues, until COMPLETED) —
    // this is a full withdrawal, so the ledger itself must unwind, not just report a number.
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.totalPaidMinor).toBe(0);

    const payments = await prisma.payment.findMany({ where: { contractId: contract.id } });
    expect(payments).toHaveLength(4); // 2 originals + 2 reversals
    expect(payments.filter((p) => p.reversesPaymentId !== null)).toHaveLength(2);
    expect(payments.every((p) => p.reversesPaymentId === null || p.reversalReason === 'customer withdrew')).toBe(true);

    // The physical item is real stock, not consumed by a cancelled contract — it must be
    // issuable again. Contract.inventoryItemId used to be @unique, so a *second* contract
    // against the same item (even after the first was cancelled and the item returned to
    // AVAILABLE) would fail with a P2002 the moment it tried to insert, permanently
    // stranding that serial number the instant any contract — cancelled or not — touched it.
    const itemAfterCancel = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: inventoryItemId } });
    expect(itemAfterCancel.status).toBe('AVAILABLE');

    const { customerId: secondCustomerId } = await makeCustomerAndItem(productId, 'B2');
    const secondContract = await createContract({
      contractType: 'SAVE_TO_OWN', customerId: secondCustomerId, inventoryItemId, termMonths: 6, branchId, createdById: adminUserId,
    });
    expect(secondContract.id).not.toBe(contract.id);
    expect(secondContract.inventoryItemId).toBe(inventoryItemId);
  });

  it('cancelling a DEPOSIT_INSTALMENT contract that already issued the device does NOT auto-reverse payments — the customer keeps the device, so the refund figure needs a human, not an automatic full unwind', async () => {
    const productId = await makeProduct('DEP-ISSUED-CANCEL');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 6, depositPercentage: 50,
        totalPayableMinor: 100000, instalmentAmountMinor: 8333, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'ISSUED');
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId, termMonths: 6, branchId, createdById: adminUserId,
    });

    // Clears the deposit gate: device gets ISSUED, contract goes ACTIVE.
    await postPayment({ contractId: contract.id, amountMinor: 50000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });
    const item = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: inventoryItemId } });
    expect(item.status).toBe('ISSUED');

    const cancelled = await cancelContract({ contractId: contract.id, reason: 'customer stopped paying', userId: adminUserId });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.refundDueMinor).toBe(50000); // reported, for a human to decide — not auto-refunded

    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.totalPaidMinor).toBe(50000); // ledger untouched — no reversal rows created

    const reversals = await prisma.payment.findMany({ where: { contractId: contract.id, reversesPaymentId: { not: null } } });
    expect(reversals).toHaveLength(0);
  });

  it('a DEPOSIT payment is rejected once the deposit gate has already cleared', async () => {
    const productId = await makeProduct('DEP-GATE');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 2, depositPercentage: 50,
        totalPayableMinor: 100000, instalmentAmountMinor: 25000, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'C');
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId, termMonths: 2, branchId, createdById: adminUserId,
    });
    expect(contract.status).toBe('PENDING_DEPOSIT');

    // Clears the deposit gate: 50000 required, contract flips to ACTIVE.
    await postPayment({ contractId: contract.id, amountMinor: 50000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });
    const active = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(active.status).toBe('ACTIVE');

    // Without the fix, this would inflate totalPaidMinor/balanceMinor without allocating
    // to any instalment (allocatePayment only runs for INSTALMENT_PAYMENT).
    await expect(postPayment({ contractId: contract.id, amountMinor: 10000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId }))
      .rejects.toThrow(PaymentError);
  });

  it('markDefaultedContracts flips an ACTIVE DEPOSIT_INSTALMENT contract with a deeply overdue instalment, and leaves SAVE_TO_OWN untouched', async () => {
    const depositProductId = await makeProduct('DEFAULT-DEP');
    await prisma.priceChartEntry.create({
      data: {
        productId: depositProductId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 2, depositPercentage: 50,
        totalPayableMinor: 100000, instalmentAmountMinor: 25000, createdById: adminUserId,
      },
    });
    const dep = await makeCustomerAndItem(depositProductId, 'D');
    const depositContract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: dep.customerId, inventoryItemId: dep.inventoryItemId,
      termMonths: 2, branchId, createdById: adminUserId,
    });
    await postPayment({ contractId: depositContract.id, amountMinor: 50000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });

    const saveProductId = await makeProduct('DEFAULT-SAVE');
    await prisma.priceChartEntry.create({
      data: {
        productId: saveProductId, contractType: 'SAVE_TO_OWN', termMonths: 2, depositPercentage: 0,
        totalPayableMinor: 60000, instalmentAmountMinor: 30000, createdById: adminUserId,
      },
    });
    const sv = await makeCustomerAndItem(saveProductId, 'E');
    const saveContract = await createContract({
      contractType: 'SAVE_TO_OWN', customerId: sv.customerId, inventoryItemId: sv.inventoryItemId,
      termMonths: 2, branchId, createdById: adminUserId,
    });

    // Simulate the daily markOverdueInstalments sweep having already run 100 days ago
    // (past the 90-day default threshold) on both contracts' first instalment.
    const deeplyOverdue = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await prisma.instalment.updateMany({
      where: { contractId: { in: [depositContract.id, saveContract.id] }, instalmentNo: 1 },
      data: { status: 'OVERDUE', dueDate: deeplyOverdue },
    });

    const flipped = await markDefaultedContracts();
    expect(flipped).toBeGreaterThanOrEqual(1); // exact count isn't the point; the two assertions below are

    const depositAfter = await prisma.contract.findUniqueOrThrow({ where: { id: depositContract.id } });
    expect(depositAfter.status).toBe('DEFAULTED');
    expect(depositAfter.defaultedAt).not.toBeNull();

    // SAVE_TO_OWN has no DEFAULTED state in its lifecycle — must be left exactly as it was.
    const saveAfter = await prisma.contract.findUniqueOrThrow({ where: { id: saveContract.id } });
    expect(saveAfter.status).toBe('ACTIVE');
  });

  it('paying off arrears cures a DEFAULTED contract, completing it outright if the payment also clears the balance', async () => {
    const productId = await makeProduct('CURE');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 2, depositPercentage: 50,
        totalPayableMinor: 100000, instalmentAmountMinor: 25000, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'F');
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId, termMonths: 2, branchId, createdById: adminUserId,
    });
    await postPayment({ contractId: contract.id, amountMinor: 50000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });

    await prisma.instalment.updateMany({
      where: { contractId: contract.id },
      data: { status: 'OVERDUE', dueDate: new Date(Date.now() - 100 * 24 * 60 * 60 * 1000) },
    });
    await markDefaultedContracts();
    const defaulted = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(defaulted.status).toBe('DEFAULTED');

    // Full remaining balance (both instalments) in one payment — should cure the
    // default and complete the contract in the same pass, not get stuck at ACTIVE.
    await postPayment({ contractId: contract.id, amountMinor: 50000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
    const completed = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(completed.status).toBe('COMPLETED');
    expect(completed.balanceMinor).toBe(0);
  });

  it('SAVE_TO_OWN is free-form savings: no instalment schedule is generated, uneven deposits of any size are accepted in any order, and it still completes once the balance clears', async () => {
    const productId = await makeProduct('FREEFORM');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'SAVE_TO_OWN', termMonths: 6, depositPercentage: 0,
        totalPayableMinor: 100000, instalmentAmountMinor: 16667, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'FF');
    const contract = await createContract({
      contractType: 'SAVE_TO_OWN', customerId, inventoryItemId, termMonths: 6, branchId, createdById: adminUserId,
    });

    // No schedule at all — not "a schedule that happens to be empty".
    const instalments = await prisma.instalment.findMany({ where: { contractId: contract.id } });
    expect(instalments).toHaveLength(0);

    // Deposits of uneven, arbitrary sizes — nothing like a fixed instalment amount.
    await postPayment({ contractId: contract.id, amountMinor: 12345, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
    await postPayment({ contractId: contract.id, amountMinor: 500, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
    let current = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(current.totalPaidMinor).toBe(12845);
    expect(current.balanceMinor).toBe(100000 - 12845);
    expect(current.status).toBe('ACTIVE'); // still no OVERDUE/DEFAULTED concept to have drifted into

    // Finish it off in one go — balance-driven completion doesn't care that no schedule ever existed.
    await postPayment({ contractId: contract.id, amountMinor: 100000 - 12845, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
    current = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(current.status).toBe('COMPLETED');
    expect(current.balanceMinor).toBe(0);

    // markOverdueInstalments/markDefaultedContracts must never touch a contract with no
    // instalments to begin with — this contract has none, so both sweeps are no-ops for it.
    const stillNoInstalments = await prisma.instalment.count({ where: { contractId: contract.id } });
    expect(stillNoInstalments).toBe(0);
  });
});
