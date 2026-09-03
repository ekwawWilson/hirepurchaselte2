'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

// The exact contract this app's own routes parse/emit for each Hubtel callback
// and the USSD Service Flow — for pasting into a UAT ticket or screenshotting
// for Hubtel's reviewer, and for testing the shapes below with curl/Postman
// directly against this server without a live shortcode.
const SAMPLE_PAYLOADS_TEXT = `HUBTEL INTEGRATION — REQUEST/RESPONSE CONTRACT
================================================
As implemented by this app's USSD, Receive-Money callback, Preapproval
callback and Transaction Status Check handling.

------------------------------------------------------
1. USSD — Service Flow Interaction (POST to the Service
   interaction URL registered with Hubtel)
------------------------------------------------------
Request (dial-in):
{
  "SessionId": "abc123",
  "Mobile": "233244000111",
  "Message": "",
  "Type": "Initiation"
}

Response (this app always returns all five fields — Label/DataType/FieldType
are Mandatory per Hubtel's contract; a missing one, or Type in the wrong
case, is what produces Hubtel's "invalid response, Error: UUE"):
{
  "SessionId": "abc123",
  "Type": "response",
  "Message": "HP001 (Deposit + Instalment)\\nBalance: GHS450.00\\nEnter amount to pay:",
  "Label": "Enter amount",
  "DataType": "input",
  "FieldType": "decimal"
}

Follow-up (customer typed a reply):
{ "SessionId": "abc123", "Mobile": "233244000111", "Message": "50", "Type": "Response" }

Session ended by the network (hang-up / timeout):
{ "SessionId": "abc123", "Mobile": "233244000111", "Message": "", "Type": "Timeout" }
Response: { ..., "Type": "release", "DataType": "display" }

------------------------------------------------------
2. PAYMENT CALLBACK (POST to HUBTEL_CALLBACK_URL)
------------------------------------------------------
{
  "ResponseCode": "0000",
  "Message": "Success",
  "Data": {
    "ClientReference": "a1b2c3d4-e5f6",
    "TransactionId": "8a6cd5c6d3f24e1a9b2c",
    "Status": "Success",
    "Amount": 50.00,
    "CustomerMsisdn": "233244000111"
  }
}
A non-success ResponseCode (e.g. "2001") or Status of Failed/Rejected/Cancelled
is treated as a failed payment. Query string carries ?token=<WEBHOOK_SHARED_TOKEN>.

------------------------------------------------------
3. PREAPPROVAL CALLBACK (POST to the preapproval callback URL)
------------------------------------------------------
{
  "ClientReferenceId": "a1b2c3d4-e5f6",
  "HubtelPreapprovalId": "PA-00019284",
  "PreapprovalStatus": "Approved"
}
PreapprovalStatus of Cancelled/Expired -> mandate CANCELLED.
Declined/Failed/Rejected -> mandate FAILED. Anything else is ignored (not
yet a terminal state).

------------------------------------------------------
4. TRANSACTION STATUS CHECK — response
------------------------------------------------------
GET https://api-txnstatus.hubtel.com/transactions/{salesId}/status?clientReference={ref}
{
  "ResponseCode": "0000",
  "Data": { "Status": "Paid", "ClientReference": "a1b2c3d4-e5f6" }
}
`;

interface Probe {
  service: string;
  host: string;
  verdict: 'reachable' | 'blocked' | 'timeout' | 'error';
  detail: string;
  httpStatus?: number;
}

interface Diagnostics {
  mode: 'live' | 'mock';
  config: {
    salesIdSet: boolean;
    apiKeySet: boolean;
    apiSecretSet: boolean;
    webhookTokenSet: boolean;
    paymentCallbackUrl: string | null;
    preapprovalCallbackUrl: string | null;
  };
  ip: string | null;
  ipSource?: string;
  probes: Probe[];
}

const VERDICT_STYLES: Record<Probe['verdict'], 'success' | 'destructive'> = {
  reachable: 'success',
  blocked: 'destructive',
  timeout: 'destructive',
  error: 'destructive',
};

const VERDICT_LABEL: Record<Probe['verdict'], string> = {
  reachable: 'Reachable',
  blocked: 'Blocked',
  timeout: 'No response',
  error: 'Error',
};

function ConfigRow({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <Badge variant={ok ? 'success' : 'destructive'}>{ok ? 'Set' : 'Missing'}</Badge>
      <span className="text-gray-700">{label}</span>
    </div>
  );
}

export function HubtelDiagnostics() {
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showSamples, setShowSamples] = useState(false);

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get<Diagnostics>('/settings/hubtel-diagnostics');
      setDiagnostics(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not run the check.');
    } finally {
      setLoading(false);
    }
  }

  async function copy(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      // Clipboard blocked — the value is on screen to read off anyway.
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Hubtel integration</CardTitle>
        <p className="text-sm text-gray-500 mt-0.5">
          Configuration status and connectivity — for verifying setup and for Hubtel&apos;s UAT sign-off.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button type="button" variant="outline" onClick={run} disabled={loading}>
          {loading ? 'Checking…' : diagnostics ? 'Re-run check' : 'Run check'}
        </Button>

        {error && <p className="text-sm text-red-600">{error}</p>}

        {diagnostics && (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-gray-500">Mode:</span>
              <Badge variant={diagnostics.mode === 'live' ? 'success' : 'secondary'}>{diagnostics.mode}</Badge>
              {diagnostics.mode === 'mock' && (
                <span className="text-xs text-gray-400">
                  Payments/preapprovals resolve instantly with no Hubtel account — set HUBTEL_PAYMENTS_MODE=live to go live.
                </span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">
              <ConfigRow ok={diagnostics.config.salesIdSet} label="HUBTEL_POS_SALES_ID" />
              <ConfigRow ok={diagnostics.config.apiKeySet} label="HUBTEL_API_KEY" />
              <ConfigRow ok={diagnostics.config.apiSecretSet} label="HUBTEL_API_SECRET" />
              <ConfigRow ok={diagnostics.config.webhookTokenSet} label="WEBHOOK_SHARED_TOKEN" />
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Register these with Hubtel</p>
              {(['paymentCallbackUrl', 'preapprovalCallbackUrl'] as const).map((key) => {
                const url = diagnostics.config[key];
                return (
                  <div key={key} className="flex items-center gap-2">
                    <code className="flex-1 text-xs bg-gray-50 ring-1 ring-gray-200/60 rounded px-2 py-1.5 overflow-x-auto whitespace-nowrap">
                      {url || '(not configured)'}
                    </code>
                    {url && (
                      <Button type="button" size="sm" variant="outline" onClick={() => copy(url, key)}>
                        {copied === key ? 'Copied' : 'Copy'}
                      </Button>
                    )}
                  </div>
                );
              })}
              <p className="text-xs text-gray-400">
                Note: these already carry the webhook token if one is configured — paste them into Hubtel exactly as shown, not the bare route path.
              </p>
            </div>

            {diagnostics.ip && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">Outbound IP (for Hubtel to whitelist):</span>
                <code className="text-sm font-semibold">{diagnostics.ip}</code>
                <Button type="button" size="sm" variant="outline" onClick={() => copy(diagnostics.ip!, 'ip')}>
                  {copied === 'ip' ? 'Copied' : 'Copy'}
                </Button>
              </div>
            )}

            {diagnostics.probes.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Reachability</p>
                {diagnostics.probes.map((p) => (
                  <div key={p.service} className="flex items-start gap-2 text-sm border border-gray-100 rounded-lg p-2.5">
                    <Badge variant={VERDICT_STYLES[p.verdict]}>{VERDICT_LABEL[p.verdict]}</Badge>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-800">{p.service}</p>
                      <p className="text-xs text-gray-500">{p.detail}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {diagnostics.mode === 'mock' && (
              <p className="text-xs text-gray-400">
                Reachability probes only run in live mode with credentials configured — mock mode never calls Hubtel.
              </p>
            )}
          </div>
        )}

        <div className="border-t border-gray-100 pt-4 space-y-3">
          <div>
            <p className="text-sm font-medium text-gray-800">Test the USSD flow without a shortcode</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Hubtel only links a dial-in code (e.g. *920#) to this service after their UAT review — you don&apos;t need
              one to test. The simulator below sends this app&apos;s <code className="font-mono">/api/ussd</code> endpoint
              the exact same request shape Hubtel&apos;s network would, so it exercises the real flow end to end. Walk
              through it and share a screen recording (or replay the raw payloads below with curl/Postman) as evidence
              for Hubtel&apos;s reviewer.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link href="/ussd-simulator">Open USSD simulator</Link>
          </Button>
        </div>

        <div className="border-t border-gray-100 pt-4 space-y-2">
          <button
            type="button"
            className="text-sm font-medium text-gray-800 hover:text-gray-600"
            onClick={() => setShowSamples((v) => !v)}
          >
            {showSamples ? 'Hide' : 'Show'} sample request/response payloads
          </button>
          {showSamples && (
            <div className="space-y-2">
              <pre className="text-xs bg-gray-50 ring-1 ring-gray-200/60 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
                {SAMPLE_PAYLOADS_TEXT}
              </pre>
              <Button type="button" size="sm" variant="outline" onClick={() => copy(SAMPLE_PAYLOADS_TEXT, 'samples')}>
                {copied === 'samples' ? 'Copied' : 'Copy for Hubtel'}
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
