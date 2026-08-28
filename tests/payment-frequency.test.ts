/**
 * Coverage for payment frequency (DAILY/WEEKLY/MONTHLY): each contract type
 * pays "based on the number of months (period) selected and payment
 * frequency" — the admin prices each (product, contractType, termMonths,
 * paymentFrequency) combo separately (docs/01-plan.md), and the schedule's
 * instalment count/spacing follows the fixed 30-days/4-weeks-per-month
 * convention (constants/contracts.ts numberOfInstalmentsForTerm).
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
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hplite.test' } });
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

  it('a WEEKLY-priced DEPOSIT_INSTALMENT contract creates 4x weekly instalments and is stored with paymentFrequency=WEEKLY', async () => {
    const productId = await makeProduct('DEP-WEEKLY');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 3, paymentFrequency: 'WEEKLY', depositAmountMinor: 30000,
        totalPayableMinor: 60000, instalmentAmountMinor: 2500, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'A');
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId, termMonths: 3, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
    });
    expect(contract.paymentFrequency).toBe('WEEKLY');

    const instalments = await prisma.instalment.findMany({ where: { contractId: contract.id } });
    expect(instalments).toHaveLength(12); // 3 months * 4 weeks
  });

  it('a distinct MONTHLY entry for the same product/type/term is unaffected by the WEEKLY one (frequency is part of the price chart key)', async () => {
    const productId = await makeProduct('DEP-BOTH');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 2, paymentFrequency: 'DAILY', depositAmountMinor: 0,
        totalPayableMinor: 40000, instalmentAmountMinor: 700, createdById: adminUserId,
      },
    });
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 2, paymentFrequency: 'MONTHLY', depositAmountMinor: 0,
        totalPayableMinor: 40000, instalmentAmountMinor: 20000, createdById: adminUserId,
      },
    });

    const daily = await makeCustomerAndItem(productId, 'B');
    const dailyContract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: daily.customerId, inventoryItemId: daily.inventoryItemId,
      termMonths: 2, paymentFrequency: 'DAILY', branchId, createdById: adminUserId,
    });
    const dailyInstalments = await prisma.instalment.findMany({ where: { contractId: dailyContract.id } });
    expect(dailyInstalments).toHaveLength(60); // 2 months * 30 days

    const monthly = await makeCustomerAndItem(productId, 'C');
    const monthlyContract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: monthly.customerId, inventoryItemId: monthly.inventoryItemId,
      termMonths: 2, paymentFrequency: 'MONTHLY', branchId, createdById: adminUserId,
    });
    const monthlyInstalments = await prisma.instalment.findMany({ where: { contractId: monthlyContract.id } });
    expect(monthlyInstalments).toHaveLength(2);
  });

  it('creating a contract fails clearly when no price chart entry exists for the requested frequency', async () => {
    const productId = await makeProduct('NO-ENTRY');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'SAVE_TO_OWN', termMonths: 4, paymentFrequency: 'MONTHLY', depositAmountMinor: 0,
        totalPayableMinor: 80000, instalmentAmountMinor: 20000, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'D');

    await expect(createContract({
      contractType: 'SAVE_TO_OWN', customerId, inventoryItemId, termMonths: 4, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
    })).rejects.toThrow(/No active price chart entry/);
  });
});
