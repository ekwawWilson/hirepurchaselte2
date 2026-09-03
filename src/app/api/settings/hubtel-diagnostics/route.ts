import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import {
  isHubtelLiveMode,
  requireHubtelCredentials,
  hubtelAuthHeader,
  receiveMoneyUrl,
  preapprovalInitiateUrl,
  transactionStatusUrl,
} from '@/lib/services/hubtelClient';
import { preapprovalCallbackUrl } from '@/lib/services/hubtelPreapprovalService';

/**
 * GET /api/settings/hubtel-diagnostics
 *
 * Reports what this server actually has configured for Hubtel (without
 * exposing the secrets themselves), the exact callback URLs Hubtel needs
 * registered, and — in live mode with credentials present — whether Hubtel's
 * hosts will talk to this server's outbound IP at all.
 *
 * Hubtel whitelists by IP per service; an unlisted IP and a bad credential
 * both fail silently from a USSD/payment flow with no indication which one it
 * is. GET on a POST-only endpoint still proves whitelisting + auth without
 * ever sending a real payment prompt: 401 means Hubtel accepted the
 * connection and rejected the login (IP is fine, check credentials); 403 or a
 * timeout is what an un-whitelisted IP looks like.
 */
const PROBE_TIMEOUT_MS = 10000;
const IP_SERVICES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function outboundIp(): Promise<{ ip: string | null; source?: string }> {
  for (const url of IP_SERVICES) {
    try {
      const text = await withTimeout(async (signal) => {
        const res = await fetch(url, { signal, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.text()).trim();
      }, 8000);
      if (/^[0-9a-f.:]+$/i.test(text) && text.length <= 45) {
        return { ip: text, source: new URL(url).hostname };
      }
    } catch {
      // Try the next service.
    }
  }
  return { ip: null };
}

type ProbeVerdict = 'reachable' | 'blocked' | 'timeout' | 'error';
interface Probe { service: string; host: string; verdict: ProbeVerdict; detail: string; httpStatus?: number }

async function probe(service: string, url: string, auth: string): Promise<Probe> {
  const host = new URL(url).hostname;
  try {
    const res = await withTimeout(
      (signal) => fetch(url, { headers: { Authorization: auth, Accept: 'application/json' }, signal, cache: 'no-store' }),
      PROBE_TIMEOUT_MS,
    );
    if (res.status === 403) {
      return { service, host, verdict: 'blocked', httpStatus: 403, detail: 'Hubtel refused the request — this server\'s IP likely is not whitelisted for this service yet.' };
    }
    if (res.status === 401) {
      return { service, host, verdict: 'reachable', httpStatus: 401, detail: 'Hubtel accepted the connection but rejected the credentials. The IP is fine — check HUBTEL_API_KEY/HUBTEL_API_SECRET.' };
    }
    return { service, host, verdict: 'reachable', httpStatus: res.status, detail: `Hubtel responded (HTTP ${res.status}). The connection is getting through.` };
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      return { service, host, verdict: 'timeout', detail: 'No response within 10 seconds — Hubtel silently drops traffic from un-whitelisted IPs, so this usually means the same as a refusal.' };
    }
    return { service, host, verdict: 'error', detail: e instanceof Error ? e.message : 'Network error' };
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  const mode = isHubtelLiveMode() ? 'live' : 'mock';
  const config = {
    salesIdSet: Boolean(process.env.HUBTEL_POS_SALES_ID),
    apiKeySet: Boolean(process.env.HUBTEL_API_KEY),
    apiSecretSet: Boolean(process.env.HUBTEL_API_SECRET),
    webhookTokenSet: Boolean(process.env.WEBHOOK_SHARED_TOKEN),
    paymentCallbackUrl: process.env.HUBTEL_CALLBACK_URL || null,
    preapprovalCallbackUrl: preapprovalCallbackUrl() || null,
  };
  const configured = config.salesIdSet && config.apiKeySet && config.apiSecretSet;

  const { ip, source } = await outboundIp();

  let probes: Probe[] = [];
  if (mode === 'live' && configured) {
    const creds = requireHubtelCredentials();
    const auth2 = hubtelAuthHeader(creds);
    probes = await Promise.all([
      probe('Receive money (payments + direct debit)', receiveMoneyUrl(creds.salesId), auth2),
      probe('Preapproval (mandates)', preapprovalInitiateUrl(creds.salesId), auth2),
      probe('Transaction status check', `${transactionStatusUrl(creds.salesId)}?clientReference=DIAGNOSTIC-PROBE`, auth2),
    ]);
  }

  return NextResponse.json({ mode, config, ip, ipSource: source, probes });
}
