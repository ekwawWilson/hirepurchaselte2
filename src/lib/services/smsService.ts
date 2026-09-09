import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { formatMoney, currencyCode } from '../utils/money';
import { getSmsProvider } from './smsProviders';
import { primaryPhone } from './customerService';

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

  // Rendered as one clause (not separate amount/date fields) so each of the three
  // cases below reads as a real sentence: SAVE_TO_OWN's free-form savings (no
  // schedule, no target, no balance to speak of — see contractService.ts),
  // a scheduled contract's next due instalment, and a contract that's already
  // fully paid off. SAVE_TO_OWN is checked first since its balanceMinor is
  // always null, not a real "fully paid" zero.
  const nextDueLine = contract.contractType === 'SAVE_TO_OWN'
    ? 'Deposit any amount, any time, to keep saving toward it.'
    : (contract.balanceMinor ?? 0) <= 0
      ? 'Your contract is fully paid.'
      : nextInstalment
        ? `Next due: ${currencyCode()} ${formatMoney(nextInstalment.amountDueMinor - nextInstalment.amountPaidMinor)} on ${nextInstalment.dueDate.toISOString().slice(0, 10)}.`
        : '';

  const vars: Record<string, string> = {
    customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
    contractNumber: contract.contractNumber,
    amountPaid: payment ? formatMoney(payment.amountMinor) : '',
    outstandingBalance: contract.contractType === 'SAVE_TO_OWN' ? formatMoney(contract.totalPaidMinor) : formatMoney(contract.balanceMinor ?? 0),
    nextDueLine,
    currency: currencyCode(),
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
