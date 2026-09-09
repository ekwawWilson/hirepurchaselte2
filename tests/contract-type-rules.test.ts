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
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@zple.test' } });
    adminUserId = admin.id;
  });

  async function makeProduct(label: string) {
    const product = await prisma.product.create({
      data: { sku: `RULES-SKU-${label}-${runId}`, name: `Rules Phone ${label}`, cashPriceMinor: 100000 },
    });
    return product.id;
  }

  async function makeCustomer(label: string) {
    const customer = await prisma.customer.create({
      data: {
        membershipId: `RULES-MEM-${label}-${runId}`, firstName: 'Rules', lastName: label,
        phone: `029${runId}${label}`, branchId, createdById: adminUserId,
      },
    });
    return customer.id;
  }

  async function makeCustomerAndItem(productId: string, label: string) {
    const customerId = await makeCustomer(label);
    const item = await prisma.inventoryItem.create({
      data: { productId, branchId, serialNumber: `IMEI-RULES-${label}-${runId}` },
    });
    return { customerId, inventoryItemId: item.id };
  }

  it('DEVICE_LOAN contracts cannot be cancelled — CANCELLED is not in that type\'s state list', async () => {
    const productId = await makeProduct('LOAN-CANCEL');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEVICE_LOAN', termMonths: 6, depositAmountMinor: 0,
        totalPayableMinor: 120000, instalmentAmountMinor: 20000, interestRateBps: 2400, createdById: adminUserId,
      },
    });
    const { customerId } = await makeCustomerAndItem(productId, 'A');
    const contract = await createContract({
      contractType: 'DEVICE_LOAN', customerId, productId, termMonths: 6, branchId, createdById: adminUserId,
    });

    await expect(cancelContract({ contractId: contract.id, reason: 'changed mind', userId: adminUserId }))
      .rejects.toThrow(ContractError);
  });

  it('cancelling a SAVE_TO_OWN account with prior deposits is a full withdrawal: reports the refund and actually reverses the ledger to zero', async () => {
    // SAVE_TO_OWN is open-ended savings — no product, no inventory item, no
    // price chart entry at all (contractService.ts).
    const customerId = await makeCustomer('B');
    const contract = await createContract({
      contractType: 'SAVE_TO_OWN', customerId, branchId, createdById: adminUserId,
    });
    expect(contract.productId).toBeNull();
    expect(contract.inventoryItemId).toBeNull();

    await postPayment({ contractId: contract.id, amountMinor: 15000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
    await postPayment({ contractId: contract.id, amountMinor: 5000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });

    const cancelled = await cancelContract({ contractId: contract.id, reason: 'customer withdrew', userId: adminUserId });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.refundDueMinor).toBe(20000); // the figure to physically hand back

    // No device was ever involved — this is a full withdrawal, so the ledger
    // itself must unwind, not just report a number.
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.totalPaidMinor).toBe(0);

    const payments = await prisma.payment.findMany({ where: { contractId: contract.id } });
    expect(payments).toHaveLength(4); // 2 originals + 2 reversals
    expect(payments.filter((p) => p.reversesPaymentId !== null)).toHaveLength(2);
    expect(payments.every((p) => p.reversesPaymentId === null || p.reversalReason === 'customer withdrew')).toBe(true);
  });

  it('cancelling a DEPOSIT_INSTALMENT contract that already issued the device does NOT auto-reverse payments — the customer keeps the device, so the refund figure needs a human, not an automatic full unwind', async () => {
    const productId = await makeProduct('DEP-ISSUED-CANCEL');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 6, depositAmountMinor: 50000,
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
        productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 2, depositAmountMinor: 50000,
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
        productId: depositProductId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 2, depositAmountMinor: 50000,
        totalPayableMinor: 100000, instalmentAmountMinor: 25000, createdById: adminUserId,
      },
    });
    const dep = await makeCustomerAndItem(depositProductId, 'D');
    const depositContract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: dep.customerId, inventoryItemId: dep.inventoryItemId,
      termMonths: 2, branchId, createdById: adminUserId,
    });
    await postPayment({ contractId: depositContract.id, amountMinor: 50000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });

    // SAVE_TO_OWN is open-ended savings — no product/price chart entry, and
    // (unlike DEPOSIT_INSTALMENT above) never has any instalments to backdate
    // into OVERDUE at all, which is exactly the point: there's nothing here
    // for markDefaultedContracts to ever act on.
    const saveCustomerId = await makeCustomer('E');
    const saveContract = await createContract({
      contractType: 'SAVE_TO_OWN', customerId: saveCustomerId, branchId, createdById: adminUserId,
    });

    // Simulate the daily markOverdueInstalments sweep having already run 100 days ago
    // (past the 90-day default threshold) on the deposit contract's first instalment.
    const deeplyOverdue = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await prisma.instalment.updateMany({
      where: { contractId: depositContract.id, instalmentNo: 1 },
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
        productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 2, depositAmountMinor: 50000,
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

  it('SAVE_TO_OWN is open-ended savings: no product, no price chart entry, no instalment schedule, no target, and it never auto-completes no matter how much is deposited', async () => {
    const customerId = await makeCustomer('FF');
    const contract = await createContract({
      contractType: 'SAVE_TO_OWN', customerId, branchId, createdById: adminUserId,
    });
    expect(contract.productId).toBeNull();
    expect(contract.inventoryItemId).toBeNull();
    expect(contract.priceChartEntryId).toBeNull();
    expect(contract.termMonths).toBeNull();
    expect(contract.totalPayableMinor).toBeNull();
    expect(contract.balanceMinor).toBeNull();

    // No schedule at all — not "a schedule that happens to be empty".
    const instalments = await prisma.instalment.findMany({ where: { contractId: contract.id } });
    expect(instalments).toHaveLength(0);

    // Deposits of uneven, arbitrary sizes — nothing like a fixed instalment amount.
    await postPayment({ contractId: contract.id, amountMinor: 12345, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
    await postPayment({ contractId: contract.id, amountMinor: 500, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
    let current = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(current.totalPaidMinor).toBe(12845);
    expect(current.balanceMinor).toBeNull(); // still no target to measure a balance against
    expect(current.status).toBe('ACTIVE');

    // A large deposit — with no target, there's nothing to "complete" against.
    await postPayment({ contractId: contract.id, amountMinor: 987155, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
    current = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(current.totalPaidMinor).toBe(1000000);
    expect(current.balanceMinor).toBeNull();
    expect(current.status).toBe('ACTIVE'); // never auto-completes, regardless of amount saved

    // markOverdueInstalments/markDefaultedContracts must never touch a contract with no
    // instalments to begin with — this contract has none, so both sweeps are no-ops for it.
    const stillNoInstalments = await prisma.instalment.count({ where: { contractId: contract.id } });
    expect(stillNoInstalments).toBe(0);
  });
});
