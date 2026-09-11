/**
 * Instalment schedule generation for all three contract types.
 * Amounts are integer minor units throughout — see docs/00-legacy-study.md §5
 * (Types A/B rounding rule, carried over from the legacy app) and
 * docs/02-loan-maths.md (Type C flat-rate interest, worked example).
 */
import { numberOfInstalmentsForTerm, type PaymentFrequencyName } from '../constants/contracts';

export interface GeneratedInstalment {
  instalmentNo: number;
  dueDate: Date;
  amountDueMinor: number;
  principalPortionMinor: number;
  interestPortionMinor: number;
}

/**
 * Adds calendar months, clamping to the last day of the target month instead
 * of overflowing into the month after it. Plain `setMonth()` arithmetic is
 * broken for any start date on the 29th/30th/31st: e.g. Jan 31 + 1 month
 * lands on Mar 3 (JS rolls the excess days into the next month) instead of
 * Feb 28 — which would silently corrupt a large fraction of real instalment
 * schedules, since most months don't have 31 days.
 */
function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  const targetMonth = d.getMonth() + months;
  d.setMonth(targetMonth, 1); // pin to day 1 first so month-length overflow can't happen
  const daysInTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(date.getDate(), daysInTargetMonth));
  return d;
}

function isWeekend(date: Date): boolean {
  const day = date.getDay(); // 0 Sun .. 6 Sat
  return day === 0 || day === 6;
}

/** Rolls a Saturday/Sunday date forward to the following Monday — no repayment date is ever due on a weekend. */
function rollToWeekday(date: Date): Date {
  const d = new Date(date);
  while (isWeekend(d)) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Advances `date` by exactly `n` business days (Mon-Fri), skipping weekends
 * entirely — used for DAILY cadence instead of a plain `+n` calendar-day
 * offset plus a rollToWeekday, since rolling each of several consecutive
 * weekend dates independently would collapse them onto the same Monday
 * (e.g. a Saturday and the Sunday right after it both rolling to that same
 * Monday). Walking forward one business day at a time guarantees every
 * instalment lands on a distinct weekday.
 */
function addBusinessDays(date: Date, n: number): Date {
  const d = new Date(date);
  let remaining = n;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (!isWeekend(d)) remaining--;
  }
  return d;
}

/**
 * Advances `date` by `n` instalment periods at the given cadence, always
 * landing on a weekday (Mon-Fri) — no contract type's repayment dates fall
 * on a Saturday/Sunday. MONTHLY reuses addMonths's month-end clamping, then
 * rolls forward off a weekend if the clamped date landed on one. WEEKLY's
 * fixed 7-day offset stays on the same weekday as `date` every time, so
 * rolling only ever matters if `date` itself is a weekend. DAILY walks
 * business days directly (see addBusinessDays) rather than rolling each
 * calendar day independently.
 */
function addPeriod(date: Date, paymentFrequency: PaymentFrequencyName, n: number): Date {
  if (paymentFrequency === 'MONTHLY') return rollToWeekday(addMonths(date, n));
  if (paymentFrequency === 'DAILY') return addBusinessDays(date, n);
  const d = new Date(date);
  d.setDate(d.getDate() + n * 7);
  return rollToWeekday(d);
}

/**
 * Straight-line split for Types A (SAVE_TO_OWN) and B (DEPOSIT_INSTALMENT):
 * each instalment rounds UP to the minor unit, and the final instalment
 * absorbs the exact remainder so the total reconciles to the pesewa. The
 * admin-entered `termMonths` is always expressed in months regardless of
 * cadence — `numberOfInstalmentsForTerm` converts it to an actual instalment
 * count for DAILY/WEEKLY collection (see constants/contracts.ts).
 */
export function generateStraightLineSchedule(
  financeAmountMinor: number,
  termMonths: number,
  startDate: Date,
  paymentFrequency: PaymentFrequencyName = 'MONTHLY',
  // The actual instalment count — DEPOSIT_INSTALMENT is priced directly in
  // weeks now (contractService.ts), not looked up from termMonths, so this is
  // always supplied and termMonths itself goes unused whenever it is (kept
  // only so the signature stays uniform with generateLoanSchedule).
  instalmentCountOverride?: number,
): GeneratedInstalment[] {
  if (instalmentCountOverride === undefined && termMonths < 1) throw new Error('termMonths must be at least 1');
  if (financeAmountMinor < 0) throw new Error('financeAmountMinor cannot be negative');

  const count = instalmentCountOverride ?? numberOfInstalmentsForTerm(termMonths, paymentFrequency);
  if (count < 1) throw new Error('instalment count must be at least 1');
  const perInstalment = Math.ceil(financeAmountMinor / count);
  const schedule: GeneratedInstalment[] = [];
  let runningTotal = 0;

  for (let i = 1; i <= count; i++) {
    const amount = i === count ? financeAmountMinor - runningTotal : perInstalment;
    runningTotal += amount;
    schedule.push({
      instalmentNo: i,
      dueDate: addPeriod(startDate, paymentFrequency, i),
      amountDueMinor: amount,
      principalPortionMinor: amount,
      interestPortionMinor: 0,
    });
  }
  return schedule;
}

/**
 * Flat-rate loan schedule for Type C (DEVICE_LOAN): total interest is derived
 * from the loan's duration in months (unaffected by collection cadence — see
 * docs/02-loan-maths.md), then both interest and principal are spread evenly
 * across the actual instalment count for the chosen `paymentFrequency`, each
 * independently rounded up with the final instalment absorbing both remainders.
 */
export function generateLoanSchedule(
  principalMinor: number,
  interestRateBps: number,
  termMonths: number,
  startDate: Date,
  paymentFrequency: PaymentFrequencyName = 'MONTHLY',
  // A negotiated instalment count that overrides the frequency-derived default
  // below — termMonths still drives totalInterestMinor (time-value of money
  // over the loan's real duration), only the split count changes.
  instalmentCountOverride?: number,
): GeneratedInstalment[] {
  if (termMonths < 1) throw new Error('termMonths must be at least 1');
  if (principalMinor < 0) throw new Error('principalMinor cannot be negative');

  const totalInterestMinor = Math.round((principalMinor * interestRateBps * termMonths) / (10000 * 12));

  const count = instalmentCountOverride ?? numberOfInstalmentsForTerm(termMonths, paymentFrequency);
  if (count < 1) throw new Error('instalment count must be at least 1');
  const perInterest = Math.ceil(totalInterestMinor / count);
  const perPrincipal = Math.ceil(principalMinor / count);

  const schedule: GeneratedInstalment[] = [];
  let runningInterest = 0;
  let runningPrincipal = 0;

  for (let i = 1; i <= count; i++) {
    const isLast = i === count;
    const interestPortion = isLast ? totalInterestMinor - runningInterest : perInterest;
    const principalPortion = isLast ? principalMinor - runningPrincipal : perPrincipal;
    runningInterest += interestPortion;
    runningPrincipal += principalPortion;

    schedule.push({
      instalmentNo: i,
      dueDate: addPeriod(startDate, paymentFrequency, i),
      amountDueMinor: interestPortion + principalPortion,
      principalPortionMinor: principalPortion,
      interestPortionMinor: interestPortion,
    });
  }
  return schedule;
}

/** Back-solves principal from a price chart's (totalPayable, rate, term) so admins only ever enter totalPayable. */
export function derivePrincipalFromTotalPayable(totalPayableMinor: number, interestRateBps: number, termMonths: number): number {
  const factor = 1 + (interestRateBps * termMonths) / (10000 * 12);
  return Math.round(totalPayableMinor / factor);
}
