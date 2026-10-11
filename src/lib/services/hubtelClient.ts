/**
 * Low-level Hubtel Receive-Money/Preapproval API mechanics — the same product
 * and endpoints the legacy hirepurchase app uses (backend/src/services/hubtelService.ts),
 * shared by hubtelPaymentService.ts, hubtelPreapprovalService.ts and
 * hubtelStatusCheckService.ts so auth/phone-formatting/channel-mapping can't
 * drift between them.
 */
import { recordHubtelSample } from './hubtelSampleLogService';

/**
 * `rejected` is set when Hubtel itself answered and refused the request (a
 * 4xx): nothing was charged and nothing will call back. Without it the
 * outcome is unknown — a dropped connection or a gateway error can hide a
 * request Hubtel did accept — and only a status check can settle it.
 */
export class HubtelApiError extends Error {
  constructor(message: string, readonly rejected?: { responseCode: string | null; raw: unknown }) {
    super(message);
  }
}

// Long enough for Hubtel's slowest honest answer, short enough that a
// customer's screen is not left hanging on a request that will never return —
// which, per Hubtel, is one of the two things a server whose IP it has not
// whitelisted gets (the other being 403).
const HUBTEL_TIMEOUT_MS = 25_000;

async function hubtelFetch(url: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(HUBTEL_TIMEOUT_MS) });
  } catch (e) {
    if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      throw new HubtelApiError('Hubtel did not answer in time — if this server is new to the account, its IP address may not be whitelisted yet');
    }
    throw e;
  }
}

/** The reason to report for a non-2xx answer: Hubtel's own if it gave one. */
export function hubtelHttpFailure(what: string, status: number, message?: string | null): string {
  if (message) return message;
  if (status === 403) return `Hubtel refused the ${what} request (403 Forbidden) — this server's IP address is not whitelisted for the account`;
  return `Hubtel ${what} failed with HTTP ${status}`;
}

/**
 * What to tell the person paying when Hubtel turns a Receive Money request
 * down, by its documented response code. 2001 is the customer's own wallet or
 * handset (wrong PIN, no funds, a number that isn't on that network) and
 * Hubtel's wording for it is written for them. The 4xxx codes are this
 * merchant account's setup — API scopes, fees, channel permissions — which a
 * customer can do nothing about and should not be shown.
 */
export function describeHubtelRejection(responseCode: string | null, message: string): string {
  if (responseCode === '2001') return message || 'The payment was not approved. Check the number and network, and that the wallet has enough funds.';
  return 'Mobile money payments are not available right now. Please pay at the office, or try again later.';
}

/** Falls back to the raw text (an HTML error page from a gateway/proxy in
 *  front of Hubtel, for instance) instead of throwing on a non-JSON body, so
 *  a failure response is still captured/returned rather than lost. */
async function parseHubtelResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function isHubtelLiveMode(): boolean {
  return process.env.HUBTEL_PAYMENTS_MODE === 'live';
}

interface HubtelCredentials {
  salesId: string;
  key: string;
  secret: string;
}

export function requireHubtelCredentials(): HubtelCredentials {
  const salesId = process.env.HUBTEL_POS_SALES_ID;
  const key = process.env.HUBTEL_API_KEY;
  const secret = process.env.HUBTEL_API_SECRET;
  if (!salesId || !key || !secret) {
    throw new HubtelApiError('HUBTEL_POS_SALES_ID/HUBTEL_API_KEY/HUBTEL_API_SECRET are not configured');
  }
  return { salesId, key, secret };
}

export function hubtelAuthHeader(creds: HubtelCredentials): string {
  return `Basic ${Buffer.from(`${creds.key}:${creds.secret}`).toString('base64')}`;
}

/** 0244000111 / +233244000111 / 233244000111 -> 233244000111 (what Hubtel's Channel APIs expect). */
export function formatPhoneForHubtel(phone: string): string {
  let cleaned = phone.replace(/\s/g, '').replace(/\+/g, '');
  if (cleaned.startsWith('0')) cleaned = '233' + cleaned.slice(1);
  if (!cleaned.startsWith('233')) cleaned = '233' + cleaned;
  return cleaned;
}

/**
 * All equivalent written forms of a Ghana phone number — 0244000111,
 * 233244000111, +233244000111. Customer phone numbers are stored as free
 * text (whatever format the operator typed at registration; see
 * customerService.ts), while Hubtel's real USSD gateway sends the dialing
 * number as "Mobile" in 233-prefixed form. An exact-match lookup against a
 * 0-prefixed stored number would silently never match a real dial-in, so
 * anywhere a phone number from an external source (USSD, a callback) is
 * matched against stored customer records, it must be matched against every
 * variant, not the raw value alone.
 */
export function phoneVariants(phone: string): string[] {
  const trimmed = phone.trim();
  if (!trimmed) return [];
  const digits = trimmed.replace(/\s/g, '').replace(/^\+/, '');
  const local = digits.startsWith('233') ? '0' + digits.slice(3) : digits.startsWith('0') ? digits : '0' + digits;
  const intl = digits.startsWith('233') ? digits : formatPhoneForHubtel(digits);
  return [...new Set([trimmed, local, intl, `+${intl}`])];
}

/** Maps our network name to Hubtel's channel code, appending -direct-debit for mandate initiation/charges. */
export function getHubtelChannel(network: string, isDirectDebit = false): string {
  const suffix = isDirectDebit ? '-direct-debit' : '';
  switch (network.toUpperCase()) {
    case 'MTN':
      return `mtn-gh${suffix}`;
    case 'VODAFONE':
    case 'TELECEL':
      return `vodafone-gh${suffix}`;
    case 'AIRTELTIGO':
      if (isDirectDebit) throw new HubtelApiError('AirtelTigo does not support Direct Debit');
      return 'tigo-gh';
    default:
      throw new HubtelApiError(`Unsupported network: ${network}`);
  }
}

export function receiveMoneyUrl(salesId: string): string {
  return `https://rmp.hubtel.com/merchantaccount/merchants/${salesId}/receive/mobilemoney`;
}

export function transactionStatusUrl(salesId: string): string {
  return `https://api-txnstatus.hubtel.com/transactions/${salesId}/status`;
}

export function preapprovalInitiateUrl(salesId: string): string {
  return `https://preapproval.hubtel.com/api/v2/merchant/${salesId}/preapproval/initiate`;
}

export function preapprovalVerifyOtpUrl(salesId: string): string {
  return `https://preapproval.hubtel.com/api/v2/merchant/${salesId}/preapproval/verifyotp`;
}

export function preapprovalStatusUrl(salesId: string, clientReferenceId: string): string {
  return `https://preapproval.hubtel.com/api/v2/merchant/${salesId}/preapproval/${encodeURIComponent(clientReferenceId)}/status`;
}

/** Hubtel keys a cancellation on the wallet number, not on one request's reference. */
export function preapprovalCancelUrl(salesId: string, msisdn: string): string {
  return `https://preapproval.hubtel.com/api/v2/merchant/${salesId}/preapproval/${formatPhoneForHubtel(msisdn)}/cancel`;
}

export function preapprovalReactivateUrl(salesId: string): string {
  return `https://preapproval.hubtel.com/api/v2/merchant/${salesId}/preapproval/reactivate`;
}

interface ReceiveMoneyResponse {
  Message: string;
  ResponseCode: string;
  Data: { TransactionId: string; ClientReference: string; Amount: number; Charges: number; AmountCharged: number };
}

/** Hubtel fails a request whose Description carries "strange characters (&*!%@)". */
function plainDescription(text: string): string {
  return text.replace(/[^A-Za-z0-9 .,/#-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The Receive-Money call — used for both a regular USSD/mobile-money charge
 * and a direct-debit charge against an approved mandate (Hubtel uses the same
 * endpoint for both; only the Channel's -direct-debit suffix differs). A
 * '0001' ResponseCode means "pending, wait for the callback"; anything else
 * is an immediate rejection (bad request, invalid channel, etc.) — not
 * something a later callback would ever resolve.
 */
export async function callHubtelReceiveMoney(params: {
  customerName: string;
  msisdn: string;
  customerEmail?: string | null;
  amountMinor: number;
  network: string;
  isDirectDebit: boolean;
  description: string;
  clientReference: string;
  callbackUrl: string;
}): Promise<{ transactionId: string | undefined; status: 'PENDING' | 'FAILED'; responseCode: string | null; message: string; raw: unknown }> {
  const creds = requireHubtelCredentials();
  const payload = {
    CustomerName: params.customerName,
    CustomerMsisdn: formatPhoneForHubtel(params.msisdn),
    CustomerEmail: params.customerEmail || undefined,
    Channel: getHubtelChannel(params.network, params.isDirectDebit),
    Amount: Number((params.amountMinor / 100).toFixed(2)),
    PrimaryCallbackUrl: params.callbackUrl,
    Description: plainDescription(params.description),
    ClientReference: params.clientReference,
  };

  const res = await hubtelFetch(receiveMoneyUrl(creds.salesId), {
    method: 'POST',
    headers: { Authorization: hubtelAuthHeader(creds), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const parsed = await parseHubtelResponse(res);
  // A genuine outbound call captured for Settings > Hubtel Diagnostics's
  // sample-payloads panel — both the request this app actually sent and
  // Hubtel's actual response, success or failure alike.
  await recordHubtelSample(params.isDirectDebit ? 'DIRECT_DEBIT_CHARGE' : 'RECEIVE_MONEY_INITIATE', payload, parsed);
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Partial<ReceiveMoneyResponse>;
  if (!res.ok) {
    throw new HubtelApiError(
      hubtelHttpFailure('receive money', res.status, body.Message),
      res.status < 500 ? { responseCode: body.ResponseCode ?? null, raw: parsed } : undefined,
    );
  }

  return {
    transactionId: body.Data?.TransactionId,
    status: body.ResponseCode === '0001' ? 'PENDING' : 'FAILED',
    responseCode: body.ResponseCode ?? null,
    message: body.Message ?? '',
    raw: body,
  };
}

interface PreapprovalRequestResponse {
  message?: string;
  responseCode?: string;
  data?: {
    hubtelPreApprovalId?: string;
    clientReferenceId?: string;
    verificationType?: 'USSD' | 'OTP';
    otpPrefix?: string | null;
    preapprovalStatus?: string;
  } | null;
}

/** What Hubtel answers an initiate or a reactivate with — the two share one response shape. */
export interface PreapprovalRequestResult {
  hubtelPreapprovalId: string | null;
  clientReferenceId: string | null;
  /** Hubtel's own choice, never ours: a USSD prompt for a new number, an OTP
   *  for one already preapproved with another merchant. */
  verificationType: 'USSD' | 'OTP' | null;
  otpPrefix: string | null;
  /** APPROVED | REJECTED | PENDING. Hubtel answers APPROVED straight away,
   *  with no prompt and so no callback, for a number already preapproved for
   *  this merchant ("success, Customer is already preapproved"). */
  preapprovalStatus: string | null;
  message: string;
  raw: unknown;
}

function parsePreapprovalRequestResponse(res: Response, parsed: unknown, what: string): PreapprovalRequestResult {
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as PreapprovalRequestResponse;
  const message = body.message ?? '';
  if (!res.ok) throw new HubtelApiError(hubtelHttpFailure(what, res.status, message));

  const data = body.data ?? null;
  const alreadyApproved = String(data?.preapprovalStatus ?? '').toUpperCase() === 'APPROVED' || /already preapproved/i.test(message);
  // A 2xx with neither a preapproval id nor an approval is not a request
  // Hubtel is tracking: nothing would ever call back about it.
  if (!data?.hubtelPreApprovalId && !alreadyApproved) {
    throw new HubtelApiError(message || `Hubtel did not accept the ${what} request`);
  }

  return {
    hubtelPreapprovalId: data?.hubtelPreApprovalId ?? null,
    clientReferenceId: data?.clientReferenceId ?? null,
    verificationType: data?.verificationType ?? null,
    otpPrefix: data?.otpPrefix ?? null,
    preapprovalStatus: alreadyApproved ? 'APPROVED' : data?.preapprovalStatus ?? null,
    message,
    raw: parsed,
  };
}

export async function callHubtelPreapprovalInitiate(params: {
  msisdn: string;
  network: string;
  clientReferenceId: string;
  callbackUrl: string;
}): Promise<PreapprovalRequestResult> {
  const creds = requireHubtelCredentials();
  const payload = {
    clientReferenceId: params.clientReferenceId,
    customerMsisdn: formatPhoneForHubtel(params.msisdn),
    channel: getHubtelChannel(params.network, true),
    callbackUrl: params.callbackUrl,
  };

  const res = await hubtelFetch(preapprovalInitiateUrl(creds.salesId), {
    method: 'POST',
    headers: { Authorization: hubtelAuthHeader(creds), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const parsed = await parseHubtelResponse(res);
  // A genuine outbound call captured for Settings > Hubtel Diagnostics's
  // sample-payloads panel — both the request this app actually sent and
  // Hubtel's actual response, success or failure alike.
  await recordHubtelSample('PREAPPROVAL_INITIATE', payload, parsed);
  return parsePreapprovalRequestResponse(res, parsed, 'preapproval initiate');
}

/**
 * Asks Hubtel to restore a mandate the customer cancelled. Answers like an
 * initiate — a fresh USSD prompt or OTP for the customer to approve again —
 * so the mandate goes back through the same two verification paths.
 */
export async function callHubtelPreapprovalReactivate(params: { msisdn: string; callbackUrl: string }): Promise<PreapprovalRequestResult> {
  const creds = requireHubtelCredentials();
  const payload = { callbackUrl: params.callbackUrl, customerMsisdn: formatPhoneForHubtel(params.msisdn) };

  const res = await hubtelFetch(preapprovalReactivateUrl(creds.salesId), {
    method: 'POST',
    headers: { Authorization: hubtelAuthHeader(creds), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const parsed = await parseHubtelResponse(res);
  await recordHubtelSample('PREAPPROVAL_REACTIVATE', payload, parsed);
  return parsePreapprovalRequestResponse(res, parsed, 'preapproval reactivate');
}

/**
 * The Preapproval Status Check — the failsafe for a mandate callback that
 * never arrived. Hubtel's own sample answers with `code` where every other
 * preapproval response says `responseCode`, and spells the id
 * `hubtelPreapprovalId` here but `hubtelPreApprovalId` on initiate, so both
 * spellings are read.
 */
export async function callHubtelPreapprovalStatus(clientReferenceId: string): Promise<{
  preapprovalStatus: string | null; hubtelPreapprovalId: string | null; raw: unknown;
}> {
  const creds = requireHubtelCredentials();
  const url = preapprovalStatusUrl(creds.salesId, clientReferenceId);

  const res = await hubtelFetch(url, { headers: { Authorization: hubtelAuthHeader(creds) } });
  const parsed = await parseHubtelResponse(res);
  await recordHubtelSample('PREAPPROVAL_STATUS_CHECK', { url }, parsed);
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (!res.ok) throw new HubtelApiError(hubtelHttpFailure('preapproval status check', res.status, body.message as string));

  const data = (body.data ?? body.Data ?? {}) as Record<string, unknown>;
  return {
    preapprovalStatus: (data.preapprovalStatus ?? data.PreapprovalStatus ?? null) as string | null,
    hubtelPreapprovalId: (data.hubtelPreapprovalId ?? data.hubtelPreApprovalId ?? data.HubtelPreapprovalId ?? null) as string | null,
    raw: parsed,
  };
}

/** Revokes the customer's mandate with this merchant. `data` is a bare boolean. */
export async function callHubtelPreapprovalCancel(msisdn: string): Promise<{ cancelled: boolean; message: string; raw: unknown }> {
  const creds = requireHubtelCredentials();
  const url = preapprovalCancelUrl(creds.salesId, msisdn);

  const res = await hubtelFetch(url, { headers: { Authorization: hubtelAuthHeader(creds) } });
  const parsed = await parseHubtelResponse(res);
  await recordHubtelSample('PREAPPROVAL_CANCEL', { url }, parsed);
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as { message?: string; responseCode?: string; data?: unknown };
  if (!res.ok) throw new HubtelApiError(hubtelHttpFailure('preapproval cancel', res.status, body.message));

  return { cancelled: body.responseCode === '2000' && body.data !== false, message: body.message ?? '', raw: parsed };
}

interface PreapprovalVerifyOtpResponse {
  message: string;
  responseCode: string;
  data: { hubtelPreApprovalId: string; preapprovalStatus: string } | null;
}

/**
 * Submits the OTP code for a preapproval whose verificationType came back as
 * OTP instead of USSD (the number already has a mandate with a different
 * Hubtel merchant — see callHubtelPreapprovalInitiate). responseCode '2000'
 * means the code was accepted; the mandate itself still stays PENDING until
 * the usual preapproval callback delivers its final APPROVED/FAILED status —
 * this call only clears the OTP step, it doesn't finish the mandate.
 */
export async function callHubtelPreapprovalVerifyOtp(params: {
  msisdn: string;
  hubtelPreapprovalId: string;
  clientReferenceId: string;
  otpCode: string;
}): Promise<{ accepted: boolean; preapprovalStatus: string | null; message: string; raw: unknown }> {
  const creds = requireHubtelCredentials();
  const payload = {
    customerMsisdn: formatPhoneForHubtel(params.msisdn),
    hubtelPreApprovalId: params.hubtelPreapprovalId,
    clientReferenceId: params.clientReferenceId,
    otpCode: params.otpCode,
  };

  const res = await hubtelFetch(preapprovalVerifyOtpUrl(creds.salesId), {
    method: 'POST',
    headers: { Authorization: hubtelAuthHeader(creds), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const parsed = await parseHubtelResponse(res);
  await recordHubtelSample('PREAPPROVAL_VERIFY_OTP', payload, parsed);
  const body = parsed as PreapprovalVerifyOtpResponse;
  if (!res.ok) throw new HubtelApiError(hubtelHttpFailure('OTP verification', res.status, body?.message));

  return {
    accepted: body.responseCode === '2000',
    preapprovalStatus: body.data?.preapprovalStatus ?? null,
    message: body.message,
    raw: body,
  };
}

/**
 * Same call as callHubtelPreapprovalInitiate, but for diagnosing a live
 * failure rather than actually requesting a mandate: returns Hubtel's exact
 * HTTP status and untouched response body instead of throwing a collapsed
 * error message, and never writes a HubtelPreapproval row (this app's normal
 * initiatePreapproval always does, tying the request to a real customer +
 * contract — a diagnostic probe has neither). Still a real call to Hubtel —
 * if accepted, it will genuinely prompt whatever number is given, same as
 * production would. That's the point: "was the prompt actually sent" is only
 * answerable by actually asking Hubtel.
 */
export async function testPreapprovalInitiateRaw(params: {
  msisdn: string;
  network: string;
  callbackUrl: string;
}): Promise<{ requestUrl: string; requestPayload: unknown; httpStatus: number; responseBody: unknown }> {
  const creds = requireHubtelCredentials();
  const clientReferenceId = `DIAGNOSTIC-${Date.now()}`;
  const payload = {
    clientReferenceId,
    customerMsisdn: formatPhoneForHubtel(params.msisdn),
    channel: getHubtelChannel(params.network, true),
    callbackUrl: params.callbackUrl,
  };
  const requestUrl = preapprovalInitiateUrl(creds.salesId);

  const res = await hubtelFetch(requestUrl, {
    method: 'POST',
    headers: { Authorization: hubtelAuthHeader(creds), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const responseBody = await parseHubtelResponse(res);

  return { requestUrl, requestPayload: payload, httpStatus: res.status, responseBody };
}

/**
 * Reads the Transaction Status Check's answer. Unlike a callback, its
 * responseCode says only that the lookup worked — "0000" comes back for an
 * Unpaid transaction as much as a Paid one — so the outcome is `data.status`
 * alone: Paid, Unpaid or Refunded. Anything else, an Unpaid included, is not
 * a payment and not yet a failure either.
 */
export function resolveHubtelStatusCheck(body: unknown): 'SUCCESS' | 'FAILED' | 'PENDING' {
  const b = body as Record<string, unknown> | null | undefined;
  const data = (b?.data ?? b?.Data ?? {}) as Record<string, unknown>;
  const status = String(data.status ?? data.Status ?? '').toUpperCase();
  if (status === 'PAID') return 'SUCCESS';
  if (status === 'REFUNDED') return 'FAILED';
  return 'PENDING';
}

/**
 * Reads a Receive Money *callback*, where the response code is the outcome:
 * 0000 paid, 2001 failed. Tolerant of Hubtel's varying field casing
 * (data.status vs Data.Status, ResponseCode vs responseCode), mirroring the
 * legacy hirepurchase app's callers. Not for the status check — see
 * resolveHubtelStatusCheck.
 */
export function resolveHubtelStatus(body: unknown): 'SUCCESS' | 'FAILED' | 'PENDING' {
  const b = body as Record<string, unknown> | null | undefined;
  const data = (b?.data ?? b?.Data ?? {}) as Record<string, unknown>;
  const rawStatus = String(data.status ?? data.Status ?? '').toUpperCase();
  const responseCode = String(b?.ResponseCode ?? b?.responseCode ?? data.ResponseCode ?? '').trim();

  if (responseCode === '0000' || ['SUCCESS', 'SUCCESSFUL', 'PAID', 'COMPLETED'].includes(rawStatus)) return 'SUCCESS';
  if (responseCode === '2001' || ['FAILED', 'FAIL', 'REJECTED', 'DECLINED', 'CANCELLED'].includes(rawStatus)) return 'FAILED';
  return 'PENDING';
}
