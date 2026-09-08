'use client';

import { useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/apiClient';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';

const DIRECT_DEBIT_NETWORKS = ['MTN', 'VODAFONE', 'TELECEL'];

interface PreapprovalTestResult {
  requestUrl: string;
  requestPayload: unknown;
  httpStatus: number;
  responseBody: unknown;
}

interface SamplePayload {
  request: unknown;
  response: unknown;
  capturedAt: string;
  note: string;
}

const SAMPLE_SECTIONS: { key: keyof DiagnosticsSamples; title: string; emptyHint: string }[] = [
  { key: 'ussd', title: 'USSD — Service Flow Interaction', emptyHint: 'Dial into the USSD simulator below, or wait for a real dial-in, to capture one.' },
  { key: 'paymentCallback', title: 'Payment callback', emptyHint: 'Take (or simulate) a payment to capture one.' },
  { key: 'preapprovalCallback', title: 'Preapproval callback', emptyHint: 'Only fires in live mode, once a customer completes a real direct-debit mandate prompt.' },
  { key: 'statusCheck', title: 'Transaction status check', emptyHint: 'Only fires in live mode, when the reconcile sweep checks a pending transaction.' },
];

function formatSamplesForCopy(samples: DiagnosticsSamples): string {
  const lines = ['HUBTEL INTEGRATION — REAL CAPTURED REQUEST/RESPONSE PAYLOADS', '='.repeat(60), ''];
  for (const { key, title, emptyHint } of SAMPLE_SECTIONS) {
    const sample = samples[key];
    lines.push(`--- ${title} ---`);
    if (!sample) {
      lines.push(`(not captured on this server yet — ${emptyHint})`, '');
      continue;
    }
    lines.push(`Captured: ${new Date(sample.capturedAt).toLocaleString()}`, sample.note, '', 'Request:', JSON.stringify(sample.request, null, 2), '', 'Response:', JSON.stringify(sample.response, null, 2), '');
  }
  return lines.join('\n');
}

interface Probe {
  service: string;
  host: string;
  verdict: 'reachable' | 'blocked' | 'timeout' | 'error';
  detail: string;
  httpStatus?: number;
}

interface DiagnosticsSamples {
  ussd: SamplePayload | null;
  paymentCallback: SamplePayload | null;
  preapprovalCallback: SamplePayload | null;
  statusCheck: SamplePayload | null;
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
  samples: DiagnosticsSamples;
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

  const [testMsisdn, setTestMsisdn] = useState('');
  const [testNetwork, setTestNetwork] = useState('MTN');
  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<PreapprovalTestResult | null>(null);

  async function runPreapprovalTest() {
    if (!testMsisdn.trim()) return;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await api.post<PreapprovalTestResult>('/settings/hubtel-diagnostics/test-preapproval', {
        msisdn: testMsisdn.trim(), network: testNetwork,
      });
      setTestResult(result);
    } catch (e) {
      setTestError(e instanceof ApiError ? e.message : 'Could not reach the server to run the test.');
    } finally {
      setTesting(false);
    }
  }

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
            <p className="text-sm font-medium text-gray-800">Test a direct-debit preapproval</p>
            <p className="text-xs text-gray-500 mt-0.5">
              Sends a real Hubtel preapproval-initiate call for the number below and shows the exact HTTP status and
              response body — the same call a contract&apos;s &quot;Direct debit&quot; setup makes, except a normal
              contract creation swallows any failure silently so staff never see it. Use this to tell an
              un-whitelisted IP, bad credentials, and a malformed number apart when the customer says no prompt
              arrived.
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <Label>Mobile money number</Label>
              <Input className="mt-1.5 w-44" placeholder="0244000111" value={testMsisdn} onChange={(e) => setTestMsisdn(e.target.value)} />
            </div>
            <div>
              <Label>Network</Label>
              <select
                className="mt-1.5 flex h-10 border border-input bg-white/90 px-3 py-2 text-sm"
                value={testNetwork}
                onChange={(e) => setTestNetwork(e.target.value)}
              >
                {DIRECT_DEBIT_NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
            <Button type="button" variant="outline" disabled={!testMsisdn.trim() || testing} onClick={runPreapprovalTest}>
              {testing ? 'Sending...' : 'Send test preapproval'}
            </Button>
          </div>
          <p className="text-xs text-amber-600">
            This is a real call — if Hubtel accepts it, this number really is prompted, same as production. No
            record is saved in the app either way.
          </p>
          {testError && <p className="text-sm text-red-600">{testError}</p>}
          {testResult && (
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500">HTTP status:</span>
                <Badge variant={testResult.httpStatus >= 200 && testResult.httpStatus < 300 ? 'success' : 'destructive'}>
                  {testResult.httpStatus}
                </Badge>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Request</p>
                <pre className="text-xs bg-gray-50 ring-1 ring-gray-200/60 rounded-lg p-3 overflow-x-auto">
                  {testResult.requestUrl}
                  {'\n'}
                  {JSON.stringify(testResult.requestPayload, null, 2)}
                </pre>
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Response (from Hubtel, unedited)</p>
                <pre className="text-xs bg-gray-50 ring-1 ring-gray-200/60 rounded-lg p-3 overflow-x-auto whitespace-pre-wrap">
                  {typeof testResult.responseBody === 'string' ? testResult.responseBody : JSON.stringify(testResult.responseBody, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>

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

        {diagnostics && (
          <div className="border-t border-gray-100 pt-4 space-y-2">
            <button
              type="button"
              className="text-sm font-medium text-gray-800 hover:text-gray-600"
              onClick={() => setShowSamples((v) => !v)}
            >
              {showSamples ? 'Hide' : 'Show'} sample request/response payloads
            </button>
            <p className="text-xs text-gray-400">
              Real traffic this server has actually handled — not illustrative examples. A section reading
              &quot;not captured yet&quot; means nothing has gone through that path here.
            </p>
            {showSamples && (
              <div className="space-y-4">
                {SAMPLE_SECTIONS.map(({ key, title, emptyHint }) => {
                  const sample = diagnostics.samples[key];
                  return (
                    <div key={key} className="border border-gray-100 rounded-lg p-3 space-y-1.5">
                      <div className="flex items-center justify-between gap-2 flex-wrap">
                        <p className="text-sm font-medium text-gray-800">{title}</p>
                        {sample && <span className="text-xs text-gray-400">{new Date(sample.capturedAt).toLocaleString()}</span>}
                      </div>
                      {sample ? (
                        <>
                          <p className="text-xs text-gray-500">{sample.note}</p>
                          <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Request</p>
                            <pre className="text-xs bg-gray-50 ring-1 ring-gray-200/60 rounded-lg p-3 overflow-x-auto">
                              {JSON.stringify(sample.request, null, 2)}
                            </pre>
                          </div>
                          <div>
                            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Response</p>
                            <pre className="text-xs bg-gray-50 ring-1 ring-gray-200/60 rounded-lg p-3 overflow-x-auto">
                              {JSON.stringify(sample.response, null, 2)}
                            </pre>
                          </div>
                        </>
                      ) : (
                        <p className="text-xs text-gray-400">Not captured on this server yet — {emptyHint}</p>
                      )}
                    </div>
                  );
                })}
                <Button type="button" size="sm" variant="outline" onClick={() => copy(formatSamplesForCopy(diagnostics.samples), 'samples')}>
                  {copied === 'samples' ? 'Copied' : 'Copy for Hubtel'}
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
