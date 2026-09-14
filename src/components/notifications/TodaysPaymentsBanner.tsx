'use client';

import { useEffect, useState } from 'react';
import { TrendingUp, X } from 'lucide-react';
import { useTodaysPayments } from '@/hooks/useTodaysPayments';
import { formatCurrency } from '@/lib/utils';

const DISMISSED_KEY = 'hplite.todaysPaymentsBanner.dismissedOn';

function today() {
  return new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
}

/**
 * The legacy app's green "payments received today" strip. Dismissing it hides
 * it for the rest of the day only; tomorrow it is back.
 */
export function TodaysPaymentsBanner() {
  const { data } = useTodaysPayments();
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISSED_KEY) === today());
    } catch {
      setDismissed(false);
    }
  }, []);

  if (dismissed || !data) return null;

  function dismiss() {
    try { localStorage.setItem(DISMISSED_KEY, today()); } catch { /* storage unavailable */ }
    setDismissed(true);
  }

  return (
    <div className="mb-4 flex items-start justify-between gap-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100">
          <TrendingUp className="h-5 w-5 text-emerald-600" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-emerald-800">
            {data.count === 0 ? 'No payments received yet today' : `${data.count} payment${data.count === 1 ? '' : 's'} received today`}
          </p>
          {data.count > 0 && data.totalMinor !== undefined && (
            <p className="mt-0.5 text-xs text-emerald-700">
              Net collected today: <span className="font-bold">{formatCurrency(data.totalMinor)}</span>
            </p>
          )}
        </div>
      </div>
      <button type="button" onClick={dismiss} className="shrink-0 rounded-md p-1 text-emerald-600 hover:bg-emerald-100 hover:text-emerald-800" aria-label="Hide for today">
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
