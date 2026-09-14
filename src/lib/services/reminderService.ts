import { prisma } from '../db/prisma';
import { formatMoney } from '../utils/money';
import { isWorkingDay } from '../workingDays';
import { getWorkingDays } from './operatingSettingsService';
import { queueSms, deliverQueuedSms } from './smsService';

/**
 * Daily payment reminders to customers — the legacy app's
 * notificationScheduler (checkUpcomingPayments / checkOverduePayments):
 *
 *   due today  one SMS per contract with an instalment falling due today
 *   overdue    one SMS per contract in arrears, repeated at most every
 *              OVERDUE_REMINDER_INTERVAL_DAYS so a customer is reminded,
 *              not harassed
 *
 * Only DEPOSIT_INSTALMENT contracts have a schedule to remind about; Save to
 * Own has nothing due and a Device Loan has no instalments. Nothing is sent
 * on a day the business is closed. Each sweep is safe to run twice: a
 * contract already reminded is skipped, which also makes a server restart or
 * a manual re-run harmless.
 */

export const OVERDUE_REMINDER_INTERVAL_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDABLE_STATUSES = ['ACTIVE', 'DEFAULTED'];

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

async function alreadySent(contractId: string, templateKey: string, since: Date) {
  const found = await prisma.smsMessage.findFirst({
    where: { relatedContractId: contractId, templateKey, createdAt: { gte: since } },
    select: { id: true },
  });
  return found !== null;
}

async function send(contractId: string, templateKey: string, extraVars: Record<string, string>) {
  const sms = await queueSms({ contractId, templateKey, extraVars });
  if (!sms) return false; // template missing/inactive, or no phone number
  await deliverQueuedSms(sms.id);
  return true;
}

export interface ReminderRun {
  skippedClosedDay: boolean;
  sent: number;
  alreadyReminded: number;
}

export async function sendDueTodayReminders(now: Date = new Date()): Promise<ReminderRun> {
  if (!isWorkingDay(now, await getWorkingDays())) return { skippedClosedDay: true, sent: 0, alreadyReminded: 0 };

  const today = startOfDay(now);
  const tomorrow = new Date(today.getTime() + DAY_MS);

  // By due date, not status: the 08:00 sweep has already flipped today's
  // instalments to OVERDUE (their due date, midnight, is before 08:00).
  const due = await prisma.instalment.findMany({
    where: {
      dueDate: { gte: today, lt: tomorrow },
      status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
      contract: { contractType: 'DEPOSIT_INSTALMENT', status: { in: REMINDABLE_STATUSES } },
    },
    select: { contractId: true, amountDueMinor: true, amountPaidMinor: true },
  });

  const owedByContract = new Map<string, number>();
  for (const i of due) {
    owedByContract.set(i.contractId, (owedByContract.get(i.contractId) ?? 0) + i.amountDueMinor - i.amountPaidMinor);
  }

  const run: ReminderRun = { skippedClosedDay: false, sent: 0, alreadyReminded: 0 };
  for (const [contractId, owedMinor] of owedByContract) {
    if (owedMinor <= 0) continue;
    if (await alreadySent(contractId, 'instalment.due_today', today)) { run.alreadyReminded += 1; continue; }
    if (await send(contractId, 'instalment.due_today', { amountDue: formatMoney(owedMinor) })) run.sent += 1;
  }
  return run;
}

export async function sendOverdueReminders(now: Date = new Date()): Promise<ReminderRun> {
  if (!isWorkingDay(now, await getWorkingDays())) return { skippedClosedDay: true, sent: 0, alreadyReminded: 0 };

  const today = startOfDay(now);
  const overdue = await prisma.instalment.findMany({
    // Before today: an instalment due today gets the gentler due-today message instead.
    where: {
      dueDate: { lt: today },
      status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] },
      contract: { contractType: 'DEPOSIT_INSTALMENT', status: { in: REMINDABLE_STATUSES } },
    },
    select: { contractId: true, dueDate: true, amountDueMinor: true, amountPaidMinor: true },
  });

  const byContract = new Map<string, { owedMinor: number; oldestDue: Date }>();
  for (const i of overdue) {
    const entry = byContract.get(i.contractId) ?? { owedMinor: 0, oldestDue: i.dueDate };
    entry.owedMinor += i.amountDueMinor - i.amountPaidMinor;
    if (i.dueDate < entry.oldestDue) entry.oldestDue = i.dueDate;
    byContract.set(i.contractId, entry);
  }

  const since = new Date(today.getTime() - (OVERDUE_REMINDER_INTERVAL_DAYS - 1) * DAY_MS);
  const run: ReminderRun = { skippedClosedDay: false, sent: 0, alreadyReminded: 0 };
  for (const [contractId, { owedMinor, oldestDue }] of byContract) {
    if (owedMinor <= 0) continue;
    if (await alreadySent(contractId, 'instalment.overdue', since)) { run.alreadyReminded += 1; continue; }
    const daysOverdue = Math.max(1, Math.floor((today.getTime() - startOfDay(oldestDue).getTime()) / DAY_MS));
    const sent = await send(contractId, 'instalment.overdue', {
      amountOverdue: formatMoney(owedMinor),
      daysOverdue: String(daysOverdue),
    });
    if (sent) run.sent += 1;
  }
  return run;
}
