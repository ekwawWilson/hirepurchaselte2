import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '../db/prisma';

/**
 * Limits how often a sign-in can be guessed at. Five wrong passwords for one
 * account inside fifteen minutes lock that account's sign-in for fifteen
 * minutes — the right password included, or the lock would only slow a
 * guesser down by one request. A much higher limit per network address
 * catches one source trying a few passwords against many accounts.
 *
 * Counted in the database, not in memory, so a restart or a second server
 * process does not hand out a fresh allowance.
 */
const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
export const MAX_ACCOUNT_FAILURES = 5;
const MAX_ADDRESS_FAILURES = 30;

/**
 * The caller's address as the proxy in front of this app reports it, or null
 * when nothing reliable is known — in which case only the per-account limit
 * applies, rather than every unknown caller sharing one allowance.
 */
function callerAddress(req: NextRequest): string | null {
  const address = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0];
  return address?.trim().slice(0, 64) || null;
}

function keysFor(req: NextRequest, account: string): { key: string; max: number }[] {
  const address = callerAddress(req);
  return [
    { key: account.slice(0, 200), max: MAX_ACCOUNT_FAILURES },
    ...(address ? [{ key: `ip:${address}`, max: MAX_ADDRESS_FAILURES }] : []),
  ];
}

/** A 429 if this sign-in is locked out right now, else null. */
export async function loginLockout(req: NextRequest, account: string): Promise<NextResponse | null> {
  const rows = await prisma.loginThrottle.findMany({
    where: { key: { in: keysFor(req, account).map((k) => k.key) }, lockedUntil: { gt: new Date() } },
  });
  if (rows.length === 0) return null;
  const until = Math.max(...rows.map((r) => r.lockedUntil!.getTime()));
  const minutes = Math.max(1, Math.ceil((until - Date.now()) / 60_000));
  return NextResponse.json(
    { error: `Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` },
    { status: 429, headers: { 'Retry-After': String(minutes * 60) } },
  );
}

export async function recordLoginFailure(req: NextRequest, account: string): Promise<void> {
  const now = new Date();
  for (const { key, max } of keysFor(req, account)) {
    const existing = await prisma.loginThrottle.findUnique({ where: { key } });
    if (!existing || now.getTime() - existing.firstFailureAt.getTime() > WINDOW_MS) {
      await prisma.loginThrottle.upsert({
        where: { key },
        create: { key, failures: 1, firstFailureAt: now },
        update: { failures: 1, firstFailureAt: now, lockedUntil: null },
      });
      continue;
    }
    const row = await prisma.loginThrottle.update({ where: { key }, data: { failures: { increment: 1 } } });
    if (row.failures >= max) {
      await prisma.loginThrottle.update({ where: { key }, data: { lockedUntil: new Date(now.getTime() + LOCK_MS) } });
    }
  }
}

/** A successful sign-in clears the account's count — never the address's. */
export async function clearLoginFailures(account: string): Promise<void> {
  await prisma.loginThrottle.deleteMany({ where: { key: account.slice(0, 200) } });
}

/** Scheduled housekeeping: counts nobody has added to in a day are of no use. */
export async function pruneLoginThrottles(): Promise<number> {
  const { count } = await prisma.loginThrottle.deleteMany({ where: { updatedAt: { lt: new Date(Date.now() - 24 * 3_600_000) } } });
  return count;
}
