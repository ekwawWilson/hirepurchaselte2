import { prisma } from '../db/prisma';
import { ledgerBalance } from '../services/agentLedgerService';
import { logAudit } from '../services/auditService';
import { primaryPhone } from '../services/customerService';
import { getOrgSettings } from '../services/orgSettingsService';
import { MIN_PAYMENT_MINOR, paymentAmountProblem } from '../services/paymentLimitsService';
import { postPayment } from '../services/paymentService';
import { deliverQueuedSms } from '../services/smsService';
import { unlockPeriodLabel } from '../constants/temporaryUnlock';
import { formatMoney } from '../utils/money';
import { generateTransactionRef } from '../utils/idGenerators';
import { lockMomentAfter } from './decide';
import { notifyPayTrigger } from './notify';
import { getPayTriggerSettings, unlockTiersOf } from './settings';

/**
 * Temporary unlock: a customer whose Device Financing phone has locked pays a
 * share of what is overdue (a tier in Settings > PayTrigger) and the phone
 * opens for that tier's time. When the time is up it locks again, unless all
 * that is overdue has been paid, which puts it back on its normal schedule.
 *
 * Only the lock date moves (decide.ts), so the phone locks itself at the end
 * of the window, online or offline. Started from the short code, the app or
 * by office staff taking cash; opened only once the money has come in.
 * Overdue means instalments: late charges never keep a phone locked.
 */

export class TemporaryUnlockError extends Error {}

export type UnlockChannel = 'USSD' | 'APP' | 'STAFF';

export interface UnlockOption {
  percent: number;
  hours: number;
  /** "1 day", "12 hours". */
  period: string;
  amountMinor: number;
}

export interface TemporaryUnlockOffer {
  /** Whether a tier can be bought now. When false, `message` says why. */
  available: boolean;
  message: string | null;
  overdueMinor: number;
  options: UnlockOption[];
  /** The end of a window already running. */
  activeUntil: Date | null;
  usesLeft: number;
}

const cedis = (minor: number) => `GHS ${formatMoney(minor)}`;

/** Unlocks actually paid for: a reversed payment takes its unlock with it. */
async function paidUnlocks(contractId: string) {
  const rows = await prisma.payTriggerTemporaryUnlock.findMany({ where: { contractId, status: 'APPLIED' } });
  if (rows.length === 0) return [];
  const standing = await prisma.payment.findMany({
    where: { id: { in: rows.map((r) => r.paymentId!) }, status: 'SUCCESS', reversedById: null },
    select: { id: true },
  });
  const ids = new Set(standing.map((p) => p.id));
  return rows.filter((r) => ids.has(r.paymentId!));
}

/** The end of the window running on this contract, or null. */
export async function temporaryUnlockUntil(contractId: string, now: Date = new Date()): Promise<Date | null> {
  const ends = (await paidUnlocks(contractId)).map((r) => r.expiresAt!.getTime()).filter((t) => t > now.getTime());
  return ends.length > 0 ? new Date(Math.max(...ends)) : null;
}

/**
 * What this customer can do about a locked phone right now. Null when
 * temporary unlock has nothing to say: the feature is off, it is not a
 * Device Financing contract on a switched-on phone, nothing is overdue, or
 * the phone has not reached its lock date.
 */
export async function getTemporaryUnlockOffer(contractId: string, now: Date = new Date()): Promise<TemporaryUnlockOffer | null> {
  const settings = await getPayTriggerSettings();
  if (!settings.temporaryUnlockEnabled) return null;
  const contract = await prisma.contract.findUnique({
    where: { id: contractId },
    select: {
      contractType: true, status: true, gracePeriodDays: true,
      instalments: { where: { status: { not: 'PAID' } }, orderBy: { instalmentNo: 'asc' }, select: { dueDate: true, amountDueMinor: true, amountPaidMinor: true } },
      createdBy: { select: { role: { select: { name: true } } } },
      agentDepositLedger: { select: { amountOwedMinor: true, amountRemittedMinor: true, commissionPaidMinor: true } },
    },
  });
  if (!contract || contract.contractType !== 'DEVICE_FINANCING' || !['ACTIVE', 'DEFAULTED'].includes(contract.status)) return null;
  const device = await prisma.payTriggerDevice.findUnique({ where: { contractId }, select: { enrollmentStatus: true } });
  if (device?.enrollmentStatus !== 'ACTIVE') return null;

  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const overdue = contract.instalments.filter((i) => i.dueDate < startOfToday && i.amountPaidMinor < i.amountDueMinor);
  const overdueMinor = overdue.reduce((s, i) => s + i.amountDueMinor - i.amountPaidMinor, 0);
  if (overdueMinor <= 0) return null;

  const paid = await paidUnlocks(contractId);
  const running = paid.map((r) => r.expiresAt!.getTime()).filter((t) => t > now.getTime());
  const activeUntil = running.length > 0 ? new Date(Math.max(...running)) : null;
  const lockedSince = lockMomentAfter(overdue[0].dueDate, contract.gracePeriodDays + settings.lockAfterOverdueDays);
  if (contract.status !== 'DEFAULTED' && lockedSince > now && !activeUntil) return null;

  // Uses since this stretch of arrears began: clearing the arrears starts the count afresh.
  const used = paid.filter((r) => r.activatedAt! >= overdue[0].dueDate).length;
  const usesLeft = Math.max(0, settings.temporaryUnlockMaxUses - used);
  const closed = (message: string): TemporaryUnlockOffer => ({ available: false, message, overdueMinor, options: [], activeUntil, usesLeft });

  // The agent's deposit hold outranks any window: paying here would not open it.
  if (settings.lockOnUnpaidAgentDeposit && contract.createdBy.role.name === 'AGENT') {
    const owed = contract.agentDepositLedger ? ledgerBalance(contract.agentDepositLedger) : null;
    if (owed === null || owed > 0) return closed('Your phone is held until your agent finishes registering your payment. Please contact your agent.');
  }
  if (usesLeft === 0) return closed(`You have used all your temporary unlocks. Pay the full overdue amount of ${cedis(overdueMinor)} to open your phone.`);

  const options = unlockTiersOf(settings)
    .map((t) => ({ percent: t.percent, hours: t.hours, period: unlockPeriodLabel(t.hours), amountMinor: Math.ceil((overdueMinor * t.percent) / 100) }))
    .filter((o) => o.amountMinor >= MIN_PAYMENT_MINOR && o.amountMinor < overdueMinor);
  if (options.length === 0) return closed(`Pay the full overdue amount of ${cedis(overdueMinor)} to open your phone.`);
  return { available: true, message: null, overdueMinor, options, activeUntil, usesLeft };
}

/**
 * Records that the customer has chosen a tier, before any money moves, so a
 * payment that settles at once still finds it. Nothing opens until
 * applyTemporaryUnlock. The amount comes from the server's own figures;
 * `expectedAmountMinor` refuses it if they moved since the customer saw them.
 */
export async function requestTemporaryUnlock(params: {
  contractId: string; percent: number; channel: UnlockChannel; clientReference?: string; requestedById?: string; expectedAmountMinor?: number;
}) {
  const offer = await getTemporaryUnlockOffer(params.contractId);
  if (!offer) throw new TemporaryUnlockError('Temporary unlock is not available on this contract right now.');
  if (!offer.available) throw new TemporaryUnlockError(offer.message ?? 'Temporary unlock is not available right now.');
  const option = offer.options.find((o) => o.percent === params.percent);
  if (!option) throw new TemporaryUnlockError('That option is no longer available. Please choose again.');
  if (params.expectedAmountMinor !== undefined && params.expectedAmountMinor !== option.amountMinor) {
    throw new TemporaryUnlockError('The amount overdue has changed. Please start again.');
  }
  const problem = await paymentAmountProblem(params.contractId, option.amountMinor);
  if (problem) throw new TemporaryUnlockError(problem);

  const clientReference = params.clientReference ?? generateTransactionRef();
  // The same USSD session confirming twice is one request.
  await prisma.payTriggerTemporaryUnlock.upsert({
    where: { clientReference },
    create: {
      contractId: params.contractId, percent: option.percent, hours: option.hours, overdueMinor: offer.overdueMinor, amountMinor: option.amountMinor,
      channel: params.channel, clientReference, requestedById: params.requestedById ?? null,
    },
    update: {},
  });
  return { clientReference, option };
}

/**
 * The money has come in: opens the phone. Called with every settled mobile
 * money charge, most of which are not unlocks, and never throws: the payment
 * is already recorded and must stay so. A window already running is only
 * ever lengthened.
 */
export async function applyTemporaryUnlock(clientReference: string, paymentId: string): Promise<void> {
  try {
    const row = await prisma.payTriggerTemporaryUnlock.findUnique({ where: { clientReference } });
    if (!row || row.status !== 'PENDING') return;
    const now = new Date();
    const running = await temporaryUnlockUntil(row.contractId, now);
    const end = now.getTime() + row.hours * 3_600_000;
    const expiresAt = running && running.getTime() > end ? running : new Date(end);
    // Claimed on PENDING, so a callback and the status sweep cannot both apply it.
    const claimed = await prisma.payTriggerTemporaryUnlock.updateMany({
      where: { id: row.id, status: 'PENDING' },
      data: { status: 'APPLIED', paymentId, activatedAt: now, expiresAt },
    });
    if (claimed.count === 0) return;
    await logAudit({
      userId: row.requestedById, action: 'TEMPORARY_UNLOCK', entityType: 'Contract', entityId: row.contractId,
      newValues: { percent: row.percent, hours: row.hours, amountMinor: row.amountMinor, overdueMinor: row.overdueMinor, channel: row.channel, expiresAt },
    });
    notifyPayTrigger(row.contractId, 'PAYMENT', 'DEVICE_FINANCING');
    await tellCustomer(row.contractId, expiresAt, now);
  } catch (e) {
    console.error('[paytrigger] temporary unlock could not be applied:', e instanceof Error ? e.message : e);
  }
}

/** Ghana keeps UTC all year. "14 Nov, 14:30". */
const whenLabel = (d: Date) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }).format(d);

async function tellCustomer(contractId: string, expiresAt: Date, now: Date) {
  const contract = await prisma.contract.findUniqueOrThrow({
    where: { id: contractId },
    select: {
      customerId: true, customer: { select: { firstName: true, phone: true, phone2: true, phone3: true } },
      instalments: { where: { status: { not: 'PAID' }, dueDate: { lt: now } }, select: { amountDueMinor: true, amountPaidMinor: true } },
    },
  });
  const number = primaryPhone(contract.customer);
  if (!number) return;
  const left = contract.instalments.reduce((s, i) => s + i.amountDueMinor - i.amountPaidMinor, 0);
  const { companyName } = await getOrgSettings();
  const body = `Hi ${contract.customer.firstName}, your phone is open until ${whenLabel(expiresAt)}. Pay the remaining ${cedis(left)} overdue before then or it will lock again. ${companyName}`;
  const sms = await prisma.smsMessage.create({ data: { recipient: number, templateKey: 'paytrigger.temporary_unlock', body, relatedContractId: contractId, relatedCustomerId: contract.customerId, status: 'QUEUED' } });
  await deliverQueuedSms(sms.id);
}

/** Office staff taking cash for a tier: the payment is recorded and the phone opened together. */
export async function takeCashForTemporaryUnlock(params: { contractId: string; percent: number; userId: string }) {
  const { clientReference, option } = await requestTemporaryUnlock({ contractId: params.contractId, percent: params.percent, channel: 'STAFF', requestedById: params.userId });
  const result = await postPayment({
    contractId: params.contractId, amountMinor: option.amountMinor, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH',
    transactionRef: clientReference, createdById: params.userId, notes: `Temporary unlock: ${option.percent}% of the overdue amount, open ${option.period}`,
  });
  await applyTemporaryUnlock(clientReference, result.payment.id);
  return { payment: result.payment, option };
}
