/**
 * Which days the business operates on, and the date math that follows from
 * it. Monday-Friday are always working days — only the weekend is
 * configurable (Settings > Working days, see operatingSettingsService.ts).
 *
 * Deliberately pure and DB-free: scheduleService.ts imports this and is
 * itself imported by the contract wizard (a client component, for its
 * schedule preview), so nothing here may touch Prisma. Callers that need the
 * configured value fetch it themselves and pass it in.
 */

export interface WorkingDays {
  saturday: boolean;
  sunday: boolean;
}

/** Mon-Fri only — what every caller falls back to before a row has ever been saved. */
export const DEFAULT_WORKING_DAYS: WorkingDays = { saturday: false, sunday: false };

const SUNDAY = 0;
const SATURDAY = 6;

export function isWorkingDay(date: Date, days: WorkingDays): boolean {
  const day = date.getDay(); // 0 Sun .. 6 Sat
  if (day === SATURDAY) return days.saturday;
  if (day === SUNDAY) return days.sunday;
  return true; // Mon-Fri
}

/**
 * Rolls a non-working date forward to the next working one. Terminates in at
 * most two steps: Mon-Fri are always working, so no configuration can produce
 * a week with no working day in it.
 */
export function rollToWorkingDay(date: Date, days: WorkingDays): Date {
  const d = new Date(date);
  while (!isWorkingDay(d, days)) d.setDate(d.getDate() + 1);
  return d;
}

/**
 * Advances `date` by exactly `n` working days, skipping non-working ones
 * entirely — used for DAILY cadence instead of a plain `+n` calendar-day
 * offset plus a roll, since rolling each of several consecutive non-working
 * dates independently would collapse them onto the same day (e.g. a Saturday
 * and the Sunday right after it both rolling to that same Monday). Walking
 * forward one working day at a time guarantees every instalment lands on a
 * distinct date.
 */
export function addWorkingDays(date: Date, n: number, days: WorkingDays): Date {
  const d = new Date(date);
  let remaining = n;
  while (remaining > 0) {
    d.setDate(d.getDate() + 1);
    if (isWorkingDay(d, days)) remaining--;
  }
  return d;
}
