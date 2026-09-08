import { isHubtelLiveMode, requireHubtelCredentials, hubtelAuthHeader, transactionStatusUrl, resolveHubtelStatus, HubtelApiError } from './hubtelClient';
import { recordHubtelSample } from './hubtelSampleLogService';

export interface HubtelStatusCheckResult {
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
}

/**
 * Hubtel's Transaction Status Check API — the mandatory failsafe for a lost or
 * delayed payment callback. Same product and endpoint the legacy hirepurchase
 * app uses (backend/src/services/hubtelService.ts's checkHubtelPaymentStatus):
 * `GET https://api-txnstatus.hubtel.com/transactions/{HUBTEL_POS_SALES_ID}/status`,
 * Basic-authed with HUBTEL_API_KEY/HUBTEL_API_SECRET — the same merchant/POS
 * Sales ID and credentials HP-Lite's receive-money call already uses.
 *
 * Without this, reconcilePendingHubtelTransactions would have to guess a stale
 * PENDING transaction failed, which is wrong whenever the customer really was
 * charged and only the callback went missing.
 *
 * Mock mode (the only mode this build was wired to before live credentials
 * were configured) has nothing to check: it resolves every transaction
 * synchronously, so nothing lingers PENDING long enough to reach this path.
 */
export async function checkHubtelTransactionStatus(clientReference: string): Promise<HubtelStatusCheckResult> {
  if (!isHubtelLiveMode()) {
    return { status: 'PENDING' };
  }

  const creds = requireHubtelCredentials();
  const url = `${transactionStatusUrl(creds.salesId)}?clientReference=${encodeURIComponent(clientReference)}`;
  const res = await fetch(url, { headers: { Authorization: hubtelAuthHeader(creds) } });
  if (!res.ok) throw new HubtelApiError(`Hubtel status check failed with HTTP ${res.status}`);

  const body = await res.json();
  // A genuine status-check response, captured for Settings > Hubtel
  // Diagnostics's sample-payloads panel — this API has nowhere else its raw
  // body is persisted (unlike the payment callback's HubtelTransaction row).
  await recordHubtelSample('STATUS_CHECK', { url }, body);
  return { status: resolveHubtelStatus(body) };
}
