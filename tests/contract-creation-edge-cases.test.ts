import { describe, it, expect, vi, beforeAll } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { generateStraightLineSchedule, generateLoanSchedule } from '@/lib/services/scheduleService';
import * as idGenerators from '@/lib/utils/idGenerators';
import { createContract } from '@/lib/services/contractService';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);

describe('Schedule generation: month-end date rollover', () => {
  // 2025: Jan 31 + 1/2 months clamps to Feb 28 (Fri) / Mar 31 (Mon) — both
  // weekdays, so this test isolates the month-end clamp itself, undisturbed
  // by the weekday-rolling covered separately below.
  it('a contract starting Jan 31 does not skip February (plain setMonth() arithmetic would land on Mar 3)', () => {
    const schedule = generateStraightLineSchedule(120000, 12, new Date(2025, 0, 31));
    expect(schedule[0].dueDate.getMonth()).toBe(1); // February, not March
    expect(schedule[0].dueDate.getDate()).toBe(28); // 2025 is not a leap year
    expect(schedule[1].dueDate.getMonth()).toBe(2); // March
    expect(schedule[1].dueDate.getDate()).toBe(31);
  });

  it('clamps into a leap-year February 29 correctly', () => {
    const schedule = generateStraightLineSchedule(12000, 2, new Date(2024, 0, 31));
    expect(schedule[0].dueDate.getMonth()).toBe(1);
    expect(schedule[0].dueDate.getDate()).toBe(29); // 2024 is a leap year, and Feb 29 2024 is a Thursday
  });

  it('a loan schedule starting on the 30th does not overflow a 30-day month', () => {
    const schedule = generateLoanSchedule(200000, 2400, 6, new Date(2026, 10, 30)); // Nov 30 2026 -> Dec 30 2026, a Wednesday
    expect(schedule[0].dueDate.getMonth()).toBe(11); // December
    expect(schedule[0].dueDate.getDate()).toBe(30);
  });

  it('normal mid-month dates are unaffected', () => {
    // 2027: Jan 15 + 1/2/3 months lands on Feb 15 (Mon), Mar 15 (Mon), Apr 15 (Thu) — all weekdays.
    const schedule = generateStraightLineSchedule(60000, 3, new Date(2027, 0, 15));
    expect(schedule.map((s) => s.dueDate.getDate())).toEqual([15, 15, 15]);
  });
});

describe('Schedule generation: repayment dates never fall on a weekend', () => {
  it('a monthly due date that clamps onto a weekend rolls forward to the following Monday', () => {
    // Jan 31 2026 + 1 month clamps to Feb 28 2026, a Saturday.
    const schedule = generateStraightLineSchedule(120000, 1, new Date(2026, 0, 31));
    expect(schedule[0].dueDate.getDay()).toBe(1); // Monday
    expect(schedule[0].dueDate.getFullYear()).toBe(2026);
    expect(schedule[0].dueDate.getMonth()).toBe(2); // March
    expect(schedule[0].dueDate.getDate()).toBe(2);
  });

  it('a DAILY schedule skips weekends entirely — every instalment lands on a distinct weekday, never landing two on the same day', () => {
    // Jan 1 2026 is a Thursday: business days 1-5 are Fri 2, Mon 5, Tue 6, Wed 7, Thu 8 (Sat 3/Sun 4 skipped).
    const schedule = generateStraightLineSchedule(50000, 1, new Date(2026, 0, 1), 'DAILY', 5);
    const dates = schedule.map((s) => s.dueDate);
    expect(dates.every((d) => d.getDay() !== 0 && d.getDay() !== 6)).toBe(true);
    expect(new Set(dates.map((d) => d.getTime())).size).toBe(5); // no two instalments collide on the same day
    expect(dates.map((d) => d.getDate())).toEqual([2, 5, 6, 7, 8]);
  });

  it('a WEEKLY schedule starting on a weekend still lands every instalment on the same following Monday, 7 days apart', () => {
    // Jan 3 2026 is a Saturday: week 1 (+7d) is Jan 10, also a Saturday -> rolls to Mon Jan 12.
    // Week 2 (+14d) is Jan 17, also a Saturday -> rolls to Mon Jan 19 — still exactly 7 days later.
    const schedule = generateStraightLineSchedule(20000, 1, new Date(2026, 0, 3), 'WEEKLY', 2);
    expect(schedule[0].dueDate.getDay()).toBe(1);
    expect(schedule[0].dueDate.getDate()).toBe(12);
    expect(schedule[1].dueDate.getDay()).toBe(1);
    expect(schedule[1].dueDate.getDate()).toBe(19);
  });
});

describe('Contract creation: number-collision retry', () => {
  let branchId: string;
  let adminUserId: string;

  beforeAll(async () => {
    const branch = await prisma.branch.findFirstOrThrow();
    branchId = branch.id;
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@zple.test' } });
    adminUserId = admin.id;
  });

  // SAVE_TO_OWN needs no product/price chart entry/inventory item at all
  // (contractService.ts) — the simplest vehicle for a test that's only about
  // generateContractNumber's own retry logic, not contract-type specifics.
  async function makeCustomer(label: string) {
    const customer = await prisma.customer.create({
      data: {
        membershipId: `EDGE-MEM-${label}-${runId}`, firstName: 'Edge', lastName: label,
        phone: `028${runId}${label}`, branchId, createdById: adminUserId,
      },
    });
    return customer.id;
  }

  it('retries with a fresh number when two attempts race to the same generated contractNumber, instead of throwing a raw Prisma error', async () => {
    const customerIdA = await makeCustomer('A');
    const customerIdB = await makeCustomer('B');

    const forcedNumber = `HP-CON-COLLIDE-${runId}`;
    const spy = vi.spyOn(idGenerators, 'generateContractNumber');
    spy.mockResolvedValueOnce(forcedNumber); // consumed by contract A
    spy.mockResolvedValueOnce(forcedNumber); // contract B's first attempt — collides with A
    // third call (B's retry) falls through to the real implementation, spied but not overridden

    const contractA = await createContract({
      contractType: 'SAVE_TO_OWN', customerId: customerIdA, branchId, createdById: adminUserId,
    });
    expect(contractA.contractNumber).toBe(forcedNumber);

    // Without the retry fix, this would throw an unhandled PrismaClientKnownRequestError (P2002).
    const contractB = await createContract({
      contractType: 'SAVE_TO_OWN', customerId: customerIdB, branchId, createdById: adminUserId,
    });
    expect(contractB.contractNumber).not.toBe(forcedNumber);
    expect(contractB.id).not.toBe(contractA.id);

    spy.mockRestore();
  });
});
