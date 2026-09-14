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
  }
}
