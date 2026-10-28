'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Lock, RefreshCw } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { AccessDenied } from '@/components/AccessDenied';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDateTime, cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';

interface ContractRef { id: string; contractNumber: string; status: string; customer: { firstName: string; lastName: string; phone?: string | null } }
interface Device {
  id: string; imei: string; enrollmentStatus: string; committedState: string; providerExpiresAt: string | null; scheduleExpiresAt: string | null;
  lastError: string | null; awaitingPinSince: string | null; lastConnectAt: string | null; contract: ContractRef | null;
}
interface Health {
  config: { keySet: boolean; dryRun: boolean; liveActionsEnabled: boolean; live: boolean; canary: string[] };
  licence: { ok: boolean; error: string | null; remainingAmountOfLicense?: number; totalAmountOfLicense?: number } | null;
  devices: Record<string, number>;
  lastSweepAt: string | null;
}
interface Issues {
  paidStillLocked: Device[]; depositHeld: Array<Device & { owedMinor: number | null }>; lockNotConfirmed: Device[]; unenforceable: Device[];
  failing: Device[]; stale: Device[]; sweepLate: boolean; lastSweepAt: string | null;
  soldNotEnrolled: Array<{ id: string; contractNumber: string; status: string; customer: { firstName: string; lastName: string }; device: { enrollmentStatus: string; lastError: string | null } | null }>;
}
interface Candidate { id: string; serialNumber: string; status: string; productName: string; branchName: string; imeiValid: boolean; device: { enrollmentStatus: string; lastError: string | null } | null }
interface Product { id: string; name: string; sku: string; brand: string | null; payTriggerBrand: string | null; suggestedBrand: string | null }
type Settings = Record<string, string | number | boolean | null>;

const TABS = [
  { key: 'attention', label: 'Needs attention' },
  { key: 'phones', label: 'Phones' },
  { key: 'enrol', label: 'Enrol stock' },
  { key: 'products', label: 'Products' },
  { key: 'settings', label: 'Settings' },
] as const;
type Tab = (typeof TABS)[number]['key'];

const STATE_LABELS: Record<string, string> = { LOCKED: 'Locked', UNLOCKED: 'Open', PENDING: 'Sent, not confirmed', UNKNOWN: 'Not heard from' };
const ENROLMENT_LABELS: Record<string, string> = {
  QUEUED: 'Enrolled, not switched on', ACTIVE: 'Active', UNENFORCEABLE: 'Cannot be enforced', FAILED: 'Enrolment failed', CANCELLED: 'Enrolment cancelled', REMOVED: 'Lock removed',
};
const customerName = (c: ContractRef | null) => (c ? `${c.customer.firstName} ${c.customer.lastName}` : 'No contract');

function Spinner() {
  return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
}

/**
 * Device Financing phone locks (Transsion PayTrigger): what needs a person,
 * every enrolled phone, enrolling new TECNO/Infinix/itel stock, which
 * products are PayTrigger phones, and when phones lock.
 */
export default function PayTriggerPage() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canView = hasPermission('paytrigger.view');
  const canManage = hasPermission('paytrigger.manage');
  const canSettings = hasPermission('settings.manage');
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>('attention');
  const [health, setHealth] = useState<Health | null>(null);
  const [sweeping, setSweeping] = useState(false);

  const fail = useCallback((e: unknown, fallback: string) => {
    toast({ title: 'Error', description: e instanceof ApiError ? e.message : fallback, variant: 'destructive' });
  }, [toast]);

  const loadHealth = useCallback(() => {
    api.get<Health>('/paytrigger/health').then(setHealth).catch((e) => fail(e, 'Could not load PayTrigger status'));
  }, [fail]);
  useEffect(() => { if (canView) loadHealth(); }, [canView, loadHealth]);

  async function runSweep() {
    setSweeping(true);
    try {
      const { summary } = await api.post<{ summary: Record<string, number | boolean> }>('/paytrigger/sweep', {});
      toast({ title: 'Sweep finished', description: `${summary.reconciled} reconciled, ${summary.sent} sent, ${summary.released} released, ${summary.errors} errors` });
      loadHealth();
    } catch (e) {
      fail(e, 'The sweep failed');
    } finally {
      setSweeping(false);
    }
  }

  if (!canView) return <AccessDenied message="You don't have permission to view PayTrigger." hint="Ask an administrator for the paytrigger.view permission." />;

  const mode = !health ? null
    : health.config.live ? (health.config.canary.length ? `Live for ${health.config.canary.length} test contract(s) only` : 'Live')
      : !health.config.keySet ? 'Dry run: no API key set' : 'Dry run: nothing is sent to phones';

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">PayTrigger</h1>
          <p className="text-sm text-gray-500 mt-0.5">Device Financing phones that lock when an instalment is still unpaid after the grace period</p>
        </div>
        {canManage && (
          <Button variant="outline" size="sm" onClick={runSweep} disabled={sweeping}>
            <RefreshCw className={cn('h-4 w-4 mr-1.5', sweeping && 'animate-spin')} />Run the daily sweep now
          </Button>
        )}
      </div>

      {health && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className={cn('rounded-full px-2.5 py-1 font-semibold', health.config.live ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800')}>{mode}</span>
          {health.licence && (
            <span className={cn('rounded-full px-2.5 py-1', health.licence.ok ? 'bg-gray-100 text-gray-700' : 'bg-red-100 text-red-700')}>
              {health.licence.ok ? `${health.licence.remainingAmountOfLicense ?? '?'} of ${health.licence.totalAmountOfLicense ?? '?'} licences left` : `Licences: ${health.licence.error}`}
            </span>
          )}
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-700">
            {Object.values(health.devices).reduce((s, n) => s + n, 0)} phones &middot; {health.devices.ACTIVE ?? 0} active
          </span>
          <span className="rounded-full bg-gray-100 px-2.5 py-1 text-gray-700">Last sweep: {health.lastSweepAt ? formatDateTime(health.lastSweepAt) : 'never'}</span>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={cn('rounded-full px-3 py-1.5 text-xs font-semibold transition-colors', tab === t.key ? 'bg-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'attention' && <AttentionTab onError={fail} />}
      {tab === 'phones' && <PhonesTab onError={fail} />}
      {tab === 'enrol' && (canManage ? <EnrolTab onError={fail} onDone={loadHealth} /> : <p className="text-sm text-gray-500">Enrolling needs the paytrigger.manage permission.</p>)}
      {tab === 'products' && <ProductsTab onError={fail} canEdit={canSettings} />}
      {tab === 'settings' && <SettingsTab onError={fail} canEdit={canSettings} />}
    </div>
  );
}

type OnError = (e: unknown, fallback: string) => void;

function DeviceRow({ d, extra }: { d: Device; extra?: React.ReactNode }) {
  return (
    <Link href={`/paytrigger/${d.id}`} className="block border-b last:border-0 py-2.5 hover:bg-gray-50 px-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium text-gray-900">{customerName(d.contract)}{d.contract && <span className="ml-2 font-mono text-xs text-gray-500">{d.contract.contractNumber}</span>}</span>
        <span className="font-mono text-xs text-gray-500">{d.imei}</span>
      </div>
      <p className="text-xs text-gray-600 mt-0.5">
        {STATE_LABELS[d.committedState] ?? d.committedState}
        {d.providerExpiresAt && <> &middot; lock date {formatDateTime(d.providerExpiresAt)}</>}
        {extra}
      </p>
      {d.lastError && <p className="text-xs text-red-600 mt-0.5">{d.lastError}</p>}
    </Link>
  );
}

function IssueGroup({ title, hint, count, children }: { title: string; hint: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title} <span className="ml-1 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700">{count}</span></CardTitle>
        <p className="text-xs text-gray-500">{hint}</p>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function AttentionTab({ onError }: { onError: OnError }) {
  const [issues, setIssues] = useState<Issues | null>(null);
  useEffect(() => { api.get<Issues>('/paytrigger/issues').then(setIssues).catch((e) => onError(e, 'Could not load issues')); }, [onError]);
  if (!issues) return <Spinner />;
  const total = issues.paidStillLocked.length + issues.depositHeld.length + issues.soldNotEnrolled.length + issues.lockNotConfirmed.length
    + issues.unenforceable.length + issues.failing.length + issues.stale.length + (issues.sweepLate ? 1 : 0);
  if (total === 0) {
    return <Card><CardContent className="text-center py-12"><Lock className="h-8 w-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-500">Nothing needs attention</p></CardContent></Card>;
  }
  return (
    <div className="space-y-4">
      {issues.sweepLate && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          The daily PayTrigger sweep has not run since {issues.lastSweepAt ? formatDateTime(issues.lastSweepAt) : 'it was set up'}. Phones still lock on their own dates, but paid-off phones are not released.
        </div>
      )}
      <IssueGroup title="Paid, still locked" hint="Paid up, but the phone has not been online to hear it. Call the customer: ask them to turn on data, or give them an offline PIN from the phone's page." count={issues.paidStillLocked.length}>
        {issues.paidStillLocked.map((d) => <DeviceRow key={d.id} d={d} extra={<> &middot; since {formatDateTime(d.awaitingPinSince)}</>} />)}
      </IssueGroup>
      <IssueGroup title="Held for the agent's deposit" hint="Locked until the agent remits the deposit cash they took (Agent Ledger)." count={issues.depositHeld.length}>
        {issues.depositHeld.map((d) => <DeviceRow key={d.id} d={d} extra={<> &middot; {d.owedMinor === null ? 'no ledger entry yet' : `agent owes ${formatCurrency(d.owedMinor)}`}</>} />)}
      </IssueGroup>
      <IssueGroup title="Sold, not enrolled" hint="A Device Financing contract whose phone has no working enrolment: it will not lock. Enrol it (before it is switched on, or after a factory reset)." count={issues.soldNotEnrolled.length}>
        {issues.soldNotEnrolled.map((c) => (
          <Link key={c.id} href={`/contracts/${c.id}`} className="block border-b last:border-0 py-2.5 hover:bg-gray-50 px-1">
            <span className="font-medium text-gray-900">{c.customer.firstName} {c.customer.lastName}</span>
            <span className="ml-2 font-mono text-xs text-gray-500">{c.contractNumber}</span>
            <p className="text-xs text-red-600">{c.device ? `${ENROLMENT_LABELS[c.device.enrollmentStatus] ?? c.device.enrollmentStatus}${c.device.lastError ? `: ${c.device.lastError}` : ''}` : 'Never enrolled'}</p>
          </Link>
        ))}
      </IssueGroup>
      <IssueGroup title="Lock not confirmed" hint="More than a day past the lock date and the phone has not reported locking." count={issues.lockNotConfirmed.length}>
        {issues.lockNotConfirmed.map((d) => <DeviceRow key={d.id} d={d} />)}
      </IssueGroup>
      <IssueGroup title="Cannot be enforced" hint="PayTrigger cannot apply the lock on these phones." count={issues.unenforceable.length}>
        {issues.unenforceable.map((d) => <DeviceRow key={d.id} d={d} />)}
      </IssueGroup>
      <IssueGroup title="Failing" hint="The last request about these phones failed." count={issues.failing.length}>
        {issues.failing.map((d) => <DeviceRow key={d.id} d={d} />)}
      </IssueGroup>
      <IssueGroup title="Not heard from in 14 days" hint="Off, without data, or reset." count={issues.stale.length}>
        {issues.stale.map((d) => <DeviceRow key={d.id} d={d} extra={<> &middot; last online {formatDateTime(d.lastConnectAt)}</>} />)}
      </IssueGroup>
    </div>
  );
}

function PhonesTab({ onError }: { onError: OnError }) {
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [devices, setDevices] = useState<Device[] | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ ...(status && { status }), ...(q.trim() && { q: q.trim() }) });
      api.get<{ devices: Device[] }>(`/paytrigger/devices?${params}`).then((r) => setDevices(r.devices)).catch((e) => onError(e, 'Could not load phones'));
    }, 250);
    return () => clearTimeout(timer);
  }, [status, q, onError]);
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          <Input placeholder="Search by IMEI" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
          <select className="h-10 border border-input bg-white px-2 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Every enrolment state</option>
            {Object.entries(ENROLMENT_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
        </div>
        {!devices ? <Spinner /> : devices.length === 0 ? <p className="text-center text-sm text-gray-400 py-8">No phones</p>
          : devices.map((d) => <DeviceRow key={d.id} d={d} extra={<> &middot; {ENROLMENT_LABELS[d.enrollmentStatus] ?? d.enrollmentStatus}</>} />)}
      </CardContent>
    </Card>
  );
}

function EnrolTab({ onError, onDone }: { onError: OnError; onDone: () => void }) {
  const { toast } = useToast();
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [outcomes, setOutcomes] = useState<Array<{ imei: string; ok: boolean; message: string; modelWarning?: string }>>([]);
  const load = useCallback(() => {
    api.get<{ candidates: Candidate[] }>('/paytrigger/enrolment').then((r) => { setCandidates(r.candidates); setChosen(new Set()); }).catch((e) => onError(e, 'Could not load stock'));
  }, [onError]);
  useEffect(load, [load]);

  async function enrol() {
    setSaving(true);
    try {
      const r = await api.post<{ outcomes: Array<{ imei: string; ok: boolean; message: string; modelWarning?: string }> }>('/paytrigger/enrolment', { inventoryItemIds: [...chosen] });
      setOutcomes(r.outcomes);
      const ok = r.outcomes.filter((o) => o.ok).length;
      toast({ title: `${ok} of ${r.outcomes.length} enrolled`, variant: ok === r.outcomes.length ? 'default' : 'destructive' });
      load();
      onDone();
    } catch (e) {
      onError(e, 'Enrolment failed');
    } finally {
      setSaving(false);
    }
  }

  if (!candidates) return <Spinner />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-gray-600">
        Enrol TECNO, Infinix and itel stock before it is switched on: an enrolled phone locks itself on first switch-on and opens once its Device Financing contract is paid up. A phone set up before it was enrolled only takes the lock after a factory reset.
      </p>
      {outcomes.length > 0 && (
        <Card><CardContent className="p-4 space-y-1 text-sm">
          {outcomes.map((o) => (
            <p key={o.imei} className={o.ok ? 'text-green-700' : 'text-red-700'}>
              <span className="font-mono">{o.imei}</span>: {o.message}{o.modelWarning && <span className="text-amber-700"> ({o.modelWarning})</span>}
            </p>
          ))}
        </CardContent></Card>
      )}
      <Card>
        <CardContent className="p-4">
          {candidates.length === 0 ? <p className="text-center text-sm text-gray-400 py-8">No PayTrigger stock waiting to be enrolled. Mark products under Products first.</p> : (
            <>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm flex items-center gap-2">
                  <input type="checkbox" checked={chosen.size === candidates.filter((c) => c.imeiValid).length && chosen.size > 0}
                    onChange={(e) => setChosen(new Set(e.target.checked ? candidates.filter((c) => c.imeiValid).map((c) => c.id) : []))} />
                  All
                </label>
                <Button size="sm" onClick={enrol} disabled={saving || chosen.size === 0}>Enrol {chosen.size || ''}</Button>
              </div>
              {candidates.map((c) => (
                <label key={c.id} className="flex items-start gap-3 border-b last:border-0 py-2">
                  <input type="checkbox" className="mt-1" disabled={!c.imeiValid} checked={chosen.has(c.id)}
                    onChange={(e) => { const next = new Set(chosen); if (e.target.checked) next.add(c.id); else next.delete(c.id); setChosen(next); }} />
                  <span className="min-w-0">
                    <span className="font-mono text-sm">{c.serialNumber}</span>
                    <span className="ml-2 text-sm text-gray-700">{c.productName}</span>
                    <span className="block text-xs text-gray-500">{c.branchName} &middot; {c.status.toLowerCase()}
                      {c.device && <> &middot; {ENROLMENT_LABELS[c.device.enrollmentStatus] ?? c.device.enrollmentStatus}{c.device.lastError && `: ${c.device.lastError}`}</>}
                    </span>
                    {!c.imeiValid && <span className="block text-xs text-red-600">The serial number is not an IMEI (15 to 18 digits): correct it in Inventory first.</span>}
                  </span>
                </label>
              ))}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProductsTab({ onError, canEdit }: { onError: OnError; canEdit: boolean }) {
  const [products, setProducts] = useState<Product[] | null>(null);
  useEffect(() => { api.get<{ products: Product[] }>('/paytrigger/products').then((r) => setProducts(r.products)).catch((e) => onError(e, 'Could not load products')); }, [onError]);
  async function setBrand(productId: string, brand: string) {
    try {
      const r = await api.patch<{ products: Product[] }>('/paytrigger/products', { productId, brand: brand || null });
      setProducts(r.products);
    } catch (e) {
      onError(e, 'Could not save');
    }
  }
  if (!products) return <Spinner />;
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-sm text-gray-600 mb-3">
          A product marked here is a PayTrigger phone: it can only be sold on Device Financing, never on Deposit + Instalment. A suggestion comes from the name, but only what you mark counts.
        </p>
        {products.map((p) => (
          <div key={p.id} className="flex flex-wrap items-center justify-between gap-2 border-b last:border-0 py-2">
            <span className="min-w-0">
              <span className="font-medium text-gray-900">{p.name}</span>
              <span className="ml-2 text-xs text-gray-500">{p.sku}</span>
              {p.suggestedBrand && <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800">Looks like {p.suggestedBrand}</span>}
            </span>
            <select className="h-9 border border-input bg-white px-2 text-sm" disabled={!canEdit} value={p.payTriggerBrand ?? ''} onChange={(e) => setBrand(p.id, e.target.value)}>
              <option value="">Not a PayTrigger phone</option>
              <option value="TECNO">TECNO</option>
              <option value="INFINIX">Infinix</option>
              <option value="ITEL">itel</option>
            </select>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

const NUMBER_FIELDS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'lockAfterOverdueDays', label: 'Days after the grace period', hint: 'The phone locks at 08:30 this many days after the contract\'s grace period ends (1: the morning after).' },
  { key: 'maxUnlockHorizonDays', label: 'Furthest a phone is opened ahead (days)', hint: 'Caps how long any one payment keeps a phone open, so a mistake can never open one for long.' },
  { key: 'releaseHoldHours', label: 'Hours before a paid-off phone is released', hint: 'Time to catch a payment that bounces before the lock is removed for good.' },
  { key: 'extendBreakerPercent', label: 'Most phones one sweep may open (%)', hint: 'A safety stop: past this share of phones (and at least 5), the sweep stops opening them.' },
  { key: 'defaultRuleNum', label: 'Lock rule number (0 to 5)', hint: 'The ladder of restrictions configured on the PayTrigger portal.' },
];
const TEXT_FIELDS: Array<{ key: string; label: string; long?: boolean }> = [
  { key: 'lockTitle', label: 'Overdue lock screen: title' }, { key: 'lockTips', label: 'Overdue lock screen: text', long: true },
  { key: 'depositHoldTitle', label: 'Held for the agent\'s deposit: title' }, { key: 'depositHoldTips', label: 'Held for the agent\'s deposit: text', long: true },
  { key: 'unlinkedTitle', label: 'Phone with no contract: title' }, { key: 'unlinkedTips', label: 'Phone with no contract: text', long: true },
];

function SettingsTab({ onError, canEdit }: { onError: OnError; canEdit: boolean }) {
  const { toast } = useToast();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [placeholders, setPlaceholders] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get<{ settings: Settings; placeholders: string[] }>('/paytrigger/settings').then((r) => { setSettings(r.settings); setPlaceholders(r.placeholders); }).catch((e) => onError(e, 'Could not load settings'));
  }, [onError]);
  if (!settings) return <Spinner />;

  async function save() {
    setSaving(true);
    try {
      const body: Record<string, unknown> = { lockOnUnpaidAgentDeposit: settings!.lockOnUnpaidAgentDeposit };
      for (const f of NUMBER_FIELDS) body[f.key] = Number(settings![f.key]);
      for (const f of TEXT_FIELDS) body[f.key] = settings![f.key];
      const r = await api.patch<{ settings: Settings }>('/paytrigger/settings', body);
      setSettings(r.settings);
      toast({ title: 'Saved', description: 'New lock-screen text reaches each phone the next time its contract is reconciled.' });
    } catch (e) {
      onError(e, 'Could not save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardContent className="p-4 space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          {NUMBER_FIELDS.map((f) => (
            <div key={f.key}>
              <Label>{f.label}</Label>
              <Input type="number" className="mt-1.5" disabled={!canEdit} value={String(settings[f.key] ?? '')} onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })} />
              <p className="text-xs text-gray-500 mt-1">{f.hint}</p>
            </div>
          ))}
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" disabled={!canEdit} checked={!!settings.lockOnUnpaidAgentDeposit} onChange={(e) => setSettings({ ...settings, lockOnUnpaidAgentDeposit: e.target.checked })} />
          <span>Keep an agent&apos;s customer locked until the agent remits the deposit cash they took</span>
        </label>
        <p className="text-xs text-gray-500">Lock-screen messages may use: {placeholders.map((p) => `{${p}}`).join(' ')}. Titles up to 80 characters, text up to 400.</p>
        {TEXT_FIELDS.map((f) => (
          <div key={f.key}>
            <Label>{f.label}</Label>
            {f.long
              ? <Textarea className="mt-1.5" rows={3} disabled={!canEdit} value={String(settings[f.key] ?? '')} onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })} />
              : <Input className="mt-1.5" disabled={!canEdit} value={String(settings[f.key] ?? '')} onChange={(e) => setSettings({ ...settings, [f.key]: e.target.value })} />}
          </div>
        ))}
        {canEdit && <Button onClick={save} disabled={saving}>Save</Button>}
      </CardContent>
    </Card>
  );
}
