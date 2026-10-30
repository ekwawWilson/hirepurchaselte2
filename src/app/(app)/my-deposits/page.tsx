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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
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
  /** The product category whose rate applied; null when the default did. */
  commissionCategoryName: string | null;
  amountOwedMinor: number;
  amountRemittedMinor: number;
  commissionPaidMinor: number;
  status: string;
  createdAt: string;
  /** Positive: you owe the office. Negative: the office owes you. */
  agentOwesMinor: number;
  owedToAgentMinor: number;
  daysHeld: number | null;
  contract: { id: string; contractNumber: string; status: string; customer: { firstName: string; lastName: string; membershipId: string } };
  remittances: Remittance[];
  payouts: { id: string; amountMinor: number; method: string; reference: string | null; createdAt: string }[];
}
interface Totals {
  depositAmountMinor: number; commissionAmountMinor: number; amountRemittedMinor: number; commissionPaidMinor: number;
  agentOwesMinor: number; owedToAgentMinor: number;
}

const METHOD_LABELS: Record<string, string> = { CASH: 'Cash at branch', MOBILE_MONEY: 'Mobile money', BANK_TRANSFER: 'Bank transfer' };
const STATUS_TONE: Record<string, string> = {
  PENDING: 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60',
  CONFIRMED: 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60',
  REJECTED: 'bg-red-50 text-red-700 ring-1 ring-red-200/60',
};

interface CompletionSummary {
  dueOnCompletion: { count: number; totalMinor: number };
  payable: { count: number; totalMinor: number };
  paid: { count: number; totalMinor: number };
}

/**
 * The Agent module: the cash an agent has collected on the company's behalf,
 * the commission they have earned, what they owe the office (or the office
 * owes them) and how long they have held cash — plus a form to tell the
 * office they have paid some of it in (agentLedgerService.ts).
 */
export default function MyDepositsPage() {
  const canView = useAuthStore((s) => s.hasPermission('agent.ledger.view'));
  const { toast } = useToast();
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [remitTarget, setRemitTarget] = useState<LedgerEntry | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [completion, setCompletion] = useState<CompletionSummary | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await api.get<{ entries: LedgerEntry[]; totals: Totals }>('/agent/ledger');
      setEntries(data.entries);
      setTotals(data.totals);
      // Commission paid when customers complete: a bonus to the ledger, never a reason to fail the page.
      api.get<{ summary: CompletionSummary }>('/agent/completion-commissions').then((c) => setCompletion(c.summary)).catch(() => {});
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load your ledger', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => { if (canView) load(); }, [load, canView]);

  /** What can still be remitted: what is owed, less claims still waiting to be confirmed. */
  function outstanding(e: LedgerEntry) {
    const pending = e.remittances.filter((r) => r.status === 'PENDING').reduce((s, r) => s + r.amountMinor, 0);
    return Math.max(0, e.agentOwesMinor - pending);
  }

  function openRemit(e: LedgerEntry) {
    setRemitTarget(e);
    setAmount((outstanding(e) / 100).toFixed(2));
    setMethod('CASH');
    setReference('');
  }

  async function submitRemit() {
    if (!remitTarget) return;
    const amountMinor = Math.round(parseFloat(amount) * 100);
    if (!amountMinor || amountMinor <= 0) {
      toast({ title: 'Enter a valid amount', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await api.post(`/agent/ledger/${remitTarget.id}/remit`, { amountMinor, method, reference: reference || undefined });
      toast({ title: 'Remittance filed', description: 'Waiting for the office to confirm it.' });
      setRemitTarget(null);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to file remittance', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  if (!canView) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">My Deposits</h1>
          <p className="text-sm text-gray-500 mt-0.5">Cash you have collected, the commission you have earned, and what you and the office owe each other</p>
        </div>
        <AccessDenied
          message="You don't have permission to view an agent deposit ledger."
          hint="This page requires the agent.ledger.view permission (the Agent role)."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">My Deposits</h1>
        <p className="text-sm text-gray-500 mt-0.5">Cash you have collected, the commission you have earned, and what you and the office owe each other</p>
      </div>

      {totals && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Cash you collected</p><p className="text-lg font-semibold text-gray-900">{formatCurrency(totals.depositAmountMinor)}</p></CardContent></Card>
          <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Commission earned</p><p className="text-lg font-semibold text-emerald-600">{formatCurrency(totals.commissionAmountMinor)}</p></CardContent></Card>
          <Card className={totals.agentOwesMinor > 0 ? 'border-red-200 ring-1 ring-red-100' : undefined}>
            <CardContent className="p-4"><p className="text-xs text-gray-500">You still owe</p><p className="text-lg font-semibold text-red-600">{formatCurrency(totals.agentOwesMinor)}</p></CardContent>
          </Card>
          <Card className={totals.owedToAgentMinor > 0 ? 'border-emerald-200 ring-1 ring-emerald-100' : undefined}>
            <CardContent className="p-4"><p className="text-xs text-gray-500">Commission owed to you</p><p className="text-lg font-semibold text-emerald-600">{formatCurrency(totals.owedToAgentMinor)}</p></CardContent>
          </Card>
        </div>
      )}

      {completion && completion.dueOnCompletion.count + completion.payable.count + completion.paid.count > 0 && (
        <Card>
          <CardContent className="p-4">
            <p className="text-sm font-medium text-gray-900">Paid when your customers complete</p>
            <p className="text-xs text-gray-500 mt-0.5">Commission held back, and any completion bonus, is paid once a customer has paid everything. A sale that defaults is held; one cancelled is lost.</p>
            <div className="grid grid-cols-3 gap-3 mt-3">
              <div><p className="text-xs text-gray-500">Still to come</p><p className="text-base font-semibold text-gray-900">{formatCurrency(completion.dueOnCompletion.totalMinor)}</p><p className="text-xs text-gray-500">{completion.dueOnCompletion.count} sale{completion.dueOnCompletion.count === 1 ? '' : 's'}</p></div>
              <div><p className="text-xs text-gray-500">Ready to be paid</p><p className="text-base font-semibold text-blue-700">{formatCurrency(completion.payable.totalMinor)}</p><p className="text-xs text-gray-500">{completion.payable.count} sale{completion.payable.count === 1 ? '' : 's'}</p></div>
              <div><p className="text-xs text-gray-500">Paid to you</p><p className="text-base font-semibold text-emerald-600">{formatCurrency(completion.paid.totalMinor)}</p><p className="text-xs text-gray-500">{completion.paid.count} sale{completion.paid.count === 1 ? '' : 's'}</p></div>
            </div>
          </CardContent>
        </Card>
      )}

      {isLoading ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
      ) : entries.length === 0 ? (
        <Card><CardContent className="text-center py-12 px-4"><Wallet className="h-8 w-8 text-gray-300 mx-auto mb-2" /><p className="text-gray-500">Nothing yet — cash you collect and commission you earn on your contracts will show here</p></CardContent></Card>
      ) : (
        <div className="space-y-3">
          {entries.map((e) => {
            const due = outstanding(e);
            return (
              <Card key={e.id}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-3">
                    <div className="flex-1 min-w-0">
                      <Link href={`/contracts/${e.contract.id}`} className="font-mono text-xs text-blue-700 hover:underline">{e.contract.contractNumber}</Link>
                      <p className="text-sm font-medium text-gray-900 mt-0.5">{e.contract.customer.firstName} {e.contract.customer.lastName}</p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Cash collected {formatCurrency(e.depositAmountMinor)} &middot; Commission {e.commissionAmountMinor > 0 ? formatCurrency(e.commissionAmountMinor) : 'not yet earned'}{e.commissionCategoryName ? ` (${e.commissionCategoryName})` : ''}
                        {e.amountRemittedMinor > 0 && <> &middot; Paid in {formatCurrency(e.amountRemittedMinor)}</>}
                        {e.commissionPaidMinor > 0 && <> &middot; Commission paid to you {formatCurrency(e.commissionPaidMinor)}</>}
                      </p>
                      {e.agentOwesMinor > 0 && (
                        <p className={cn('text-xs mt-0.5', e.daysHeld !== null && e.daysHeld >= AGENT_CASH_HOLD_ALERT_DAYS ? 'text-red-600 font-semibold' : 'text-gray-600')}>
                          You owe {formatCurrency(e.agentOwesMinor)}{e.daysHeld !== null && ` — held for ${e.daysHeld} day${e.daysHeld === 1 ? '' : 's'}`}
                        </p>
                      )}
                      {e.owedToAgentMinor > 0 && <p className="text-xs text-emerald-700 mt-0.5">The office owes you {formatCurrency(e.owedToAgentMinor)} commission</p>}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge className={e.status === 'SETTLED' ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60' : e.status === 'DUE_TO_AGENT' ? 'bg-blue-50 text-blue-700 ring-1 ring-blue-200/60' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200/60'}>
                        {e.status === 'DUE_TO_AGENT' ? 'OWED TO YOU' : e.status}
                      </Badge>
                      {due > 0 && <Button size="sm" onClick={() => openRemit(e)}>Remit {formatCurrency(due)}</Button>}
                    </div>
                  </div>

                  {(e.remittances.length > 0 || e.payouts.length > 0) && (
                    <div className="border-t border-gray-100 pt-2.5 space-y-1.5">
                      {e.payouts.map((p) => (
                        <div key={p.id} className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-gray-500">Commission of {formatCurrency(p.amountMinor)} paid to you via {METHOD_LABELS[p.method] ?? p.method}{p.reference && <> ({p.reference})</>} &middot; {formatDateTime(p.createdAt)}</span>
                          <Badge className="bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60">PAID</Badge>
                        </div>
                      ))}
                      {e.remittances.map((r) => (
                        <div key={r.id} className="flex items-center justify-between gap-2 text-xs">
                          <span className="text-gray-500">
                            {formatCurrency(r.amountMinor)} via {METHOD_LABELS[r.method] ?? r.method}
                            {r.reference && <> ({r.reference})</>} &middot; {formatDateTime(r.createdAt)}
                            {r.status === 'REJECTED' && r.rejectionReason && <span className="text-red-600"> — {r.rejectionReason}</span>}
                          </span>
                          <Badge className={cn(STATUS_TONE[r.status])}>{r.status}</Badge>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!remitTarget} onOpenChange={(open) => !open && setRemitTarget(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Remit for {remitTarget?.contract.contractNumber}</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label htmlFor="remit-amount">Amount (GHS)</Label>
              <Input id="remit-amount" type="number" min="0.01" step="0.01" className="mt-1.5" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div>
              <Label>How did you pay it?</Label>
              <Select value={method} onValueChange={setMethod}>
                <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="CASH">Cash at branch</SelectItem>
                  <SelectItem value="MOBILE_MONEY">Mobile money</SelectItem>
                  <SelectItem value="BANK_TRANSFER">Bank transfer</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {method !== 'CASH' && (
              <div>
                <Label htmlFor="remit-ref">Reference (optional)</Label>
                <Input id="remit-ref" className="mt-1.5" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Transaction ID" />
              </div>
            )}
            <p className="text-xs text-gray-400">The office will confirm this once they have counted the cash or checked the transfer.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemitTarget(null)}>Cancel</Button>
            <Button disabled={saving} onClick={submitRemit}>{saving ? 'Filing...' : 'File remittance'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
