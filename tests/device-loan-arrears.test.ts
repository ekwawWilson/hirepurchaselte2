/**
 * DEVICE_LOAN has no instalments, so its arrears are measured in unpaid
 * days of interest: it defaults once interest is left unpaid past the
 * threshold (overdueService.markDefaultedContracts), cures when that
 * interest is paid, and the accrual sweep catches up on days it missed
 * (loanService.accrueDailyLoanInterest).
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { createContract } from '@/lib/services/contractService';
import { postDeviceLoanPayment } from '@/lib/services/paymentService';
import { markDefaultedContracts } from '@/lib/services/overdueService';
import { accrueDailyLoanInterest } from '@/lib/services/loanService';
import { getOperatingSettings, updateOperatingSettings } from '@/lib/services/operatingSettingsService';
import { DEFAULT_THRESHOLD_DAYS } from '@/lib/constants/contracts';
import { enableOptionalContractTypes } from './helpers';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
const DAY_MS = 24 * 60 * 60 * 1000;

// Save to Own and Device Loan must be activated before they can be created.
beforeAll(enableOptionalContractTypes);

describe('DEVICE_LOAN arrears', () => {
  let branchId: string;
  let adminUserId: string;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow()).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function makeLoan(opts: { startDate?: Date } = {}) {
    counter += 1;
    const customer = await prisma.customer.create({
      data: {
        membershipId: `DLA-${runId}-${counter}`, firstName: 'Loan', lastName: 'Arrears',
        phone: `028${runId}${counter}`, branchId, createdById: adminUserId,
      },
    });
    return createContract({
      contractType: 'DEVICE_LOAN', customerId: customer.id, branchId, createdById: adminUserId,
      loanAmountMinor: 100000, startDate: opts.startDate,
    });
  }

  it('defaults a loan with interest unpaid past the threshold, and paying that interest cures it', async () => {
    const loan = await makeLoan();
    const fresh = await makeLoan();
    await prisma.penalty.create({
      data: { contractId: loan.id, amountMinor: 1000, reason: 'DAILY_LOAN_INTEREST', appliedDate: new Date(Date.now() - (DEFAULT_THRESHOLD_DAYS + 5) * DAY_MS) },
    });
    await prisma.penalty.create({
      data: { contractId: fresh.id, amountMinor: 1000, reason: 'DAILY_LOAN_INTEREST', appliedDate: new Date() },
    });

    await markDefaultedContracts();

    const defaulted = await prisma.contract.findUniqueOrThrow({ where: { id: loan.id } });
    expect(defaulted.status).toBe('DEFAULTED');
    expect(defaulted.defaultedAt).not.toBeNull();
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe('ACTIVE');

    await postDeviceLoanPayment({ contractId: loan.id, option: 'INTEREST', amountMinor: 1000, channel: 'CASH', createdById: adminUserId });
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe('ACTIVE');
  });

  it('the accrual sweep charges every working day it missed since the last interest row, once', async () => {
    const previous = await getOperatingSettings();
    await updateOperatingSettings({ worksSaturday: false, worksSunday: false, acceptsPaymentsOnClosedDays: true, updatedById: adminUserId });
    try {
      // Only Date is faked — Prisma's own timers must keep working.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(2026, 8, 2, 10, 0)); // Wednesday 2 Sep 2026

      const loan = await makeLoan({ startDate: new Date(2026, 7, 24, 9, 0) }); // Mon 24 Aug
      // Last charged Friday 28 Aug; the server then missed Mon 31 Aug and Tue 1 Sep.
      await prisma.penalty.create({
        data: { contractId: loan.id, amountMinor: 1000, reason: 'DAILY_LOAN_INTEREST', appliedDate: new Date(2026, 7, 28, 8, 0) },
      });

      await accrueDailyLoanInterest();
      await accrueDailyLoanInterest(); // a second run the same day adds nothing

      const rows = await prisma.penalty.findMany({
        where: { contractId: loan.id, reason: 'DAILY_LOAN_INTEREST' },
        orderBy: { appliedDate: 'asc' },
      });
      // Fri 28 Aug, then Mon 31, Tue 1, Wed 2 — the weekend skipped.
      expect(rows.map((r) => r.appliedDate.getDate())).toEqual([28, 31, 1, 2]);
    } finally {
      vi.useRealTimers();
      await updateOperatingSettings({ ...previous, updatedById: adminUserId });
    }
  });
});
