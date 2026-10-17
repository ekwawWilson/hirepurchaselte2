import { prisma } from '../db/prisma';
import { amountOwedNow } from './paymentService';
import { phoneVariants } from './hubtelClient';

/** The smallest payment taken — below this a mobile money charge costs more than it is worth. */
export const MIN_PAYMENT_MINOR = 100;
/** Save to Own has nothing owed to cap at; one payment of more than this is far more likely a slip of the finger. */
export const MAX_SAVINGS_PAYMENT_MINOR = 2_000_000;
/** How long a mobile money prompt is treated as still waiting on the customer (Hubtel's own status-check threshold). */
export const PROMPT_WAIT_MINUTES = 5;

const cedis = (minor: number) => `GHS ${(minor / 100).toFixed(2)}`;

/**
 * Reads an amount in cedis typed by a person — a USSD keypad, a form — and
 * returns pesewas, or null unless it is plainly a number: digits, with at
 * most two decimal places. "50abc", "1e6" or "0.001" are refused rather
 * than guessed at.
 */
export function parseCedis(input: string): number | null {
  const text = input.trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(text)) return null;
  return Math.round(parseFloat(text) * 100);
}

/**
 * Why `amountMinor` may not be paid on this contract right now, or null if
 * it may: at least the minimum, and never more than is owed (late-payment
 * charges included). Asked before any payment starts — at the counter, by
 * USSD, in the portal, by a staff prompt — never when recording money a
 * customer has already paid.
 */
export async function paymentAmountProblem(contractId: string, amountMinor: number): Promise<string | null> {
  if (!Number.isInteger(amountMinor) || amountMinor < MIN_PAYMENT_MINOR) return `The smallest payment is ${cedis(MIN_PAYMENT_MINOR)}`;
  const owed = await amountOwedNow(contractId);
  if (owed === null) {
    return amountMinor > MAX_SAVINGS_PAYMENT_MINOR ? `One payment can be at most ${cedis(MAX_SAVINGS_PAYMENT_MINOR)}` : null;
  }
  if (owed <= 0) return 'Nothing is owed on this contract';
  return amountMinor > owed ? `That is more than is owed. Pay at most ${cedis(owed)}` : null;
}

/**
 * A mobile money prompt already waiting on this phone for this contract —
 * sent in the last few minutes and not yet answered. A second one now could
 * see the customer approve both and pay twice.
 */
export async function waitingPromptProblem(contractId: string, msisdn: string): Promise<string | null> {
  const variants = phoneVariants(msisdn);
  const waiting = await prisma.hubtelTransaction.findFirst({
    where: {
      contractId, channel: 'USSD', status: 'PENDING', msisdn: { in: variants },
      createdAt: { gte: new Date(Date.now() - PROMPT_WAIT_MINUTES * 60_000) },
    },
    select: { id: true },
  });
  return waiting
    ? `A payment request is already waiting on ${msisdn}. Approve or decline it on the phone first, or try again in ${PROMPT_WAIT_MINUTES} minutes.`
    : null;
}
