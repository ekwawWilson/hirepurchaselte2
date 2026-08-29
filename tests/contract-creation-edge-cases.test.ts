import { describe, it, expect, vi, beforeAll } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { generateStraightLineSchedule, generateLoanSchedule } from '@/lib/services/scheduleService';
import * as idGenerators from '@/lib/utils/idGenerators';
import { createContract } from '@/lib/services/contractService';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);

describe('Schedule generation: month-end date rollover', () => {
  it('a contract starting Jan 31 does not skip February (plain setMonth() arithmetic would land on Mar 3)', () => {
    const schedule = generateStraightLineSchedule(120000, 12, new Date(2026, 0, 31));
    expect(schedule[0].dueDate.getMonth()).toBe(1); // February, not March
    expect(schedule[0].dueDate.getDate()).toBe(28); // 2026 is not a leap year
    expect(schedule[1].dueDate.getMonth()).toBe(2); // March
    expect(schedule[1].dueDate.getDate()).toBe(31);
  });

  it('clamps into a leap-year February 29 correctly', () => {
    const schedule = generateStraightLineSchedule(12000, 2, new Date(2024, 0, 31));
    expect(schedule[0].dueDate.getMonth()).toBe(1);
    expect(schedule[0].dueDate.getDate()).toBe(29); // 2024 is a leap year
  });

  it('a loan schedule starting on the 30th does not overflow a 30-day month', () => {
    const schedule = generateLoanSchedule(200000, 2400, 6, new Date(2026, 10, 30)); // Nov 30
    expect(schedule[0].dueDate.getMonth()).toBe(11); // December
    expect(schedule[0].dueDate.getDate()).toBe(30);
  });

  it('normal mid-month dates are unaffected', () => {
    const schedule = generateStraightLineSchedule(60000, 3, new Date(2026, 0, 15));
    expect(schedule.map((s) => s.dueDate.getDate())).toEqual([15, 15, 15]);
  });
});

describe('Contract creation: number-collision retry', () => {
  let branchId: string;
  let productId: string;
  let adminUserId: string;

  beforeAll(async () => {
    const branch = await prisma.branch.findFirstOrThrow();
    branchId = branch.id;
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@zple.test' } });
    adminUserId = admin.id;

    const product = await prisma.product.create({
      data: { sku: `EDGE-SKU-${runId}`, name: 'Edge Case Phone', cashPriceMinor: 200000 },
    });
    productId = product.id;

    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'SAVE_TO_OWN', termMonths: 6, depositAmountMinor: 0,
        totalPayableMinor: 180000, instalmentAmountMinor: 30000, createdById: adminUserId,
      },
    });
  });

  async function makeCustomerAndItem(label: string) {
    const customer = await prisma.customer.create({
      data: {
        membershipId: `EDGE-MEM-${label}-${runId}`, firstName: 'Edge', lastName: label,
        phone: `028${runId}${label}`, branchId, createdById: adminUserId,
      },
    });
    const item = await prisma.inventoryItem.create({
      data: { productId, branchId, serialNumber: `IMEI-EDGE-${label}-${runId}` },
    });
    return { customerId: customer.id, inventoryItemId: item.id };
  }

  it('retries with a fresh number when two attempts race to the same generated contractNumber, instead of throwing a raw Prisma error', async () => {
    const a = await makeCustomerAndItem('A');
    const b = await makeCustomerAndItem('B');

    const forcedNumber = `HP-CON-COLLIDE-${runId}`;
    const spy = vi.spyOn(idGenerators, 'generateContractNumber');
    spy.mockResolvedValueOnce(forcedNumber); // consumed by contract A
    spy.mockResolvedValueOnce(forcedNumber); // contract B's first attempt — collides with A
    // third call (B's retry) falls through to the real implementation, spied but not overridden

    const contractA = await createContract({
      contractType: 'SAVE_TO_OWN', customerId: a.customerId, inventoryItemId: a.inventoryItemId,
      termMonths: 6, branchId, createdById: adminUserId,
    });
    expect(contractA.contractNumber).toBe(forcedNumber);

    // Without the retry fix, this would throw an unhandled PrismaClientKnownRequestError (P2002).
    const contractB = await createContract({
      contractType: 'SAVE_TO_OWN', customerId: b.customerId, inventoryItemId: b.inventoryItemId,
      termMonths: 6, branchId, createdById: adminUserId,
    });
    expect(contractB.contractNumber).not.toBe(forcedNumber);
    expect(contractB.id).not.toBe(contractA.id);

    spy.mockRestore();
  });
});
