'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Bell, X } from 'lucide-react';
import { useTodaysPayments } from '@/hooks/useTodaysPayments';
import { formatCurrency } from '@/lib/utils';

const CHANNEL_LABELS: Record<string, string> = { CASH: 'Cash', USSD: 'Mobile money', DIRECT_DEBIT: 'Direct debit' };

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

/** Top-bar bell: today's payment count, opening a panel of who paid. */
export function TodaysPaymentsBell() {
  const { data } = useTodaysPayments();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (!data) return null;
  const { count } = data;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative flex h-9 w-9 items-center justify-center rounded-xl text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700"
        aria-label={`Today's payments: ${count}`}
      >
        <Bell className="h-5 w-5" />
        {count > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500 px-1 text-[10px] font-bold leading-none text-white">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40 bg-black/20" onClick={() => setOpen(false)} />
          <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col bg-slate-900 text-white shadow-2xl animate-slide-down sm:animate-none">
            <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
              <div>
                <p className="font-heading text-base font-semibold">Today&apos;s payments</p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {new Date(`${data.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                </p>
              </div>
              <button type="button" onClick={() => setOpen(false)} className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white" aria-label="Close">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className={`grid gap-px border-b border-white/10 bg-white/5 ${data.totalMinor !== undefined ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <div className="bg-slate-900 px-5 py-4">
                <p className="text-xs uppercase tracking-wide text-slate-400">Payments</p>
                <p className="mt-1 text-3xl font-bold text-emerald-400">{count}</p>
              </div>
              {data.totalMinor !== undefined && (
                <div className="bg-slate-900 px-5 py-4">
                  <p className="text-xs uppercase tracking-wide text-slate-400">Net collected</p>
                  <p className="mt-1 text-xl font-bold text-emerald-400">{formatCurrency(data.totalMinor)}</p>
                </div>
              )}
            </div>

            <p className="px-5 py-3 text-xs font-semibold uppercase tracking-wider text-slate-500">
              {count > data.payments.length ? `Latest ${data.payments.length} of ${count}` : count === 1 ? 'The one payment today' : `All ${count} today`}
            </p>

            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
              {data.payments.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-slate-400">No payments received yet today.</p>
              ) : (
                <ul className="space-y-1">
                  {data.payments.map((p) => (
                    <li key={p.id}>
                      <Link
                        href={`/contracts/${p.contract.id}`}
                        onClick={() => setOpen(false)}
                        className="block rounded-lg px-3 py-3 transition-colors hover:bg-white/5"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-semibold">{p.contract.customer.firstName} {p.contract.customer.lastName}</p>
                            <p className="mt-0.5 truncate text-xs text-slate-400">{p.contract.contractNumber} · {CHANNEL_LABELS[p.channel] ?? p.channel}</p>
                          </div>
                          <div className="shrink-0 text-right">
                            <p className="text-sm font-bold text-emerald-400">{formatCurrency(p.amountMinor)}</p>
                            <p className="mt-0.5 text-xs text-slate-500">{timeOf(p.createdAt)}</p>
                          </div>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </>
      )}
    </>
  );
}
