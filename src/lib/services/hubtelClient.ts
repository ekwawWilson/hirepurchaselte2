/**
 * Low-level Hubtel Receive-Money/Preapproval API mechanics — the same product
 * and endpoints the legacy hirepurchase app uses (backend/src/services/hubtelService.ts),
 * shared by hubtelPaymentService.ts, hubtelPreapprovalService.ts and
 * hubtelStatusCheckService.ts so auth/phone-formatting/channel-mapping can't
 * drift between them.
 */
export class HubtelApiError extends Error {}

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

interface ReceiveMoneyResponse {
  Message: string;
  ResponseCode: string;
  Data: { TransactionId: string; ClientReference: string; Amount: number; Charges: number; AmountCharged: number };
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
}): Promise<{ transactionId: string; status: 'PENDING' | 'FAILED'; message: string; raw: unknown }> {
  const creds = requireHubtelCredentials();
  const payload = {
    CustomerName: params.customerName,
    CustomerMsisdn: formatPhoneForHubtel(params.msisdn),
    CustomerEmail: params.customerEmail || undefined,
    Channel: getHubtelChannel(params.network, params.isDirectDebit),
    Amount: Number((params.amountMinor / 100).toFixed(2)),
    PrimaryCallbackUrl: params.callbackUrl,
    Description: params.description,
    ClientReference: params.clientReference,
  };

  const res = await fetch(receiveMoneyUrl(creds.salesId), {
    method: 'POST',
    headers: { Authorization: hubtelAuthHeader(creds), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as ReceiveMoneyResponse;
  if (!res.ok) throw new HubtelApiError(body?.Message || `Hubtel receive-money call failed with HTTP ${res.status}`);

  return {
    transactionId: body.Data?.TransactionId,
    status: body.ResponseCode === '0001' ? 'PENDING' : 'FAILED',
    message: body.Message,
    raw: body,
  };
}

interface PreapprovalInitiateResponse {
  message: string;
  responseCode: string;
  data: {
    hubtelPreApprovalId: string;
    clientReferenceId: string;
    verificationType: 'USSD' | 'OTP';
    otpPrefix: string | null;
    preapprovalStatus: string;
  };
}

export async function callHubtelPreapprovalInitiate(params: {
  msisdn: string;
  network: string;
  clientReferenceId: string;
  callbackUrl: string;
}): Promise<{ hubtelPreapprovalId: string; verificationType: 'USSD' | 'OTP'; otpPrefix: string | null; raw: unknown }> {
  const creds = requireHubtelCredentials();
  const payload = {
    clientReferenceId: params.clientReferenceId,
    customerMsisdn: formatPhoneForHubtel(params.msisdn),
    channel: getHubtelChannel(params.network, true),
    callbackUrl: params.callbackUrl,
  };

  const res = await fetch(preapprovalInitiateUrl(creds.salesId), {
    method: 'POST',
    headers: { Authorization: hubtelAuthHeader(creds), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = (await res.json()) as PreapprovalInitiateResponse;
  if (!res.ok) throw new HubtelApiError(body?.message || `Hubtel preapproval initiate failed with HTTP ${res.status}`);

  return {
    hubtelPreapprovalId: body.data?.hubtelPreApprovalId,
    verificationType: body.data?.verificationType,
    otpPrefix: body.data?.otpPrefix ?? null,
    raw: body,
  };
}

/**
 * Tolerant status/response-code parsing — Hubtel's own field casing/shape has
 * been observed to vary (data.status vs Data.Status, ResponseCode vs
 * responseCode) across its callback and status-check payloads for this same
 * product; this mirrors the parsing the legacy hirepurchase app's callers use.
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
