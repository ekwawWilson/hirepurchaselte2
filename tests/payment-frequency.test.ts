/**
 * Coverage for payment frequency (DAILY/WEEKLY/MONTHLY). generateStraightLineSchedule/
 * generateLoanSchedule still follow the fixed 30-days/4-weeks-per-month convention
 * (constants/contracts.ts numberOfInstalmentsForTerm) when called with a termMonths-based
 * count. DEPOSIT_INSTALMENT contract creation itself no longer goes through that path —
 * its term is entered directly in weeks (1-24), and WEEKLY/DAILY frequency (no MONTHLY)
 * maps it straight to an instalment count (termWeeks, or termWeeks * 7) — see
 * contractService.ts's runDepositInstalmentTransaction.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { createContract } from '@/lib/services/contractService';
import { generateStraightLineSchedule, generateLoanSchedule } from '@/lib/services/scheduleService';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);

describe('Payment frequency: DAILY/WEEKLY/MONTHLY schedules', () => {
  let branchId: string;
  let adminUserId: string;

  beforeAll(async () => {
    const branch = await prisma.branch.findFirstOrThrow();
    branchId = branch.id;
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } });
    adminUserId = admin.id;
  });

  it('generateStraightLineSchedule produces 4x weekly and 30x daily instalments per month, monthly unchanged', () => {
    const weekly = generateStraightLineSchedule(120000, 6, new Date(2026, 0, 1), 'WEEKLY');
    expect(weekly).toHaveLength(24); // 6 months * 4 weeks
    expect(weekly[0].dueDate.getTime() - new Date(2026, 0, 1).getTime()).toBe(7 * 86400000);

    const daily = generateStraightLineSchedule(120000, 6, new Date(2026, 0, 1), 'DAILY');
    expect(daily).toHaveLength(180); // 6 months * 30 days
    expect(daily[0].dueDate.getTime() - new Date(2026, 0, 1).getTime()).toBe(86400000);

    const monthly = generateStraightLineSchedule(120000, 6, new Date(2026, 0, 1), 'MONTHLY');
    expect(monthly).toHaveLength(6);

    // Every cadence reconciles exactly to the financed amount, remainder absorbed by the last instalment.
    for (const schedule of [weekly, daily, monthly]) {
      expect(schedule.reduce((s, i) => s + i.amountDueMinor, 0)).toBe(120000);
    }
  });

  it('generateLoanSchedule spreads flat interest/principal across the frequency-derived instalment count, total interest unaffected by cadence', () => {
    const weekly = generateLoanSchedule(200000, 2400, 6, new Date(2026, 0, 1), 'WEEKLY');
    const monthly = generateLoanSchedule(200000, 2400, 6, new Date(2026, 0, 1), 'MONTHLY');
    expect(weekly).toHaveLength(24);
    expect(monthly).toHaveLength(6);

    const weeklyTotalInterest = weekly.reduce((s, i) => s + i.interestPortionMinor, 0);
    const monthlyTotalInterest = monthly.reduce((s, i) => s + i.interestPortionMinor, 0);
    expect(weeklyTotalInterest).toBe(monthlyTotalInterest); // same loan duration/rate -> same total interest regardless of collection cadence
  });

  async function makeProduct(label: string) {
    const product = await prisma.product.create({
      data: { sku: `FREQ-SKU-${label}-${runId}`, name: `Freq Phone ${label}`, cashPriceMinor: 100000 },
    });
    return product.id;
  }

  async function makeCustomerAndItem(productId: string, label: string) {
    const customer = await prisma.customer.create({
      data: {
        membershipId: `FREQ-MEM-${label}-${runId}`, firstName: 'Freq', lastName: label,
        phone: `030${runId}${label}`, branchId, createdById: adminUserId,
      },
    });
    const item = await prisma.inventoryItem.create({
      data: { productId, branchId, serialNumber: `IMEI-FREQ-${label}-${runId}` },
    });
    return { customerId: customer.id, inventoryItemId: item.id };
  }

  it('a WEEKLY DEPOSIT_INSTALMENT contract creates one instalment per term week and is stored with paymentFrequency=WEEKLY', async () => {
    const productId = await makeProduct('DEP-WEEKLY');
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'A');
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
      totalPayableMinor: 60000, depositAmountMinor: 30000, termWeeks: 12, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
    });
    expect(contract.paymentFrequency).toBe('WEEKLY');
    expect(contract.termWeeks).toBe(12);

    const instalments = await prisma.instalment.findMany({ where: { contractId: contract.id } });
    expect(instalments).toHaveLength(12);
  });

  it('the same termWeeks produces 7x as many instalments under DAILY as under WEEKLY', async () => {
    const productId = await makeProduct('DEP-BOTH');

    const daily = await makeCustomerAndItem(productId, 'B');
    const dailyContract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: daily.customerId, inventoryItemId: daily.inventoryItemId,
      totalPayableMinor: 40000, depositAmountMinor: 0, termWeeks: 2, paymentFrequency: 'DAILY',
      branchId, createdById: adminUserId,
    });
    const dailyInstalments = await prisma.instalment.findMany({ where: { contractId: dailyContract.id } });
    expect(dailyInstalments).toHaveLength(14); // 2 weeks * 7

    const weekly = await makeCustomerAndItem(productId, 'C');
    const weeklyContract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: weekly.customerId, inventoryItemId: weekly.inventoryItemId,
      totalPayableMinor: 40000, depositAmountMinor: 0, termWeeks: 2, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
    });
    const weeklyInstalments = await prisma.instalment.findMany({ where: { contractId: weeklyContract.id } });
    expect(weeklyInstalments).toHaveLength(2);
  });

  it('creating a DEPOSIT_INSTALMENT contract fails clearly for a frequency other than DAILY/WEEKLY (no MONTHLY cadence for this type)', async () => {
    const productId = await makeProduct('NO-MONTHLY');
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'D');

    await expect(createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
      totalPayableMinor: 80000, depositAmountMinor: 0, termWeeks: 4, paymentFrequency: 'MONTHLY',
      branchId, createdById: adminUserId,
    })).rejects.toThrow(/paymentFrequency must be one of/);
  });
});
