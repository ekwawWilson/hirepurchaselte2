import { prisma } from '../db/prisma';
import { getDeviceLoanState } from './paymentService';
import { getWorkingDays } from './operatingSettingsService';
import { isWorkingDay } from '../workingDays';

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Charges every ACTIVE DEVICE_LOAN contract 1% (LoanSettings.dailyInterestRateBps,
 * snapshotted per-contract onto Contract.interestRateBps at creation — never
 * re-read live from settings) of its original loan amount (principalMinor)
 * for today, as a Penalty row (reason 'DAILY_LOAN_INTEREST', no instalment) —
 * the same ledger-derived pattern overdueService.applyLatePenalties uses, so
 * it's paid off through the ordinary penalty-allocation mechanism
 * (paymentService.postDeviceLoanPayment) and never needs a separate mutable
 * "accrued interest" counter.
 *
 * Charges one row per day that is:
 *  - A working day — Mon-Fri always, plus whichever weekend days the
 *    business has enabled (Settings > Working days, read live).
 *  - At least `gracePeriodDays` calendar days after the loan's startDate
 *    ("days after loan date", editable in Settings > Loan payment terms —
 *    snapshotted per-contract the same way, onto gracePeriodDays).
 *  - Not already charged. Re-running the same day creates nothing.
 * and only while the principal is still outstanding — once the customer has
 * paid the full loan amount there's no more "loan" to charge 1% of, so
 * accrual stops. Any interest still unpaid at that point remains a separate
 * balance the customer still owes, cleared the normal way.
 *
 * Catches up on missed days: if the server was down when the sweep should
 * have run, the next run also charges every working day since the loan's
 * most recent interest row. A loan with no rows yet is only charged for
 * today, as before. DEFAULTED loans keep accruing (markDefaultedContracts) —
 * defaulting must never make a loan cheaper. Only DAILY_SIMPLE loans: an
 * older FLAT loan's interestRateBps is an annual rate, not a daily one.
 */
export async function accrueDailyLoanInterest(): Promise<number> {
  const now = new Date();
  const today = startOfDay(now);
  const workingDays = await getWorkingDays();

  const contracts = await prisma.contract.findMany({
    where: { contractType: 'DEVICE_LOAN', rateBasis: 'DAILY_SIMPLE', status: { in: ['ACTIVE', 'DEFAULTED'] } },
  });

  let count = 0;
  for (const contract of contracts) {
    if (!contract.principalMinor || !contract.interestRateBps) continue;

    const amountMinor = Math.round((contract.principalMinor * contract.interestRateBps) / 10000);
    if (amountMinor <= 0) continue;

    const graceUntil = new Date(contract.startDate);
    graceUntil.setDate(graceUntil.getDate() + (contract.gracePeriodDays ?? 0));
    const firstChargeableDay = startOfDay(graceUntil);

    const latest = await prisma.penalty.findFirst({
      where: { contractId: contract.id, reason: 'DAILY_LOAN_INTEREST' },
      orderBy: { appliedDate: 'desc' },
    });
    const days: Date[] = [];
    if (!latest) {
      days.push(today);
    } else {
      const day = startOfDay(latest.appliedDate);
      day.setDate(day.getDate() + 1);
      for (; day <= today; day.setDate(day.getDate() + 1)) days.push(new Date(day));
    }
    const chargeable = days.filter((d) => d >= firstChargeableDay && isWorkingDay(d, workingDays));
    if (chargeable.length === 0) continue;

    const state = await getDeviceLoanState(contract.id);
    if (!state.principalOutstanding) continue;

    await prisma.penalty.createMany({
      data: chargeable.map((d) => ({
        contractId: contract.id,
        amountMinor,
        reason: 'DAILY_LOAN_INTEREST',
        appliedDate: d.getTime() === today.getTime() ? now : d,
      })),
    });
    count++;
  }
  return count;
}

