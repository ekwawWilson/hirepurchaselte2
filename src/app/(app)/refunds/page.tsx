'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Undo2 } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { AccessDenied } from '@/components/AccessDenied';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDate, cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { RecordRefundDialog, type RefundTarget } from '@/components/RecordRefundDialog';

interface Refund extends RefundTarget {
  cancelledAt: string | null; cancelReason: string | null;
  refundedMinor: number | null; refundedAt: string | null; refundNote: string | null; refundedByName: string | null;
  customer: { id: string; firstName: string; lastName: string; phone: string | null; phone2: string | null; phone3: string | null };
}
interface Listing { refunds: Refund[]; owedCount: number; owedTotalMinor: number }

/**
 * Money owed back to customers on cancelled contracts, and what has been
 * recorded as handed over. A refund stays on the "owed" list until someone
 * who can reverse payments or cancel contracts records what was done.
 */
export default function RefundsPage() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canView = hasPermission('payment.view');
  const canRecord = hasPermission('payment.reverse', 'contract.cancel');
  const { toast } = useToast();
  const [tab, setTab] = useState<'OWED' | 'SETTLED'>('OWED');
  const [listing, setListing] = useState<Listing | null>(null);
  const [target, setTarget] = useState<Refund | null>(null);

  const load = useCallback(async () => {
    try {
      setListing(await api.get<Listing>(`/refunds?status=${tab}`));
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load refunds', variant: 'destructive' });
    }
  }, [tab, toast]);

  useEffect(() => { if (canView) void load(); }, [canView, load]);

  if (!canView) {
    return <AccessDenied message="You don't have permission to view payments." hint="Ask an administrator for the payment.view permission." />;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Refunds</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {listing
            ? listing.owedCount > 0
              ? <><strong className="text-red-600">{formatCurrency(listing.owedTotalMinor)}</strong> owed back on {listing.owedCount} cancelled contract{listing.owedCount === 1 ? '' : 's'}</>
              : 'Nothing is owed back to any customer'
            : 'Money owed back to customers on cancelled contracts'}
        </p>
      </div>

      <div className="flex gap-2">
        {(['OWED', 'SETTLED'] as const).map((t) => (
          <button
            key={t} type="button" onClick={() => { setListing(null); setTab(t); }}
            className={cn('rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
              tab === t ? 'bg-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}
          >
            {t === 'OWED' ? 'Still owed' : 'Recorded'}
          </button>
        ))}
      </div>

      {!listing ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
      ) : listing.refunds.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 px-4">
            <Undo2 className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-gray-500">{tab === 'OWED' ? 'No refunds waiting' : 'No refunds recorded yet'}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {listing.refunds.map((r) => (
            <Card key={r.id}>
              <CardContent className="p-4 flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-gray-900">
                    {r.customer.firstName} {r.customer.lastName}
                    <span className="ml-2 text-sm font-normal text-gray-500">{r.customer.phone ?? r.customer.phone2 ?? r.customer.phone3}</span>
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    <Link href={`/contracts/${r.id}`} className="font-mono text-primary hover:underline">{r.contractNumber}</Link>
                    {' '}&middot; cancelled {formatDate(r.cancelledAt)}{r.cancelReason ? <> &middot; &ldquo;{r.cancelReason}&rdquo;</> : null}
                  </p>
                  {r.refundedAt && (
                    <p className="text-xs text-gray-600 mt-1">
                      {formatCurrency(r.refundedMinor ?? 0)} handed back on {formatDate(r.refundedAt)}{r.refundedByName ? ` by ${r.refundedByName}` : ''}
                      {r.refundNote ? <> &middot; {r.refundNote}</> : null}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-2">
                  <p className="text-right">
                    <span className="block text-xs text-gray-500">Paid in before cancelling</span>
                    <span className="text-lg font-bold text-gray-900">{formatCurrency(r.refundDueMinor)}</span>
                  </p>
                  {!r.refundedAt && canRecord && <Button size="sm" onClick={() => setTarget(r)}>Record refund</Button>}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <RecordRefundDialog target={target} onClose={() => setTarget(null)} onSaved={() => { setTarget(null); void load(); }} />
    </div>
  );
}
