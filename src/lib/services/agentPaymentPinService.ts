import { randomInt } from 'crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';

const WRONG_PINS_ALLOWED = 5;
const WRONG_PIN_WINDOW_MS = 60 * 60_000;
// Two agents drawing the same PIN at once is rare; this many in a row is not a clash.
const ISSUE_TRIES = 20;

/** The agent's payment PIN, issued if they have none yet. Six digits, none of them a leading zero, unique to them. */
export async function issueAgentPaymentPin(userId: string): Promise<string> {
  for (let i = 0; i < ISSUE_TRIES; i++) {
    const { paymentPin } = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { paymentPin: true } });
    if (paymentPin) return paymentPin;
    try {
      await prisma.user.updateMany({ where: { id: userId, paymentPin: null }, data: { paymentPin: String(randomInt(100_000, 1_000_000)) } });
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
    }
  }
  throw new Error('Could not issue a payment PIN');
}

/** The active agent this PIN belongs to, if any. */
export async function agentIdForPin(pin: string): Promise<string | undefined> {
  if (!/^\d{6}$/.test(pin)) return undefined;
  const agent = await prisma.user.findFirst({ where: { paymentPin: pin, isActive: true, role: { name: 'AGENT' } }, select: { id: true } });
  return agent?.id;
}

/** Anyone can dial the short code, so a phone typing wrong PINs is stopped for a while. */
export async function agentPinLockedOut(msisdn: string): Promise<boolean> {
  const wrong = await prisma.agentPinFailure.count({ where: { msisdn, createdAt: { gte: new Date(Date.now() - WRONG_PIN_WINDOW_MS) } } });
  return wrong >= WRONG_PINS_ALLOWED;
}

export async function recordWrongAgentPin(msisdn: string): Promise<void> {
  await prisma.agentPinFailure.deleteMany({ where: { msisdn, createdAt: { lt: new Date(Date.now() - WRONG_PIN_WINDOW_MS) } } });
  await prisma.agentPinFailure.create({ data: { msisdn } });
}

export async function clearWrongAgentPins(msisdn: string): Promise<void> {
  await prisma.agentPinFailure.deleteMany({ where: { msisdn } });
}
