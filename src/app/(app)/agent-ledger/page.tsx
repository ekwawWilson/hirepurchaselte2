'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Wallet } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDateTime, cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

interface Remittance {
  id: string;
  amountMinor: number;
  method: string;
  reference: string | null;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
}
interface LedgerEntry {
  id: string;
  depositAmountMinor: number;
  commissionAmountMinor: number;
  amountOwedMinor: number;
  amountRemittedMinor: number;
  status: string;
  agent: { id: string; firstName: string; lastName: string; email: string };
  contract: { id: string; contractNumber: string; customer: { firstName: string; lastName: string; membershipId: string } };
  remittances: Remittance[];
}

const METHOD_LABELS: Record<string, string> = { CASH: 'Cash at branch', MOBILE_MONEY: 'Mobile money', BANK_TRANSFER: 'Bank transfer' };

/**
 * The Agent module: every agent's deposit-custody ledger, for a
 * BRANCH_MANAGER/ADMIN/SUPER_ADMIN/AUDITOR (agent.ledger.manage) to review
 * and confirm or reject filed remittances against (agentLedgerService.ts).
 */
export default function AgentLedgerPage() {
  const { toast } = useToast();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [rejectTarget, setRejectTarget] = useState<Remittance | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const { entries } = await api.get<{ entries: LedgerEntry[] }>('/agent/ledger/all');
      setEntries(entries);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load agent ledgers', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  async function confirm(r: Remittance) {
    setBusyId(r.id);
    try {
      await api.patch(`/agent/remittances/${r.id}`, { action: 'confirm' });
      toast({ title: 'Remittance confirmed' });
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to confirm', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  async function reject() {
    if (!rejectTarget || !reason.trim()) return;
    setBusyId(rejectTarget.id);
    try {
      await api.patch(`/agent/remittances/${rejectTarget.id}`, { action: 'reject', reason });
      toast({ title: 'Remittance rejected' });
      setRejectTarget(null);
      setReason('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to reject', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  const totalOwed = entries.reduce((s, e) => s + Math.max(0, e.amountOwedMinor - e.amountRemittedMinor), 0);
  const pendingRemittances = entries.flatMap((e) => e.remittances.filter((r) => r.status === 'PENDING').map((r) => ({ ...r, entry: e })));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Agent Ledger</h1>
        <p className="text-sm text-gray-500 mt-0.5">Cash deposits collected by agents, and what each still owes</p>
      </div>

      <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Total still owed, across every agent</p><p className="text-lg font-semibold text-red-600">{formatCurrency(totalOwed)}</p></CardContent></Card>

      {isLoading ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
      ) : (
        <>
          {pendingRemittances.length > 0 && (
            <div>
              <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Awaiting confirmation</h2>
              <div className="space-y-3">
                {pendingRemittances.map((r) => (
                  <Card key={r.id}>
                    <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900">
                          {r.entry.agent.firstName} {r.entry.agent.lastName} &middot; {formatCurrency(r.amountMinor)} via {METHOD_LABELS[r.method] ?? r.method}
                        </p>
                        <p className="text-xs text-gray-500 mt-0.5">
                          For <Link href={`/contracts/${r.entry.contract.id}`} className="font-mono text-blue-700 hover:underline">{r.entry.contract.contractNumber}</Link>
                          {r.reference && <> &middot; ref {r.reference}</>} &middot; filed {formatDateTime(r.createdAt)}
                        </p>
                      </div>
                      <div className="flex gap-2 shrink-0">
                        <Button size="sm" variant="outline" disabled={busyId === r.id} onClick={() => { setRejectTarget(r); setReason(''); }}>Reject</Button>
                        <Button size="sm" disabled={busyId === r.id} onClick={() => confirm(r)}>{busyId === r.id ? 'Confirming...' : 'Confirm'}</Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          )}

          <div>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Every deposit collected</h2>
            {entries.length === 0 ? (
              <Card><CardContent className="text-center py-12 px-4"><Wallet className="h-8 w-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-500">No agent deposit collections yet</p></CardContent></Card>
            ) : (
              <div className="space-y-2">
                {entries.map((e) => {
                  const due = Math.max(0, e.amountOwedMinor - e.amountRemittedMinor);
                  return (
                    <Card key={e.id}>
                      <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900">{e.agent.firstName} {e.agent.lastName}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            <Link href={`/contracts/${e.contract.id}`} className="font-mono text-blue-700 hover:underline">{e.contract.contractNumber}</Link>
                            {' '}&middot; {e.contract.customer.firstName} {e.contract.customer.lastName} &middot; Collected {formatCurrency(e.depositAmountMinor)} &middot; Owed {formatCurrency(e.amountOwedMinor)}
                          </p>
                        </div>
                        <div className={cn('text-right shrink-0')}>
                          <Badge className={e.status === 'SETTLED' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60'}>{e.status}</Badge>
                          {due > 0 && <p className="text-xs text-red-600 mt-1">{formatCurrency(due)} outstanding</p>}
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      <Dialog open={!!rejectTarget} onOpenChange={(open) => !open && setRejectTarget(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reject this remittance</DialogTitle></DialogHeader>
          <div>
            <Label htmlFor="reject-reason">Reason</Label>
            <Textarea id="reject-reason" className="mt-1.5" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Amount doesn't match what was counted" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>Cancel</Button>
            <Button variant="destructive" disabled={!reason.trim() || busyId === rejectTarget?.id} onClick={reject}>Reject</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
