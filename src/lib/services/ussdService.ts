import { prisma } from '../db/prisma';
import { formatMoney } from '../utils/money';
import { initiateHubtelPayment } from './hubtelPaymentService';

const SESSION_TTL_MINUTES = 5;

interface UssdContext {
  contractIds?: string[];
  contractId?: string;
  amountMinor?: number;
}

export interface UssdResult {
  message: string;
  continueSession: boolean;
}

async function startSession(sessionId: string, msisdn: string): Promise<UssdResult> {
  const customer = await prisma.customer.findUnique({ where: { phone: msisdn } });
  if (!customer) {
    return { message: 'No HP-Lite account found for this number.', continueSession: false };
  }

  const contracts = await prisma.contract.findMany({
    where: { customerId: customer.id, balanceMinor: { gt: 0 }, status: { in: ['ACTIVE', 'PENDING_DEPOSIT'] } },
    orderBy: { createdAt: 'asc' },
  });
  if (contracts.length === 0) {
    return { message: 'You have no contracts with an outstanding balance.', continueSession: false };
  }

  const expiresAt = new Date(Date.now() + SESSION_TTL_MINUTES * 60_000);

  if (contracts.length > 1) {
    const context: UssdContext = { contractIds: contracts.map((c) => c.id) };
    await prisma.ussdSession.create({
      data: { sessionId, msisdn, state: 'SELECT_CONTRACT', context: JSON.stringify(context), expiresAt },
    });
    const lines = contracts.map((c, i) => `${i + 1}. ${c.contractNumber} Bal GHS${formatMoney(c.balanceMinor)}`);
    return { message: `Select a contract:\n${lines.join('\n')}`, continueSession: true };
  }

  const contract = contracts[0];
  const context: UssdContext = { contractId: contract.id };
  await prisma.ussdSession.create({
    data: { sessionId, msisdn, state: 'ENTER_AMOUNT', contractId: contract.id, context: JSON.stringify(context), expiresAt },
  });
  return {
    message: `${contract.contractNumber}\nBalance: GHS${formatMoney(contract.balanceMinor)}\nEnter amount to pay:`,
    continueSession: true,
  };
}

async function endSession(sessionId: string) {
  await prisma.ussdSession.delete({ where: { id: sessionId } }).catch(() => undefined);
}

/**
 * Advances the USSD menu state machine by one hop. Called once per USSD
 * request/response round-trip — Hubtel (or the mock simulator) re-sends the
 * sessionId and the customer's latest keypad input each time. Session state
 * is a DB-backed row with a TTL rather than an opaque round-tripped token
 * (mission §8.2 asks for persisted sessions with TTL — see docs/00-legacy-study.md §8
 * for why the legacy app's token-based approach isn't what's used here).
 */
export async function handleUssdInput(params: {
  sessionId: string;
  msisdn: string;
  input: string;
  isNewSession: boolean;
}): Promise<UssdResult> {
  const existing = params.isNewSession
    ? null
    : await prisma.ussdSession.findUnique({ where: { sessionId: params.sessionId } });

  if (!existing || existing.expiresAt < new Date()) {
    if (existing) await endSession(existing.id);
    return startSession(params.sessionId, params.msisdn);
  }

  const context: UssdContext = existing.context ? JSON.parse(existing.context) : {};

  switch (existing.state) {
    case 'SELECT_CONTRACT': {
      const idx = parseInt(params.input, 10) - 1;
      const contractIds = context.contractIds ?? [];
      if (Number.isNaN(idx) || idx < 0 || idx >= contractIds.length) {
        await endSession(existing.id);
        return { message: 'Invalid selection. Session ended.', continueSession: false };
      }
      const contract = await prisma.contract.findUniqueOrThrow({ where: { id: contractIds[idx] } });
      await prisma.ussdSession.update({
        where: { id: existing.id },
        data: { state: 'ENTER_AMOUNT', contractId: contract.id, context: JSON.stringify({ contractId: contract.id }) },
      });
      return {
        message: `${contract.contractNumber}\nBalance: GHS${formatMoney(contract.balanceMinor)}\nEnter amount to pay:`,
        continueSession: true,
      };
    }

    case 'ENTER_AMOUNT': {
      const amountGhs = parseFloat(params.input);
      if (Number.isNaN(amountGhs) || amountGhs <= 0) {
        return { message: 'Invalid amount. Enter amount to pay:', continueSession: true };
      }
      const amountMinor = Math.round(amountGhs * 100);
      const contractId = context.contractId as string;
      await prisma.ussdSession.update({
        where: { id: existing.id },
        data: { state: 'CONFIRM', context: JSON.stringify({ contractId, amountMinor }) },
      });
      return { message: `Confirm payment of GHS${formatMoney(amountMinor)}?\n1. Confirm\n2. Cancel`, continueSession: true };
    }

    case 'CONFIRM': {
      if (params.input === '2') {
        await endSession(existing.id);
        return { message: 'Payment cancelled.', continueSession: false };
      }
      if (params.input !== '1') {
        return { message: 'Invalid option.\n1. Confirm\n2. Cancel', continueSession: true };
      }
      const { contractId, amountMinor } = context;
      await endSession(existing.id);
      if (!contractId || !amountMinor) {
        return { message: 'Session error. Please try again.', continueSession: false };
      }
      const txn = await initiateHubtelPayment({ contractId, msisdn: params.msisdn, amountMinor });
      return txn.status === 'SUCCESS'
        ? { message: 'Payment successful! You will receive an SMS confirmation shortly.', continueSession: false }
        : { message: 'Payment failed. Please try again later.', continueSession: false };
    }

    default:
      await endSession(existing.id);
      return { message: 'Session error. Please try again.', continueSession: false };
  }
}

/** Clears expired USSD sessions — run periodically alongside the Hubtel reconciliation sweep. */
export async function pruneExpiredUssdSessions() {
  const result = await prisma.ussdSession.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  return result.count;
}
