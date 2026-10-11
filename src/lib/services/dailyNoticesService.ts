import { prisma } from '../db/prisma';
import { formatMoney, currencyCode } from '../utils/money';
import { queueSms, deliverQueuedSms } from './smsService';
import { getControlSettings } from './controlSettingsService';
import { sendOwnerSms } from './ownerNotificationService';
import { dailyCashReceivedReport, arrearsAgeingReport } from './reportService';

const DAY_MS = 24 * 60 * 60 * 1000;
const startOfDay = (d: Date) => new Date(new Date(d).setHours(0, 0, 0, 0));

/**
 * Tells a customer the day before their wallet is debited, so the money is
 * there when the debit runs and a debit they have forgotten about does not
 * arrive as a surprise. Only for contracts collected by direct debit on the
 * due date (paymentMethod DIRECT_DEBIT) with an approved mandate; a contract
 * on BOTH is only debited once overdue, and already gets the due-today
 * reminder. Safe to run twice: one notice per contract per day.
 */
export async function sendDirectDebitNotices(now: Date = new Date()): Promise<{ sent: number; skipped: boolean }> {
  if (!(await getControlSettings()).directDebitNoticeEnabled) return { sent: 0, skipped: true };

  const today = startOfDay(now);
  const tomorrow = new Date(today.getTime() + DAY_MS);
  const dueTomorrow = await prisma.instalment.findMany({
    where: {
      dueDate: { gte: tomorrow, lt: new Date(tomorrow.getTime() + DAY_MS) },
      status: { in: ['PENDING', 'PARTIAL'] },
      contract: { status: 'ACTIVE', paymentMethod: 'DIRECT_DEBIT', hubtelPreapproval: { status: 'APPROVED' } },
    },
    select: { contractId: true, amountDueMinor: true, amountPaidMinor: true },
  });

  const owedByContract = new Map<string, number>();
  for (const i of dueTomorrow) {
    owedByContract.set(i.contractId, (owedByContract.get(i.contractId) ?? 0) + i.amountDueMinor - i.amountPaidMinor);
  }

  let sent = 0;
  for (const [contractId, owedMinor] of owedByContract) {
    if (owedMinor <= 0) continue;
    const already = await prisma.smsMessage.findFirst({
      where: { relatedContractId: contractId, templateKey: 'directdebit.notice', createdAt: { gte: today } }, select: { id: true },
    });
    if (already) continue;
    const sms = await queueSms({ contractId, templateKey: 'directdebit.notice', extraVars: { amountDue: formatMoney(owedMinor) } });
    if (!sms) continue;
    await deliverQueuedSms(sms.id);
    sent += 1;
  }
  return { sent, skipped: false };
}

/** The day's figures the owner's evening text is written from. */
export async function ownerDailySummary(now: Date = new Date()) {
  const today = startOfDay(now);
  const [cash, arrears, received, newContracts, needsReview, approvalsWaiting, openAlerts] = await Promise.all([
    dailyCashReceivedReport({}),
    arrearsAgeingReport({}),
    prisma.payment.count({ where: { status: 'SUCCESS', createdAt: { gte: today }, reversesPaymentId: null, entryType: { not: 'WITHDRAWAL' } } }),
    prisma.contract.count({ where: { createdAt: { gte: today } } }),
    prisma.hubtelTransaction.count({ where: { status: 'NEEDS_REVIEW', resolvedAt: null } }),
    prisma.approvalRequest.count({ where: { status: 'PENDING' } }),
    prisma.systemAlert.count({ where: { acknowledgedAt: null, kind: { not: 'PAYMENT_NEEDS_REVIEW' } } }), // those are counted as payments above
  ]);
  return {
    collectedMinor: cash.totalMinor,
    payments: received,
    newContracts,
    overdueMinor: Object.values(arrears.buckets).reduce((s, v) => s + v, 0),
    contractsBehind: new Set(arrears.rows.map((r) => r.contractNumber)).size,
    needsAttention: needsReview + approvalsWaiting + openAlerts,
  };
}

/**
 * One text to the owner each evening: what came in, what was sold, what is
 * overdue, and whether anything is waiting on a person. Short enough to read
 * at a glance; the detail is on the dashboard. Once a day at most, and not
 * at all until an owner number is set (Settings > Controls).
 */
export async function sendOwnerDailySummary(now: Date = new Date()): Promise<boolean> {
  const { dailySummaryEnabled, ownerPhone } = await getControlSettings();
  if (!dailySummaryEnabled || !ownerPhone) return false;

  const already = await prisma.smsMessage.findFirst({
    where: { templateKey: 'owner.daily_summary', createdAt: { gte: startOfDay(now) } }, select: { id: true },
  });
  if (already) return false;

  const s = await ownerDailySummary(now);
  const cur = currencyCode();
  const date = now.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const lines = [
    `${date}: collected ${cur} ${formatMoney(s.collectedMinor)} in ${s.payments} payment${s.payments === 1 ? '' : 's'}.`,
    `New contracts: ${s.newContracts}.`,
    `Overdue: ${cur} ${formatMoney(s.overdueMinor)} on ${s.contractsBehind} contract${s.contractsBehind === 1 ? '' : 's'}.`,
    ...(s.needsAttention > 0 ? [`${s.needsAttention} item${s.needsAttention === 1 ? '' : 's'} need attention on the dashboard.`] : []),
  ];
  return sendOwnerSms('owner.daily_summary', lines.join(' '));
}
