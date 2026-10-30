'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDate } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';

type Status = 'PENDING' | 'PAYABLE' | 'ON_HOLD' | 'FORFEITED' | 'PAID';

interface Row {
  id: string;
  contractId: string;
  contractNumber: string;
  completedAt: string | null;
  customerName: string;
  agentId: string;
  agentName: string;
  deferredMinor: number;
  bonusMinor: number;
  totalMinor: number;
  status: Status;
  paidAt: string | null;
  reference: string | null;
  needsReview: boolean;
}

const LABELS: Record<Status, string> = {
  PENDING: 'Customer still paying', PAYABLE: 'Ready to pay', ON_HOLD: 'On hold (defaulted)', FORFEITED: 'Forfeited', PAID: 'Paid',
};
const BADGE: Record<Status, string> = {
  PENDING: 'bg-gray-50 text-gray-700 ring-1 ring-gray-200/60',
  PAYABLE: 'bg-blue-50 text-blue-700 ring-1 ring-blue-200/60',
  ON_HOLD: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60',
  FORFEITED: 'bg-red-50 text-red-700 ring-1 ring-red-200/60',
  PAID: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60',
};

/**
 * Commission held back until the customer completes, plus any completion
 * bonus (Settings > Agent commission), for a manager on the Agent Ledger:
 * ready to pay first, with "Mark paid" for those who handle money.
 */
export function CompletionCommissions({ canPay }: { canPay: boolean }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<Row[]>([]);
  const [totals, setTotals] = useState<Record<Status, { count: number; totalMinor: number }> | null>(null);
  const [status, setStatus] = useState<Status | '__all__'>('PAYABLE');
  const [agentId, setAgentId] = useState('__all__');
  const [month, setMonth] = useState('');
  const [payTarget, setPayTarget] = useState<Row | null>(null);
  const [reference, setReference] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const q = new URLSearchParams();
    if (status !== '__all__') q.set('status', status);
    if (agentId !== '__all__') q.set('agentId', agentId);
    if (month) q.set('month', month);
    try {
      const data = await api.get<{ rows: Row[]; totals: Record<Status, { count: number; totalMinor: number }> }>(`/agent/completion-commissions?${q}`);
      setRows(data.rows);
      setTotals(data.totals);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load completion commission', variant: 'destructive' });
    }
  }, [status, agentId, month, toast]);

  useEffect(() => { load(); }, [load]);

  async function act(row: Row, action: 'paid' | 'undo') {
    setBusyId(row.id);
    try {
      await api.post(`/agent/completion-commissions/${row.id}/${action}`, action === 'paid' ? { reference } : {});
      toast({ title: action === 'paid' ? 'Marked paid' : 'Payment undone' });
      setPayTarget(null);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to save', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  // Nothing has ever been held back or offered as a bonus: keep the page as it was.
  if (agentId === '__all__' && totals && Object.values(totals).every((t) => t.count === 0)) return null;

  const agents = [...new Map(rows.map((r) => [r.agentId, r.agentName])).entries()];

  return (
    <div>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Paid on completion</h2>
      {totals && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
          <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Ready to pay</p><p className="text-lg font-semibold text-blue-700">{formatCurrency(totals.PAYABLE.totalMinor)}</p><p className="text-xs text-gray-500">{totals.PAYABLE.count} sale{totals.PAYABLE.count === 1 ? '' : 's'}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Customers still paying</p><p className="text-lg font-semibold text-gray-900">{formatCurrency(totals.PENDING.totalMinor)}</p><p className="text-xs text-gray-500">{totals.PENDING.count} sale{totals.PENDING.count === 1 ? '' : 's'}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-gray-500">On hold (defaulted)</p><p className="text-lg font-semibold text-amber-700">{formatCurrency(totals.ON_HOLD.totalMinor)}</p><p className="text-xs text-gray-500">{totals.ON_HOLD.count} sale{totals.ON_HOLD.count === 1 ? '' : 's'}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Paid</p><p className="text-lg font-semibold text-emerald-700">{formatCurrency(totals.PAID.totalMinor)}</p><p className="text-xs text-gray-500">{totals.PAID.count} sale{totals.PAID.count === 1 ? '' : 's'}</p></CardContent></Card>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mb-3">
        <div className="w-48">
          <Select value={status} onValueChange={(v) => setStatus(v as Status | '__all__')}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">Every status</SelectItem>
              {(Object.keys(LABELS) as Status[]).map((s) => <SelectItem key={s} value={s}>{LABELS[s]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {(agents.length > 1 || agentId !== '__all__') && (
          <div className="w-48">
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All agents</SelectItem>
                {agents.map(([id, name]) => <SelectItem key={id} value={id}>{name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        )}
        <Input type="month" className="w-44" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month completed" />
      </div>

      {rows.length === 0 ? (
        <Card><CardContent className="text-center py-8 px-4"><p className="text-sm text-gray-500">Nothing here with these filters</p></CardContent></Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Card key={r.id} className={r.needsReview ? 'border-red-200 ring-1 ring-red-100' : undefined}>
              <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-900">{r.agentName} &middot; {formatCurrency(r.totalMinor)}</p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    <Link href={`/contracts/${r.contractId}`} className="font-mono text-blue-700 hover:underline">{r.contractNumber}</Link>
                    {' '}&middot; {r.customerName}
                    {r.completedAt && <> &middot; completed {formatDate(r.completedAt)}</>}
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    Held back {formatCurrency(r.deferredMinor)}{r.bonusMinor > 0 && <> + bonus {formatCurrency(r.bonusMinor)}</>}
                    {r.status === 'PAID' && <> &middot; paid {r.paidAt && formatDate(r.paidAt)}, ref {r.reference}</>}
                  </p>
                  {r.needsReview && <p className="text-xs text-red-600 font-medium mt-1">Paid, but the contract is no longer completed (a payment was reversed). Check it.</p>}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Badge className={BADGE[r.status]}>{LABELS[r.status]}</Badge>
                  {canPay && r.status === 'PAYABLE' && (
                    <Button size="sm" onClick={() => { setPayTarget(r); setReference(''); }}>Mark paid</Button>
                  )}
                  {canPay && r.status === 'PAID' && (
                    <Button size="sm" variant="outline" disabled={busyId === r.id} onClick={() => act(r, 'undo')}>Undo</Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!payTarget} onOpenChange={(open) => { if (!open) setPayTarget(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Mark paid — {payTarget?.agentName}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              {payTarget && formatCurrency(payTarget.totalMinor)} for {payTarget?.contractNumber}, which the customer has paid off. Pay the agent first, then record it here.
            </p>
            <div>
              <Label htmlFor="completion-ref">Payment reference</Label>
              <Input id="completion-ref" className="mt-1.5" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transaction ID or receipt number" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayTarget(null)}>Cancel</Button>
            <Button disabled={!reference.trim() || busyId === payTarget?.id} onClick={() => payTarget && act(payTarget, 'paid')}>
              {busyId === payTarget?.id ? 'Saving...' : 'Mark paid'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
