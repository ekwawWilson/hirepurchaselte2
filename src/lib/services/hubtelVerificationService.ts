import { prisma } from '../db/prisma';
import { isHubtelLiveMode, requireHubtelCredentials, hubtelAuthHeader, getHubtelChannel, formatPhoneForHubtel } from './hubtelClient';
import { recordHubtelSample } from './hubtelSampleLogService';

export interface VerifyResult {
  /** True only when Hubtel confirmed the number has a mobile money wallet. */
  verified: boolean;
  /** Whether Hubtel gave an answer at all. False: the check could not be made, which says nothing about the number. */
  checked: boolean;
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
// A hanging lookup must never hold up registering a customer.
const TIMEOUT_MS = 8_000;

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

const unchecked = (message: string): VerifyResult => ({ verified: false, checked: false, accountName: null, message });

/**
 * Hubtel's Verification API — Mobile Money Registration & Username Query, as
 * salesinventoryapp uses it (lib/momo/hubtelVerify.ts there):
 *
 *   GET https://rnv.hubtel.com/v2/merchantaccount/merchants/{POS Sales ID}/mobilemoney/verify
 *       ?channel=mtn-gh|vodafone-gh|tigo-gh&customerMsisdn=233XXXXXXXXX
 *
 * Same Basic credentials as the payment APIs, on its own host. Hubtel only
 * answers servers whose IP it has whitelisted, and the product has to be
 * enabled on the account — either missing shows up here as a refusal.
 */
async function askHubtel(msisdn: string, network: string): Promise<VerifyResult> {
  const creds = requireHubtelCredentials();
  const url = `https://rnv.hubtel.com/v2/merchantaccount/merchants/${encodeURIComponent(creds.salesId)}/mobilemoney/verify`
    + `?channel=${encodeURIComponent(getHubtelChannel(network))}&customerMsisdn=${encodeURIComponent(formatPhoneForHubtel(msisdn))}`;

  let res: Response;
  try {
    res = await fetch(url, { headers: { Authorization: hubtelAuthHeader(creds), Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    console.error(`[hubtel] number verification could not reach Hubtel: ${e instanceof Error ? e.message : e}`);
    return unchecked(timedOut ? 'Hubtel did not answer in time — try again, or confirm the number with the customer.' : 'Could not reach Hubtel to check this number — confirm it with the customer.');
  }

  const text = await res.text();
  let body: { responseCode?: string; message?: string; data?: { isRegistered?: boolean; name?: string; status?: string } | null } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON (an HTML error page): handled by the status checks below.
  }
  await recordHubtelSample('MOMO_VERIFY', { url, httpStatus: res.status }, body ?? text.slice(0, 500));

  if (res.status === 401 || res.status === 403) {
    console.error(`[hubtel] number verification refused (HTTP ${res.status}): ${body?.message ?? text.slice(0, 200)}`);
    return unchecked('Hubtel refused the number check. The verification service may not be enabled for this account, or this server is not whitelisted for it — confirm the number with the customer.');
  }
  if (!res.ok) {
    console.error(`[hubtel] number verification failed (HTTP ${res.status}): ${body?.message ?? text.slice(0, 200)}`);
    return unchecked(`Number check unavailable (Hubtel answered ${res.status}) — confirm the number with the customer.`);
  }
  // A documented refusal (e.g. "2001") comes back 200 with data: null and a
  // message written for the operator — pass it on rather than invent one.
  if (body?.responseCode !== '0000' || !body.data) {
    return unchecked(body?.message || 'This number could not be checked.');
  }
  if (!body.data.isRegistered) {
    return { verified: false, checked: true, accountName: null, message: 'This number is not registered for mobile money. Check the digits with the customer.' };
  }
  return {
    verified: true,
    checked: true,
    accountName: body.data.name?.trim() || null,
    message: body.data.status && body.data.status.toLowerCase() !== 'active'
      ? `Registered for mobile money, but the wallet is ${body.data.status}.`
      : 'Registered mobile money number.',
  };
}

/**
 * Confirms a phone number is a real, currently-registered mobile money wallet
 * and returns the account holder's name — a typo/sanity check before relying on
 * a number for SMS or a payment prompt, never a blocking gate: this always
 * resolves (fails open) rather than throwing, since a verification hiccup must
 * never hold up registration or a payment.
 *
 * In mock mode (no live Hubtel account — see hubtelPaymentService.ts), this
 * simulates the lookup instead of calling Hubtel.
 */
export async function verifyMobileMoneyNumber(params: {
  msisdn: string;
  network: string;
  requestedById: string;
}): Promise<VerifyResult> {
  const cacheKey = `${params.network}:${formatPhoneForHubtel(params.msisdn)}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  if (isRateLimited(params.requestedById)) {
    return unchecked('Too many lookups — try again in a few minutes.');
  }
  recordAttempt(params.requestedById);

  let result: VerifyResult;
  try {
    if (isHubtelLiveMode()) {
      result = await askHubtel(params.msisdn, params.network);
    } else {
      // Mock mode: if the number already belongs to a registered customer, "verify"
      // against their own name — a realistic stand-in for what Hubtel's wallet
      // lookup would hand back, without needing a live merchant account.
      const existing = await prisma.customer.findFirst({
        where: { OR: [{ phone: params.msisdn }, { phone2: params.msisdn }, { phone3: params.msisdn }] },
        select: { firstName: true, lastName: true },
      });
      result = {
        verified: true,
        checked: true,
        accountName: existing ? `${existing.firstName} ${existing.lastName}`.toUpperCase() : null,
        message: 'Registered mobile money number.',
      };
    }
  } catch (e) {
    result = unchecked(e instanceof Error ? e.message : 'Verification unavailable');
  }

  // Only a real answer is kept: a hiccup should not stop the next try for five minutes.
  if (result.checked) cache.set(cacheKey, { result, expiresAt: Date.now() + CACHE_TTL_MS });
  return result;
}
