'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

interface Detail {
  device: {
    id: string; imei: string; deviceTag: string | null; enrollmentStatus: string; committedState: string;
    providerExpiresAt: string | null; scheduleExpiresAt: string | null; releaseAfter: string | null; releaseHeld: boolean;
    lastConnectAt: string | null; apkVersion: string | null; pinUnlocksUsed: number; awaitingPinSince: string | null; lastError: string | null;
  };
  contract: { id: string; contractNumber: string; status: string; balanceMinor: number | null; customer: { firstName: string; lastName: string; phone: string | null } } | null;
  item: { serialNumber: string; status: string; product: { name: string } } | null;
  timeline: Array<{ id: string; action: string; success: boolean; dryRun: boolean; providerCode: string | null; skippedReason: string | null; createdAt: string }>;
}

const STATE_LABELS: Record<string, string> = { LOCKED: 'Locked', UNLOCKED: 'Open', PENDING: 'Sent, not yet confirmed by the phone', UNKNOWN: 'Not heard from yet' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-gray-500">{label}</dt><dd className="text-sm text-gray-900 mt-0.5">{children}</dd></div>;
}

/** One PayTrigger phone: its state, its contract, what staff can do, and every request made about it. */
export default function PayTriggerDevicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canView = hasPermission('paytrigger.view');
  const canManage = hasPermission('paytrigger.manage');
  const canPin = hasPermission('paytrigger.pin');
  const canRelease = hasPermission('paytrigger.release');
  const { toast } = useToast();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<'message' | 'pin' | 'release' | null>(null);
  const [message, setMessage] = useState({ title: '', content: '', pushType: 1 });
  const [pin, setPin] = useState<{ pin: string | null; message: string; needsKey?: boolean } | null>(null);
  const [key, setKey] = useState('');
  const [confirmText, setConfirmText] = useState('');

  const load = useCallback(() => {
    api.get<Detail>(`/paytrigger/devices/${id}`).then(setDetail).catch((e) => toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load this phone', variant: 'destructive' }));
  }, [id, toast]);
  useEffect(() => { if (canView) load(); }, [canView, load]);

  async function act<T>(action: string, body: Record<string, unknown> = {}, done?: (r: T) => void) {
    setBusy(true);
    try {
      const r = await api.post<T>(`/paytrigger/devices/${id}/${action}`, body);
      done?.(r);
      load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'PayTrigger request failed', variant: 'destructive' });
    } finally {
      setBusy(false);
    }
  }

  if (!canView) return <AccessDenied message="You don't have permission to view PayTrigger." hint="Ask an administrator for the paytrigger.view permission." />;
  if (!detail) return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  const { device, contract, item, timeline } = detail;
  const active = device.enrollmentStatus === 'ACTIVE';

  return (
    <div className="space-y-5">
      <Link href="/paytrigger" className="inline-flex items-center text-sm text-gray-500 hover:text-gray-700"><ArrowLeft className="h-4 w-4 mr-1" />PayTrigger</Link>
      <div>
        <h1 className="text-2xl font-bold text-gray-900 font-mono">{device.imei}</h1>
        <p className="text-sm text-gray-500">{item?.product.name ?? 'Unknown product'}{device.deviceTag && <> &middot; device tag {device.deviceTag}</>}</p>
      </div>

      {device.lastError && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{device.lastError}</div>}
      {device.awaitingPinSince && (
        <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Paid up, but the phone still reports locked (since {formatDateTime(device.awaitingPinSince)}): it has not been online to hear. Ask the customer to turn on data, or give them an offline PIN.
        </div>
      )}

      <Card>
        <CardContent className="p-4">
          <dl className="grid gap-4 sm:grid-cols-3">
            <Field label="Enrolment">{device.enrollmentStatus}</Field>
            <Field label="Phone reports">{STATE_LABELS[device.committedState] ?? device.committedState}</Field>
            <Field label="Lock date PayTrigger holds">{device.providerExpiresAt ? formatDateTime(device.providerExpiresAt) : '—'}</Field>
            <Field label="Lock date the contract implies">{device.scheduleExpiresAt ? formatDateTime(device.scheduleExpiresAt) : '—'}</Field>
            <Field label="Last online">{device.lastConnectAt ? formatDateTime(device.lastConnectAt) : '—'}</Field>
            <Field label="Offline PINs used">{device.pinUnlocksUsed} of 4</Field>
            {device.releaseAfter && <Field label="Lock removed after">{formatDateTime(device.releaseAfter)}{device.releaseHeld && ' (held)'}</Field>}
            <Field label="Contract">
              {contract ? (
                <Link href={`/contracts/${contract.id}`} className="text-primary hover:underline">
                  {contract.contractNumber} &middot; {contract.customer.firstName} {contract.customer.lastName} &middot; {contract.status} &middot; balance {formatCurrency(contract.balanceMinor ?? 0)}
                </Link>
              ) : 'Not sold'}
            </Field>
          </dl>
        </CardContent>
      </Card>

      <div className="flex flex-wrap gap-2">
        {canManage && contract && <Button size="sm" disabled={busy} onClick={() => act<{ outcome: { outcome: string; reason: string } }>('reconcile', { force: true }, (r) => toast({ title: r.outcome.outcome, description: r.outcome.reason }))}>Reconcile now</Button>}
        {canManage && <Button size="sm" variant="outline" disabled={busy} onClick={() => act<{ message: string }>('verify', {}, (r) => toast({ title: 'PayTrigger says', description: r.message }))}>Check with PayTrigger</Button>}
        {canManage && active && <Button size="sm" variant="outline" disabled={busy} onClick={() => setDialog('message')}>Send a message</Button>}
        {canPin && active && contract && <Button size="sm" variant="outline" disabled={busy} onClick={() => { setPin(null); setKey(''); setDialog('pin'); }}>Offline PIN</Button>}
        {canManage && device.releaseAfter && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act('hold-release', { held: !device.releaseHeld })}>{device.releaseHeld ? 'Let the release go ahead' : 'Hold the release'}</Button>
        )}
        {canManage && ['QUEUED', 'FAILED'].includes(device.enrollmentStatus) && (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => act('cancel-enrolment', {}, () => toast({ title: 'Enrolment cancelled' }))}>Cancel enrolment</Button>
        )}
        {canRelease && active && contract?.status === 'COMPLETED' && <Button size="sm" variant="destructive" disabled={busy} onClick={() => { setConfirmText(''); setDialog('release'); }}>Remove the lock now</Button>}
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">History</CardTitle></CardHeader>
        <CardContent>
          {timeline.length === 0 ? <p className="text-sm text-gray-400">Nothing yet</p> : timeline.map((t) => (
            <div key={t.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b last:border-0 py-2 text-sm">
              <span>
                <span className={cn('font-medium', t.success ? 'text-gray-900' : 'text-red-700')}>{t.action}</span>
                {t.dryRun && <span className="ml-2 rounded bg-amber-100 px-1.5 text-xs text-amber-800">simulated</span>}
                {t.providerCode && <span className="ml-2 text-xs text-gray-500">code {t.providerCode}</span>}
                {t.skippedReason && <span className="block text-xs text-gray-600">{t.skippedReason}</span>}
              </span>
              <span className="text-xs text-gray-500">{formatDateTime(t.createdAt)}</span>
            </div>
          ))}
        </CardContent>
      </Card>

      <Dialog open={dialog === 'message'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Message the phone</DialogTitle></DialogHeader>
          <p className="text-xs text-gray-500">PayTrigger allows 3 pop-ups and 3 notifications a day per phone.</p>
          <div className="space-y-3">
            <select className="h-10 w-full border border-input bg-white px-2 text-sm" value={message.pushType} onChange={(e) => setMessage({ ...message, pushType: Number(e.target.value) })}>
              <option value={1}>Pop-up</option><option value={2}>Notification</option>
            </select>
            <div><Label>Title</Label><Input className="mt-1.5" maxLength={80} value={message.title} onChange={(e) => setMessage({ ...message, title: e.target.value })} /></div>
            <div><Label>Message</Label><Textarea className="mt-1.5" maxLength={500} rows={4} value={message.content} onChange={(e) => setMessage({ ...message, content: e.target.value })} /></div>
          </div>
          <DialogFooter>
            <Button disabled={busy} onClick={() => act<{ dryRun: boolean }>('message', message, (r) => { setDialog(null); toast({ title: r.dryRun ? 'Simulated (dry run)' : 'Sent' }); })}>Send</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'pin'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Offline PIN</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">For a paid-up customer whose phone has no data. The contract is brought up to date first; the PIN opens the phone only if PayTrigger then holds a lock date in the future. Each phone gets 4.</p>
          {pin?.pin && <p className="text-center text-3xl font-mono font-bold tracking-widest py-3">{pin.pin}</p>}
          {pin && <p className="text-sm text-gray-700">{pin.message}</p>}
          {pin?.needsKey && <div><Label>4-digit key shown on the lock screen</Label><Input className="mt-1.5" inputMode="numeric" maxLength={4} value={key} onChange={(e) => setKey(e.target.value)} /></div>}
          <DialogFooter>
            {!pin?.pin && <Button disabled={busy || (!!pin?.needsKey && key.length !== 4)} onClick={() => act<{ pin: string | null; message: string; needsKey?: boolean }>('pin', pin?.needsKey ? { key } : {}, setPin)}>Get PIN</Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === 'release'} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Remove the lock for good</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">PayTrigger uninstalls itself from the phone. This cannot be undone: the phone can never be locked again. The daily sweep does this on its own after the hold period. Type RELEASE to do it now.</p>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="RELEASE" />
          <DialogFooter>
            <Button variant="destructive" disabled={busy || confirmText !== 'RELEASE'} onClick={() => act<{ message: string }>('release', { confirm: confirmText }, (r) => { setDialog(null); toast({ title: r.message }); })}>Remove the lock</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
