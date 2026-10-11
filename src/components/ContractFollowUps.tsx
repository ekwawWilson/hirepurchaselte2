'use client';

import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/apiClient';
import { formatCurrency, formatDate, formatDateTime, cn } from '@/lib/utils';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { LogContactDialog, OUTCOME_LABELS } from '@/components/LogContactDialog';

interface Note {
  id: string; outcome: string; note: string; createdAt: string; followUpAt: string | null;
  promisedAmountMinor: number | null; promisedDate: string | null;
  promise: { status: 'PENDING' | 'KEPT' | 'BROKEN'; paidMinor: number } | null;
  createdBy: { firstName: string; lastName: string };
}

/**
 * The calls, visits and promises logged against one contract — shown on the
 * contract itself once it is behind or has any history, so whoever opens it
 * sees what the customer was last told and what they said they would do.
 */
export function ContractFollowUps({ contractId, customerName, contractNumber, inArrears, canLog }: {
  contractId: string; customerName: string; contractNumber: string; inArrears: boolean; canLog: boolean;
}) {
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [logging, setLogging] = useState(false);

  const load = useCallback(() => {
    api.get<{ notes: Note[] }>(`/contracts/${contractId}/collection-notes`).then((r) => setNotes(r.notes)).catch(() => setNotes([]));
  }, [contractId]);
  useEffect(load, [load]);

  if (!notes || (notes.length === 0 && !inArrears)) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3">
        <CardTitle>Follow-up</CardTitle>
        {canLog && <Button size="sm" variant="outline" onClick={() => setLogging(true)}>Log contact</Button>}
      </CardHeader>
      <CardContent>
        {notes.length === 0 ? (
          <p className="text-sm text-amber-700">This contract is behind and nobody has logged a contact with the customer yet.</p>
        ) : (
          <ul className="space-y-3">
            {notes.map((n) => (
              <li key={n.id} className="border-l-2 border-gray-200 pl-3 text-sm">
                <p className="text-gray-900">
                  <strong>{OUTCOME_LABELS[n.outcome] ?? n.outcome}</strong>
                  <span className="text-xs text-gray-500"> &middot; {formatDateTime(n.createdAt)} &middot; {n.createdBy.firstName} {n.createdBy.lastName}</span>
                  {n.promise && (
                    <span className={cn('ml-2 rounded-full px-2 py-0.5 text-[11px] font-semibold',
                      n.promise.status === 'KEPT' ? 'bg-emerald-100 text-emerald-700' : n.promise.status === 'BROKEN' ? 'bg-red-100 text-red-700' : 'bg-blue-100 text-blue-700')}>
                      {n.promise.status === 'KEPT' ? 'Kept' : n.promise.status === 'BROKEN' ? 'Broken' : 'Pending'}
                    </span>
                  )}
                </p>
                {n.promisedDate && (
                  <p className="text-xs text-gray-600 mt-0.5">
                    Promised {n.promisedAmountMinor ? formatCurrency(n.promisedAmountMinor) : 'to pay'} by {formatDate(n.promisedDate)}
                  </p>
                )}
                <p className="text-gray-700 mt-0.5">{n.note}</p>
                {n.followUpAt && <p className="text-xs text-gray-500 mt-0.5">Follow up on {formatDate(n.followUpAt)}</p>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <LogContactDialog
        target={logging ? { contractId, customerName, contractNumber } : null}
        onClose={() => setLogging(false)}
        onSaved={() => { setLogging(false); load(); }}
      />
    </Card>
  );
}
