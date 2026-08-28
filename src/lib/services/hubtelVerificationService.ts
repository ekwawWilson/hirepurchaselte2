import { prisma } from '../db/prisma';

export interface VerifyResult {
  verified: boolean;
  accountName: string | null;
  message: string;
}

// In-memory, per-process rate limit + cache — this is a UX sanity-check (catch a
// mistyped digit before relying on the number), not a financial record, so
// ephemeral state is fine. Mirrors salesinventoryapp's Hubtel Verification API
// usage: 30 lookups/5min per user, 5-minute result cache.
const RATE_LIMIT_WINDOW_MS = 5 * 60_000;
const RATE_LIMIT_MAX = 30;
const CACHE_TTL_MS = 5 * 60_000;

const rateLimitLog = new Map<string, number[]>();
const cache = new Map<string, { result: VerifyResult; expiresAt: number }>();

function isRateLimited(userId: string): boolean {
  const now = Date.now();
  const timestamps = (rateLimitLog.get(userId) ?? []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  rateLimitLog.set(userId, timestamps);
  return timestamps.length >= RATE_LIMIT_MAX;
}

function recordAttempt(userId: string) {
  const timestamps = rateLimitLog.get(userId) ?? [];
  timestamps.push(Date.now());
  rateLimitLog.set(userId, timestamps);
}

/**
 * Confirms a phone number is a real, currently-registered mobile money wallet
 * and returns the account holder's name — a typo/sanity check before relying on
 * a number for SMS or a direct-debit mandate, never a blocking gate: this always
 * resolves (fails open) rather than throwing, since a verification hiccup must
 * never hold up registration or a payment (same principle salesinventoryapp's
 * momo/verify route documents for itself).
 *
 * In mock mode (no live Hubtel account — see hubtelPaymentService.ts), this
 * simulates the lookup instead of calling Hubtel's real Verification API.
 */
export async function verifyMobileMoneyNumber(params: {
  msisdn: string;
  network: string;
  requestedById: string;
}): Promise<VerifyResult> {
  const cacheKey = `${params.network}:${params.msisdn}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  if (isRateLimited(params.requestedById)) {
    return { verified: false, accountName: null, message: 'Too many lookups — try again in a few minutes.' };
  }
  recordAttempt(params.requestedById);

  let result: VerifyResult;
  try {
    if (process.env.HUBTEL_PAYMENTS_MODE === 'live') {
      throw new Error('HUBTEL_PAYMENTS_MODE=live is not wired to a real Hubtel account in this build — use mock mode.');
    }
    // Mock mode: if the number already belongs to a registered customer, "verify"
    // against their own name — a realistic stand-in for what Hubtel's wallet
    // lookup would hand back, without needing a live merchant account.
    const existing = await prisma.customer.findFirst({
      where: { OR: [{ phone: params.msisdn }, { phone2: params.msisdn }, { phone3: params.msisdn }] },
      select: { firstName: true, lastName: true },
    });
    result = {
      verified: true,
      accountName: existing ? `${existing.firstName} ${existing.lastName}`.toUpperCase() : null,
      message: 'Registered mobile money number.',
    };
  } catch (e) {
    result = { verified: false, accountName: null, message: e instanceof Error ? e.message : 'Verification unavailable' };
  }

  cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
