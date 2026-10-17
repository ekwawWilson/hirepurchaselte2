'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Wallet } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { AccessDenied } from '@/components/AccessDenied';
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
import { Input } from '@/components/ui/input';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { AGENT_CASH_HOLD_ALERT_DAYS } from '@/lib/constants/agents';

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
  commissionPaidMinor: number;
  commissionCategoryName: string | null;
  status: string;
  agentOwesMinor: number;
  owedToAgentMinor: number;
  daysHeld: number | null;
  agent: { id: string; firstName: string; lastName: string; email: string };
  contract: { id: string; contractNumber: string; status: string; customer: { firstName: string; lastName: string; membershipId: string } };
  remittances: Remittance[];
  payouts: { id: string; amountMinor: number; method: string; reference: string | null; createdAt: string }[];
}

const METHOD_LABELS: Record<string, string> = { CASH: 'Cash at branch', MOBILE_MONEY: 'Mobile money', BANK_TRANSFER: 'Bank transfer' };

/**
 * The Agent module: every agent's deposit-custody ledger, for a
 * BRANCH_MANAGER/ADMIN/SUPER_ADMIN/AUDITOR (agent.ledger.manage) to review
 * and confirm or reject filed remittances against (agentLedgerService.ts).
 */
export default function AgentLedgerPage() {
  const canManage = useAuthStore((s) => s.hasPermission('agent.ledger.manage'));
  // An auditor holds agent.ledger.manage to see this page; paying out is for those who also handle money.
  const canPay = useAuthStore((s) => s.hasPermission('payment.cash.record'));
  const { toast } = useToast();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [rejectTarget, setRejectTarget] = useState<Remittance | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [agentFilter, setAgentFilter] = useState('__all__');
  const [payTarget, setPayTarget] = useState<LedgerEntry | null>(null);
  const [payForm, setPayForm] = useState({ amount: '', method: 'CASH', reference: '' });

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

  useEffect(() => { if (canManage) load(); }, [load, canManage]);

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

  async function payCommission() {
    if (!payTarget) return;
    const amountMinor = Math.round(parseFloat(payForm.amount) * 100);
    if (!amountMinor || amountMinor <= 0) { toast({ title: 'Enter a valid amount', variant: 'destructive' }); return; }
    setBusyId(payTarget.id);
    try {
      await api.post(`/agent/ledger/${payTarget.id}/pay-commission`, { amountMinor, method: payForm.method, reference: payForm.reference || undefined });
      toast({ title: 'Commission payment recorded' });
      setPayTarget(null);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to record the payment', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  const agents = [...new Map(entries.map((e) => [e.agent.id, e.agent])).values()];
  const shown = agentFilter === '__all__' ? entries : entries.filter((e) => e.agent.id === agentFilter);
  const totalOwed = shown.reduce((s, e) => s + e.agentOwesMinor, 0);
  const totalOwedToAgents = shown.reduce((s, e) => s + e.owedToAgentMinor, 0);
  const longHeld = shown.filter((e) => e.daysHeld !== null && e.daysHeld >= AGENT_CASH_HOLD_ALERT_DAYS).length;
  const pendingRemittances = shown.flatMap((e) => e.remittances.filter((r) => r.status === 'PENDING').map((r) => ({ ...r, entry: e })));

  if (!canManage) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Agent Ledger</h1>
          <p className="text-sm text-gray-500 mt-0.5">Cash agents have collected, the commission they have earned, and what they and the office owe each other</p>
        </div>
        <AccessDenied
          message="You don't have permission to view agent ledgers."
          hint="This page requires the agent.ledger.manage permission (Branch Managers, Admins, Super Admins and Auditors)."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Agent Ledger</h1>
        <p className="text-sm text-gray-500 mt-0.5">Cash agents have collected, the commission they have earned, and what they and the office owe each other</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Cash agents still hold</p><p className="text-lg font-semibold text-red-600">{formatCurrency(totalOwed)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Commission owed to agents</p><p className="text-lg font-semibold text-emerald-600">{formatCurrency(totalOwedToAgents)}</p></CardContent></Card>
        <Card className={longHeld > 0 ? 'border-red-200 ring-1 ring-red-100' : undefined}>
          <CardContent className="p-4"><p className="text-xs text-gray-500">Held {AGENT_CASH_HOLD_ALERT_DAYS}+ days</p><p className={cn('text-lg font-semibold', longHeld > 0 ? 'text-red-600' : 'text-gray-900')}>{longHeld} contract{longHeld === 1 ? '' : 's'}</p></CardContent>
        </Card>
      </div>

      {agents.length > 1 && (
        <div className="max-w-xs">
          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All agents</SelectItem>
              {agents.map((a) => <SelectItem key={a.id} value={a.id}>{a.firstName} {a.lastName}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      )}

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
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Every contract</h2>
            {shown.length === 0 ? (
              <Card><CardContent className="text-center py-12 px-4"><Wallet className="h-8 w-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-500">Nothing yet — agents&apos; cash and commission will show here</p></CardContent></Card>
            ) : (
              <div className="space-y-2">
                {shown.map((e) => {
                  return (
                    <Card key={e.id}>
                      <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900">{e.agent.firstName} {e.agent.lastName}</p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            <Link href={`/contracts/${e.contract.id}`} className="font-mono text-blue-700 hover:underline">{e.contract.contractNumber}</Link>
                            {' '}&middot; {e.contract.customer.firstName} {e.contract.customer.lastName}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            Cash collected {formatCurrency(e.depositAmountMinor)} &middot; Commission {e.commissionAmountMinor > 0 ? formatCurrency(e.commissionAmountMinor) : 'not yet earned'}{e.commissionCategoryName ? ` (${e.commissionCategoryName})` : ''}
                            {e.amountRemittedMinor > 0 && <> &middot; Paid in {formatCurrency(e.amountRemittedMinor)}</>}
                            {e.commissionPaidMinor > 0 && <> &middot; Commission paid {formatCurrency(e.commissionPaidMinor)}</>}
                          </p>
                        </div>
                        <div className={cn('text-right shrink-0 space-y-1')}>
                          <Badge className={e.status === 'SETTLED' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60' : e.status === 'DUE_TO_AGENT' ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200/60' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60'}>
                            {e.status === 'DUE_TO_AGENT' ? 'OWED TO AGENT' : e.status}
                          </Badge>
                          {e.agentOwesMinor > 0 && (
                            <p className={cn('text-xs', e.daysHeld !== null && e.daysHeld >= AGENT_CASH_HOLD_ALERT_DAYS ? 'text-red-600 font-semibold' : 'text-red-600')}>
                              Agent owes {formatCurrency(e.agentOwesMinor)}{e.daysHeld !== null && ` · held ${e.daysHeld}d`}
                            </p>
                          )}
                          {e.owedToAgentMinor > 0 && (
                            <div className="flex items-center justify-end gap-2">
                              <p className="text-xs text-emerald-700">Owed to agent {formatCurrency(e.owedToAgentMinor)}</p>
                              {canPay && (
                                <Button size="sm" variant="outline" onClick={() => { setPayTarget(e); setPayForm({ amount: (e.owedToAgentMinor / 100).toFixed(2), method: 'CASH', reference: '' }); }}>
                                  Pay commission
                                </Button>
                              )}
                            </div>
                          )}
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

      <Dialog open={!!payTarget} onOpenChange={(open) => { if (!open) setPayTarget(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Pay commission — {payTarget?.agent.firstName} {payTarget?.agent.lastName}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              On {payTarget?.contract.contractNumber} the office owes this agent {payTarget && formatCurrency(payTarget.owedToAgentMinor)} — the commission they earned is more than the cash they collected.
            </p>
            <div>
              <Label htmlFor="pay-amount">Amount paid (GHS)</Label>
              <Input id="pay-amount" type="number" min="0.01" step="0.01" className="mt-1.5" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} />
            </div>
            <div>
              <Label>Paid by</Label>
              <Select value={payForm.method} onValueChange={(v) => setPayForm({ ...payForm, method: v })}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">Cash</SelectItem>
                  <SelectItem value="MOBILE_MONEY">Mobile money</SelectItem>
                  <SelectItem value="BANK_TRANSFER">Bank transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {payForm.method !== 'CASH' && (
              <div>
                <Label htmlFor="pay-ref">Reference (optional)</Label>
                <Input id="pay-ref" className="mt-1.5" value={payForm.reference} onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} placeholder="Transaction ID" />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayTarget(null)}>Cancel</Button>
            <Button disabled={busyId === payTarget?.id} onClick={payCommission}>{busyId === payTarget?.id ? 'Saving...' : 'Record payment'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
