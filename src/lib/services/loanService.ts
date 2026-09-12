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
 * Only charges a contract when:
 *  - Today is a working day — Mon-Fri always, plus whichever weekend days
 *    the business has enabled (Settings > Working days, read live).
 *  - At least `gracePeriodDays` calendar days have passed since the loan's
 *    startDate ("days after loan date", editable in Settings > Loan payment
 *    terms — snapshotted per-contract the same way, onto gracePeriodDays).
 *  - The principal is still outstanding — once the customer has paid the
 *    full loan amount there's no more "loan" to charge 1% of, so accrual
 *    stops. Any interest still unpaid at that point remains a separate
 *    balance the customer still owes, cleared the normal way.
 *  - No row has already been created for this contract today (idempotent,
 *    matching applyLatePenalties's own re-run safety).
 *
 * Must run after markOverdueInstalments/markDefaultedContracts in the daily
 * sweep only in the sense that it's independent of them — DEVICE_LOAN has no
 * instalment schedule at all under this model, so those two never touch it.
 */
export async function accrueDailyLoanInterest(): Promise<number> {
  const now = new Date();
  if (!isWorkingDay(now, await getWorkingDays())) return 0;
  const today = startOfDay(now);

  const contracts = await prisma.contract.findMany({
    where: { contractType: 'DEVICE_LOAN', status: 'ACTIVE' },
  });

  let count = 0;
  for (const contract of contracts) {
    if (!contract.principalMinor || !contract.interestRateBps) continue;

    const graceUntil = new Date(contract.startDate);
    graceUntil.setDate(graceUntil.getDate() + (contract.gracePeriodDays ?? 0));
    if (today < startOfDay(graceUntil)) continue;

    const state = await getDeviceLoanState(contract.id);
    if (!state.principalOutstanding) continue;

    const alreadyToday = await prisma.penalty.findFirst({
      where: { contractId: contract.id, reason: 'DAILY_LOAN_INTEREST', appliedDate: { gte: today } },
    });
    if (alreadyToday) continue;

    const amountMinor = Math.round((contract.principalMinor * contract.interestRateBps) / 10000);
    if (amountMinor <= 0) continue;

    await prisma.penalty.create({
      data: { contractId: contract.id, amountMinor, reason: 'DAILY_LOAN_INTEREST', appliedDate: now },
    });
    count++;
  }
  return count;
}

