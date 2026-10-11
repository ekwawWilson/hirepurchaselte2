'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Search, Smartphone } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { AccessDenied } from '@/components/AccessDenied';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDateTime, getStatusColor, cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

interface Attempt {
  id: string;
  clientReference: string;
  msisdn: string;
  amountMinor: number;
  status: string;
  channel: string;
  detail: string | null;
  resolutionNote: string | null;
  createdAt: string;
  contract: { id: string; contractNumber: string; customer: { firstName: string; lastName: string } };
}
interface Listing { attempts: Attempt[]; total: number; pageSize: number; needsReview: number }

const FILTERS = [
  { key: 'NEEDS_REVIEW', label: 'Needs review' },
  { key: 'PENDING', label: 'Waiting on customer' },
  { key: 'FAILED', label: 'Failed' },
  { key: 'SUCCESS', label: 'Paid' },
  { key: 'ALL', label: 'All' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

const STATUS_LABELS: Record<string, string> = {
  NEEDS_REVIEW: 'Needs review', PENDING: 'Waiting', FAILED: 'Failed', SUCCESS: 'Paid', RESOLVED: 'Resolved',
};

/**
 * Every mobile money attempt — prompts customers started (USSD, portal),
 * prompts staff sent, direct-debit charges — and the queue of money that was
 * collected but could not be applied to a contract, which nothing else in
 * the app lists.
 */
export default function MobileMoneyPage() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canView = hasPermission('payment.view');
  const canApply = hasPermission('payment.cash.record');
  const canResolve = hasPermission('payment.reverse');
  const { toast } = useToast();

  const [filter, setFilter] = useState<FilterKey>('ALL');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [listing, setListing] = useState<Listing | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resolveTarget, setResolveTarget] = useState<Attempt | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ filter, page: String(page), ...(search && { q: search }) });
      setListing(await api.get<Listing>(`/mobile-money?${params}`));
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load mobile money payments', variant: 'destructive' });
    }
  }, [filter, page, search, toast]);

  useEffect(() => { if (canView) void load(); }, [canView, load]);

  async function reapply(attempt: Attempt) {
    setBusyId(attempt.id);
    try {
      const { transaction } = await api.post<{ transaction: { status: string } }>(`/mobile-money/${attempt.id}/apply`);
      toast(transaction.status === 'SUCCESS'
        ? { title: 'Applied to the contract', description: formatCurrency(attempt.amountMinor) }
        : { title: 'Still could not be applied', description: 'The contract will not take this payment as it stands.', variant: 'destructive' });
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not apply the payment', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  async function resolve() {
    if (!resolveTarget) return;
    setBusyId(resolveTarget.id);
    try {
      await api.post(`/mobile-money/${resolveTarget.id}/resolve`, { note });
      toast({ title: 'Marked as resolved' });
      setResolveTarget(null);
      setNote('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not resolve the payment', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  if (!canView) {
    return <AccessDenied message="You don't have permission to view payments." hint="Ask an administrator for the payment.view permission." />;
  }

  const pages = listing ? Math.max(1, Math.ceil(listing.total / listing.pageSize)) : 1;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Mobile Money</h1>
        <p className="text-sm text-gray-500 mt-0.5">Every prompt and direct debit, what happened to it, and why</p>
      </div>

      {listing && listing.needsReview > 0 && filter !== 'NEEDS_REVIEW' && (
        <button
          type="button" onClick={() => { setFilter('NEEDS_REVIEW'); setPage(1); }}
          className="flex w-full items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-left"
        >
          <AlertTriangle className="h-5 w-5 shrink-0 text-red-500" />
          <span className="text-sm text-red-700">
            <strong>{listing.needsReview}</strong> payment{listing.needsReview === 1 ? ' was' : 's were'} collected from a customer but not applied to their contract. Review now.
          </span>
        </button>
      )}

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key} type="button" onClick={() => { setFilter(f.key); setPage(1); }}
                className={cn('rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
                  filter === f.key ? 'bg-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}
              >
                {f.label}{f.key === 'NEEDS_REVIEW' && listing && listing.needsReview > 0 ? ` (${listing.needsReview})` : ''}
              </button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(query.trim()); setPage(1); }}>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              <Input className="pl-9" placeholder="Customer, contract number, phone or reference..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Button type="submit" variant="outline">Search</Button>
          </form>
        </CardContent>
      </Card>

      {listing && listing.attempts.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 px-4">
            <Smartphone className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-gray-500">{filter === 'NEEDS_REVIEW' ? 'Nothing waiting for review' : 'No mobile money payments found'}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {listing?.attempts.map((a) => (
            <Card key={a.id}>
              <CardContent className="p-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900">
                    {a.contract.customer.firstName} {a.contract.customer.lastName}
                    <span className="ml-2 text-sm font-normal text-gray-500">{a.msisdn}</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    <Link href={`/contracts/${a.contract.id}`} className="font-mono text-primary hover:underline">{a.contract.contractNumber}</Link>
                    {' '}&middot; {a.channel === 'DIRECT_DEBIT' ? 'Direct debit' : 'Customer prompt'} &middot; {formatDateTime(a.createdAt)}
                  </p>
                  {(a.resolutionNote || a.detail) && (
                    <p className={cn('text-xs mt-1', a.status === 'FAILED' || a.status === 'NEEDS_REVIEW' ? 'text-red-600' : 'text-gray-500')}>
                      {a.resolutionNote ? `Resolved: ${a.resolutionNote}` : a.detail}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-900">{formatCurrency(a.amountMinor)}</span>
                    <span className={cn('text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full', getStatusColor(a.status === 'NEEDS_REVIEW' ? 'OVERDUE' : a.status === 'RESOLVED' ? 'RELEASED' : a.status))}>
                      {STATUS_LABELS[a.status] ?? a.status}
                    </span>
                  </div>
                  {a.status === 'NEEDS_REVIEW' && (
                    <div className="flex gap-2">
                      {canApply && (
                        <Button size="sm" disabled={busyId === a.id} onClick={() => reapply(a)}>
                          {busyId === a.id ? 'Applying...' : 'Apply to contract'}
                        </Button>
                      )}
                      {canResolve && (
                        <Button size="sm" variant="outline" disabled={busyId === a.id} onClick={() => setResolveTarget(a)}>Mark resolved</Button>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {listing && pages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>Page {page} of {pages} &middot; {listing.total} in all</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</Button>
            <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>Next</Button>
          </div>
        </div>
      )}

      <Dialog open={!!resolveTarget} onOpenChange={(open) => { if (!open) { setResolveTarget(null); setNote(''); } }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Mark this payment as resolved</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">
            {resolveTarget && formatCurrency(resolveTarget.amountMinor)} was taken from the customer&apos;s wallet but is not on their
            contract. Only close it once the money has been dealt with — refunded, or credited by hand.
          </p>
          <div>
            <Label>What was done with the money?</Label>
            <Textarea className="mt-1.5" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Refunded to the customer in cash on 12 Oct" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveTarget(null)}>Back</Button>
            <Button disabled={!note.trim() || busyId !== null} onClick={resolve}>Mark resolved</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
