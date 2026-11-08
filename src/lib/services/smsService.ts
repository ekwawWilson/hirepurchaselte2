import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { formatMoney, currencyCode } from '../utils/money';
import { getSmsProvider } from './smsProviders';
import { primaryPhone } from './customerService';
import { getOrgSettings } from './orgSettingsService';

type Tx = Prisma.TransactionClient | typeof prisma;

function renderTemplate(body: string, vars: Record<string, string>): string {
  return body.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => vars[key] ?? '');
}

/**
 * Renders and persists an SmsMessage row (status QUEUED) — safe to call inside a
 * DB transaction (e.g. from post_payment) since it's a pure DB write. Actual
 * delivery happens separately via deliverQueuedSms, called only after the
 * transaction that queued it has committed, so an SMS failure can never roll
 * back a posted payment (mission rule).
 */
export async function queueSms(params: {
  contractId: string;
  templateKey: string;
  paymentId?: string;
  /** Per-message values a template may use beyond the standard ones (e.g. a reminder's amountDue). */
  extraVars?: Record<string, string>;
  tx?: Tx;
}) {
  const db = params.tx ?? prisma;

  const template = await db.smsTemplate.findUnique({ where: { key: params.templateKey } });
  if (!template || !template.isActive) return null;

  const contract = await db.contract.findUniqueOrThrow({
    where: { id: params.contractId },
    include: {
      customer: true,
      instalments: { where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } }, orderBy: { instalmentNo: 'asc' }, take: 1 },
    },
  });

  const payment = params.paymentId ? await db.payment.findUnique({ where: { id: params.paymentId } }) : null;
  const nextInstalment = contract.instalments[0];
  // Only fetched for DEVICE_LOAN — it has no balanceMinor/instalments at all,
  // just an accrued-interest-vs-full-amount choice (paymentService.ts).
  // Dynamic import avoids a circular static import — paymentService.ts
  // already imports queueSms/deliverQueuedSms from this file.
  const loanState = contract.contractType === 'DEVICE_LOAN'
    ? await (await import('./paymentService')).getDeviceLoanState(contract.id, db)
    : null;

  // Rendered as one clause (not separate amount/date fields) so each case below
  // reads as a real sentence. SAVE_TO_OWN and DEVICE_LOAN are both checked
  // before the balanceMinor comparison since it's always null for them, not a
  // real "fully paid" zero (contractService.ts).
  const nextDueLine = contract.contractType === 'SAVE_TO_OWN'
    ? 'Deposit any amount, any time, to keep saving toward it.'
    : contract.contractType === 'DEVICE_LOAN'
      ? (loanState && (loanState.principalOutstanding || loanState.accruedInterestMinor > 0)
          ? `Interest owed: ${currencyCode()} ${formatMoney(loanState.accruedInterestMinor)}. Full loan amount: ${currencyCode()} ${formatMoney(loanState.principalMinor)}.`
          : 'Your loan is fully paid.')
      : (contract.balanceMinor ?? 0) <= 0
        ? 'Your contract is fully paid.'
        : nextInstalment
          ? `Next due: ${currencyCode()} ${formatMoney(nextInstalment.amountDueMinor - nextInstalment.amountPaidMinor)} on ${nextInstalment.dueDate.toISOString().slice(0, 10)}.`
          : '';

  const vars: Record<string, string> = {
    customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
    contractNumber: contract.contractNumber,
    amountPaid: payment ? formatMoney(payment.amountMinor) : '',
    outstandingBalance: contract.contractType === 'SAVE_TO_OWN'
      ? formatMoney(contract.totalPaidMinor)
      : contract.contractType === 'DEVICE_LOAN'
        ? formatMoney(loanState?.totalOwedMinor ?? 0)
        : formatMoney(contract.balanceMinor ?? 0),
    nextDueLine,
    currency: currencyCode(),
    companyName: (await getOrgSettings()).companyName,
    ...params.extraVars,
  };

  const body = renderTemplate(template.bodyTemplate, vars);
  const recipient = primaryPhone(contract.customer);
  if (!recipient) return null; // no registered number at all — shouldn't happen (validated at registration), but never crash a payment over it

  return db.smsMessage.create({
    data: {
      recipient,
      templateKey: params.templateKey,
      body,
      relatedPaymentId: params.paymentId,
      relatedContractId: contract.id,
      relatedCustomerId: contract.customerId,
      status: 'QUEUED',
    },
  });
}

/** Texts the customer about something already saved. Never throws: a text must not undo or block what it reports. */
export async function sendContractSms(contractId: string, templateKey: string, extraVars?: Record<string, string>): Promise<boolean> {
  try {
    const sms = await queueSms({ contractId, templateKey, extraVars });
    if (!sms) return false;
    await deliverQueuedSms(sms.id);
    return true;
  } catch (e) {
    console.error(`SMS ${templateKey} for contract ${contractId} could not be sent:`, e);
    return false;
  }
}

/** Texts a customer the password just issued to them, when that message is on. The stored copy is blanked once sent. */
export async function textPortalPassword(customerId: string, password: string): Promise<void> {
  try {
    const template = await prisma.smsTemplate.findUnique({ where: { key: 'customer.portal_password' } });
    if (!template?.isActive) return;
    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    const recipient = primaryPhone(customer);
    if (!recipient) return;
    const { companyName } = await getOrgSettings();
    const body = (p: string) => renderTemplate(template.bodyTemplate, { customerName: `${customer.firstName} ${customer.lastName}`, companyName, password: p });
    const sms = await prisma.smsMessage.create({ data: { recipient, templateKey: template.key, body: body(password), relatedCustomerId: customerId, status: 'QUEUED' } });
    try {
      await deliverQueuedSms(sms.id);
    } finally {
      await prisma.smsMessage.update({ where: { id: sms.id }, data: { body: body('******') } });
    }
  } catch (e) {
    console.error(`The sign-in password for customer ${customerId} could not be texted:`, e);
  }
}

/** Attempts delivery of one already-queued message. Never throws — failures are logged on the row itself. */
export async function deliverQueuedSms(smsMessageId: string): Promise<void> {
  const sms = await prisma.smsMessage.findUnique({ where: { id: smsMessageId } });
  if (!sms || sms.status === 'SENT') return;

  const provider = getSmsProvider();
  try {
    const providerRef = await provider.send(sms.recipient, sms.body);
    await prisma.smsMessage.update({
      where: { id: sms.id },
      data: { status: 'SENT', providerRef, attempts: { increment: 1 }, lastAttemptAt: new Date() },
    });
  } catch (e) {
    await prisma.smsMessage.update({
      where: { id: sms.id },
      data: { status: 'FAILED', attempts: { increment: 1 }, lastAttemptAt: new Date() },
    });
    console.error(`SMS delivery failed for message ${sms.id}:`, e);
    // Raised once however many messages fail; texting the owner about it would
    // only fail too, so this one is seen on the dashboard (alertService.ts).
    const { raiseAlert } = await import('./alertService');
    await raiseAlert({
      kind: 'SMS_FAILING',
      message: `Text messages are failing to send: ${e instanceof Error ? e.message.slice(0, 160) : 'the SMS provider returned an error'}`,
      dedupeKey: 'sms-failing',
    });
  }
}
