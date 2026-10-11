'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { MessageCircle, Phone, PhoneCall, Search } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { AccessDenied } from '@/components/AccessDenied';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDate, cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { LogContactDialog, OUTCOME_LABELS } from '@/components/LogContactDialog';

interface Row {
  id: string; contractNumber: string; contractType: string; status: string;
  overdueMinor: number; overdueInstalments: number; daysOverdue: number; balanceMinor: number | null;
  customer: { id: string; firstName: string; lastName: string; phone: string | null; phone2: string | null; phone3: string | null; guarantorName: string | null; guarantorPhone: string | null };
  lastPayment: { amountMinor: number; receivedAt: string | null; createdAt: string } | null;
  lastNote: {
    outcome: string; note: string; createdAt: string; followUpAt: string | null; by: string;
    promisedAmountMinor: number | null; promisedDate: string | null;
    promise: { status: 'PENDING' | 'KEPT' | 'BROKEN'; paidMinor: number } | null;
  } | null;
}
interface Queue {
  rows: Row[];
  summary: { contracts: number; overdueMinor: number; followUpDue: number; brokenPromises: number; notContacted: number };
}

const FILTERS = [
  { key: 'ALL', label: 'All in arrears' },
  { key: 'FOLLOW_UP_DUE', label: 'Follow-up due' },
  { key: 'PROMISES', label: 'Open promises' },
  { key: 'NOT_CONTACTED', label: 'Not yet contacted' },
] as const;
type FilterKey = (typeof FILTERS)[number]['key'];

/** 0241234567 -> 233241234567, the form wa.me links take. */
const international = (phone: string) => (phone.startsWith('0') ? `233${phone.slice(1)}` : phone.replace(/^\+/, ''));

/**
 * The work queue for chasing late payers: who is behind, by how much and for
 * how long, where the last conversation left it, and whether a promise to
 * pay was kept — so each call starts from the last one.
 */
export default function CollectionsPage() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canView = hasPermission('contract.view');
  const canLog = hasPermission('customer.create', 'payment.cash.record');
  const { toast } = useToast();

  const [filter, setFilter] = useState<FilterKey>('ALL');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [queue, setQueue] = useState<Queue | null>(null);
  const [target, setTarget] = useState<Row | null>(null);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ filter, ...(search && { q: search }) });
      setQueue(await api.get<Queue>(`/collections?${params}`));
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load the collections queue', variant: 'destructive' });
    }
  }, [filter, search, toast]);

  useEffect(() => { if (canView) void load(); }, [canView, load]);

  if (!canView) {
    return <AccessDenied message="You don't have permission to view contracts." hint="Ask an administrator for the contract.view permission." />;
  }

  const count = (key: FilterKey) =>
    !queue ? null : key === 'FOLLOW_UP_DUE' ? queue.summary.followUpDue : key === 'NOT_CONTACTED' ? queue.summary.notContacted : null;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Collections</h1>
        <p className="text-sm text-gray-500 mt-0.5">Customers who are behind, and where the last conversation left things</p>
      </div>

      {queue && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: 'Contracts in arrears', value: String(queue.summary.contracts) },
            { label: 'Total overdue', value: formatCurrency(queue.summary.overdueMinor), alert: queue.summary.overdueMinor > 0 },
            { label: 'Follow-ups due', value: String(queue.summary.followUpDue), alert: queue.summary.followUpDue > 0 },
            { label: 'Broken promises', value: String(queue.summary.brokenPromises), alert: queue.summary.brokenPromises > 0 },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border border-gray-100 bg-white p-4 min-w-0">
              <p className="text-xs font-medium text-gray-500 truncate">{s.label}</p>
              <p className={cn('mt-1 text-lg sm:text-xl font-bold truncate', s.alert ? 'text-red-600' : 'text-gray-900')}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      <Card>
        <CardContent className="p-4 space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map((f) => (
              <button
                key={f.key} type="button" onClick={() => setFilter(f.key)}
                className={cn('rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
                  filter === f.key ? 'bg-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}
              >
                {f.label}{count(f.key) ? ` (${count(f.key)})` : ''}
              </button>
            ))}
          </div>
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setSearch(query.trim()); }}>
            <div className="relative flex-1">
              <Search className="absolute left-3 top-3 h-4 w-4 text-gray-400" />
              <Input className="pl-9" placeholder="Customer, phone or contract number..." value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <Button type="submit" variant="outline">Search</Button>
          </form>
        </CardContent>
      </Card>

      {!queue ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
      ) : queue.rows.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 px-4">
            <PhoneCall className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-gray-500">{filter === 'ALL' && !search ? 'Nobody is behind on their payments' : 'Nothing matches'}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {queue.rows.map((r) => {
            const phone = r.customer.phone ?? r.customer.phone2 ?? r.customer.phone3;
            const name = `${r.customer.firstName} ${r.customer.lastName}`;
            const note = r.lastNote;
            const followUpDue = !!note?.followUpAt && new Date(note.followUpAt) <= new Date(new Date().setHours(23, 59, 59, 999));
            return (
              <Card key={r.id}>
                <CardContent className="p-4 space-y-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900">
                        <Link href={`/customers/${r.customer.id}`} className="hover:underline">{name}</Link>
                        {r.status === 'DEFAULTED' && <span className="ml-2 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-red-700">Defaulted</span>}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">
                        <Link href={`/contracts/${r.id}`} className="font-mono text-primary hover:underline">{r.contractNumber}</Link>
                        {r.overdueInstalments > 0 && <> &middot; {r.overdueInstalments} instalment{r.overdueInstalments === 1 ? '' : 's'} behind</>}
                        {r.lastPayment
                          ? <> &middot; last paid {formatCurrency(r.lastPayment.amountMinor)} on {formatDate(r.lastPayment.receivedAt ?? r.lastPayment.createdAt)}</>
                          : <> &middot; nothing paid since the deposit</>}
                      </p>
                      {r.customer.guarantorPhone && (
                        <p className="text-xs text-gray-500 mt-0.5">Guarantor: {r.customer.guarantorName ?? '—'} &middot; <a className="hover:underline" href={`tel:${r.customer.guarantorPhone}`}>{r.customer.guarantorPhone}</a></p>
                      )}
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-lg font-bold text-red-600">{formatCurrency(r.overdueMinor)}</p>
                      <p className="text-xs text-gray-500">{r.daysOverdue} day{r.daysOverdue === 1 ? '' : 's'} overdue</p>
                    </div>
                  </div>

                  <div className={cn('rounded-lg px-3 py-2 text-xs', note ? 'bg-gray-50 text-gray-600' : 'bg-amber-50 text-amber-800')}>
                    {note ? (
                      <>
                        <p>
                          <strong className="text-gray-800">{OUTCOME_LABELS[note.outcome] ?? note.outcome}</strong> &middot; {formatDate(note.createdAt)} &middot; {note.by}
                          {note.promise && (
                            <span className={cn('ml-2 rounded-full px-2 py-0.5 font-semibold',
                              note.promise.status === 'KEPT' ? 'bg-emerald-100 text-emerald-700' : note.promise.status === 'BROKEN' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700')}>
                              {note.promise.status === 'KEPT' ? 'Promise kept' : note.promise.status === 'BROKEN' ? 'Promise broken' : 'Promise pending'}
                            </span>
                          )}
                        </p>
                        {note.promisedDate && (
                          <p className="mt-0.5">
                            Promised {note.promisedAmountMinor ? formatCurrency(note.promisedAmountMinor) : 'to pay'} by {formatDate(note.promisedDate)}
                            {note.promise && note.promise.paidMinor > 0 && <> &middot; {formatCurrency(note.promise.paidMinor)} paid since</>}
                          </p>
                        )}
                        <p className="mt-0.5">{note.note}</p>
                        {note.followUpAt && (
                          <p className={cn('mt-0.5', followUpDue && 'font-semibold text-red-600')}>
                            Follow up {followUpDue ? 'was due' : 'on'} {formatDate(note.followUpAt)}
                          </p>
                        )}
                      </>
                    ) : 'Nobody has contacted this customer about it yet.'}
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {phone && (
                      <>
                        <a href={`tel:${phone}`} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                          <Phone className="h-3.5 w-3.5" /> {phone}
                        </a>
                        <a
                          href={`https://wa.me/${international(phone)}`} target="_blank" rel="noreferrer"
                          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
                        >
                          <MessageCircle className="h-3.5 w-3.5" /> WhatsApp
                        </a>
                      </>
                    )}
                    {canLog && <Button size="sm" className="ml-auto" onClick={() => setTarget(r)}>Log contact</Button>}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <LogContactDialog
        target={target && { contractId: target.id, customerName: `${target.customer.firstName} ${target.customer.lastName}`, contractNumber: target.contractNumber }}
        onClose={() => setTarget(null)}
        onSaved={() => { setTarget(null); void load(); }}
      />
    </div>
  );
}
