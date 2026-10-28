import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Transsion PayTrigger's Partner API (PayTrigger_PartnerAPI_General_EN):
 * every call is a POST of a JSON body with a `sign` header, answered with
 * `{ code, message, data }`. Success is `code == 200`, and a refusal comes
 * back as HTTP 200 too, so the body is always read and a non-2xx status is
 * never thrown. This file signs, sends and reads; it touches no database.
 *
 * Safety switches (env), so nothing reaches a customer's phone by accident:
 *   PAYTRIGGER_API_KEY               secret; never printed or logged
 *   PAYTRIGGER_DRY_RUN=true          the default: actions are simulated
 *   PAYTRIGGER_ENABLE_LIVE_ACTIONS   must also be true for an action to be sent
 *   PAYTRIGGER_CANARY_CONTRACTS      while set, only these contracts are sent live
 * Reads (lock state, licences, model lookup) are live whenever a key is set,
 * so staff see real data while actions are still dry.
 */

export const PAYTRIGGER_PATHS = {
  enrol: '/api/partner/lock/v1/imei/input',
  cancelEnrolment: '/api/partner/lock/v1/imei/cancel',
  updateRepayInfo: '/api/partner/lock/v1/updateRepayInfo',
  removeLock: '/api/partner/lock/v1/removeLock',
  findLockState: '/api/partner/lock/v1/findLockState',
  batchFindLockState: '/api/partner/lock/v1/batchFindLockState',
  getDevice: '/api/partner/lock/v1/getDevice',
  model: '/api/partner/model/v1/get',
  setLockRule: '/api/partner/lockRule/v1/setLockRule',
  checkLicense: '/api/partner/company/v1/checkLicense',
  verifyCode: '/api/partner/unlock/v1/verifyCode',
  sendPush: '/api/partner/push/v1/sendPushInfo',
} as const;

/** Never retried: asking again cannot change the answer. */
export const PERMANENT_CODES = new Set([20001, 20005, 20015, 30021, 50010, 50011, 50014, 50015, 50020, 50078]);
/** PayTrigger's per-device daily limits: not asked again before the next day's sweep. */
export const RATE_LIMIT_CODES = new Set([510, 50008]);

/** What a code means, for staff. PayTrigger's own message is shown alongside. */
export const CODE_MEANINGS: Record<number, string> = {
  400: 'Missing signature or bad parameters',
  510: 'Too many requests for this phone today',
  530: 'Signature rejected: check the API key',
  20001: 'Phone not found, or the IMEI and device tag do not match',
  20003: 'API key missing or expired',
  20004: 'PayTrigger refused this change of state',
  20005: 'This account is not permitted to do that (ask Transsion)',
  20015: 'Country, model or app version not enabled for this account',
  30011: 'No licences left',
  30021: 'This phone belongs to another company',
  40000: 'Signature rejected: check the API key',
  40001: "This server's IP address is not on PayTrigger's whitelist",
  40003: 'No IP whitelist is configured on the PayTrigger account',
  50008: 'Daily limit reached for this phone',
  50010: 'Not overdue, so a temporary unlock is not possible',
  50011: 'Temporary unlock is not enabled for this account',
  50012: 'A pay link was sent without its app package',
  50014: 'The anti-theft lock is on',
  50015: 'Already enrolled',
  50020: 'The IMEI must be 15 to 18 digits',
  50021: 'Some phones in the batch failed',
  50022: 'A lock date is required when the phone is not locked on activation',
  50056: 'The phone model does not match the one enrolled',
  50063: 'Old PayTrigger app: the 4-digit key shown on the lock screen is needed',
  50078: 'This IMEI is blacklisted',
  55106: 'The phone has not been switched on yet',
  71107: 'Offline PIN unlock is not configured for this account',
};

export interface PayTriggerConfig {
  baseUrl: string;
  apiKey: string | null;
  dryRun: boolean;
  liveActions: boolean;
  canary: Set<string>;
  currency: string;
  timeoutMs: number;
}

export function payTriggerConfig(): PayTriggerConfig {
  const env = process.env;
  return {
    baseUrl: (env.PAYTRIGGER_BASE_URL || 'https://paytrigger.transsion-os.com/PayTrigger').replace(/\/+$/, ''),
    apiKey: env.PAYTRIGGER_API_KEY?.trim() || null,
    dryRun: env.PAYTRIGGER_DRY_RUN !== 'false',
    liveActions: env.PAYTRIGGER_ENABLE_LIVE_ACTIONS === 'true',
    canary: new Set((env.PAYTRIGGER_CANARY_CONTRACTS ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
    currency: env.PAYTRIGGER_CURRENCY || 'GHS',
    timeoutMs: Number(env.PAYTRIGGER_TIMEOUT_MS) || 15_000,
  };
}

/** An action reaches a phone only when dry run is off, live actions are on, and a key is set. */
export function actionsAreLive(config = payTriggerConfig()): boolean {
  return !config.dryRun && config.liveActions && !!config.apiKey;
}

type Fields = Record<string, string | number | boolean | null | undefined>;

/**
 * The string PayTrigger signs (API doc §1.2): the body's fields that have a
 * value, keys in ASCII order, as `k1=v1&k2=v2`. A nested list is sent as a
 * JSON string in the body itself (`imeiInfo`), so it is signed as that string.
 */
export function signContent(body: Fields): string {
  return Object.keys(body)
    .filter((k) => body[k] !== null && body[k] !== undefined && body[k] !== '')
    .sort()
    .map((k) => `${k}=${body[k]}`)
    .join('&');
}

/** Base64 of the upper-case hex HMAC-SHA256 of signContent, keyed with the API key. */
export function signBody(body: Fields, apiKey: string): string {
  const hex = createHmac('sha256', apiKey).update(signContent(body), 'utf8').digest('hex').toUpperCase();
  return Buffer.from(hex, 'utf8').toString('base64');
}

/** A callback's `sign` header checked against its body, in constant time. */
export function verifyCallbackSignature(body: Record<string, unknown>, header: string | null, apiKey: string): boolean {
  if (!header) return false;
  const flat: Fields = {};
  for (const [k, v] of Object.entries(body)) {
    flat[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : (v as Fields[string]);
  }
  const expected = Buffer.from(signBody(flat, apiKey));
  const given = Buffer.from(header.trim());
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/** A nested list as PayTrigger wants it: each entry's keys in ASCII order, the whole as a JSON string. */
export function jsonList(entries: Array<Record<string, unknown>>): string {
  return JSON.stringify(entries.map((e) => Object.fromEntries(
    Object.keys(e).filter((k) => e[k] !== undefined && e[k] !== null && e[k] !== '').sort().map((k) => [k, e[k]]),
  )));
}

export interface PayTriggerResult<T = unknown> {
  success: boolean;
  /** Simulated, not sent: dry run, or no key. */
  dryRun: boolean;
  code: number | null;
  message: string;
  data: T | null;
  error: string | null;
  rateLimited: boolean;
  permanent: boolean;
  /** No answer (network error or timeout): the request may or may not have landed. */
  uncertain: boolean;
  /** The body as sent, the key masked: safe to log. */
  request: Record<string, unknown>;
}

function masked(body: Fields, keyField: string): Record<string, unknown> {
  return { ...body, [keyField]: '***' };
}

function describe(code: number, message: string): string {
  const meaning = CODE_MEANINGS[code];
  return meaning && meaning.toLowerCase() !== message.toLowerCase() ? `${meaning} (${code}: ${message})` : `${message} (${code})`;
}

async function send<T>(path: string, fields: Fields, keyField: string): Promise<PayTriggerResult<T>> {
  const config = payTriggerConfig();
  const body: Fields = { ...fields, [keyField]: config.apiKey ?? '' };
  const request = masked(body, keyField);
  const base = { dryRun: false, request, rateLimited: false, permanent: false, uncertain: false };
  if (!config.apiKey) {
    return { ...base, success: false, code: null, message: '', data: null, error: 'PAYTRIGGER_API_KEY is not set' };
  }

  let res: Response;
  try {
    res = await fetch(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', sign: signBody(body, config.apiKey) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (e) {
    const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return {
      ...base, success: false, uncertain: true, code: null, message: '', data: null,
      error: timedOut ? `PayTrigger did not answer within ${config.timeoutMs / 1000}s` : `Could not reach PayTrigger: ${e instanceof Error ? e.message : e}`,
    };
  }

  const text = await res.text();
  let envelope: { code?: number | string; message?: string; data?: T } | null = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    // An HTML error page from a proxy: reported below with the HTTP status.
  }
  if (!envelope || envelope.code === undefined) {
    return { ...base, success: false, code: null, message: '', data: null, error: `PayTrigger answered HTTP ${res.status} without a result: ${text.slice(0, 200)}` };
  }
  const code = Number(envelope.code);
  const message = envelope.message ?? '';
  const success = code === 200;
  return {
    ...base,
    success,
    code,
    message,
    data: envelope.data ?? null,
    error: success ? null : describe(code, message),
    rateLimited: RATE_LIMIT_CODES.has(code),
    permanent: PERMANENT_CODES.has(code),
  };
}

/** A read: live whenever the key is set. */
export function payTriggerRead<T = unknown>(path: string, fields: Fields): Promise<PayTriggerResult<T>> {
  return send<T>(path, fields, 'apiKey');
}

/**
 * An action (anything that changes a phone or spends a licence): sent only
 * when actionsAreLive(), otherwise answered with a simulated success marked
 * dryRun, carrying `simulated` as its data. updateRepayInfo names its key
 * field `relatedMerchant`; every other endpoint calls it `apiKey`.
 */
export async function payTriggerAction<T = unknown>(path: string, fields: Fields, opts: { simulated?: T } = {}): Promise<PayTriggerResult<T>> {
  const keyField = path === PAYTRIGGER_PATHS.updateRepayInfo ? 'relatedMerchant' : 'apiKey';
  if (!actionsAreLive()) {
    return {
      success: true, dryRun: true, code: 200, message: 'Simulated (dry run)', data: opts.simulated ?? null, error: null,
      rateLimited: false, permanent: false, uncertain: false, request: masked({ ...fields, [keyField]: '' }, keyField),
    };
  }
  return send<T>(path, fields, keyField);
}
