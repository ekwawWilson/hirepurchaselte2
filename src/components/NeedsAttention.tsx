'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ChevronRight } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDateTime } from '@/lib/utils';

interface Alert { id: string; kind: string; message: string; occurrences: number; lastSeenAt: string }
interface Attention {
  paymentsToReview: number; refundsOwed: number; refundsOwedMinor: number; approvalsWaiting: number; followUpsDue: number;
  contractsToApprove: number; remittancesToConfirm: number; contractsSentBack: number; cashToRemitMinor: number; commissionOwedToYouMinor: number;
  alerts: Alert[]; smsNotSending: boolean;
}

const MAX_ALERTS_SHOWN = 5;

/**
 * What is waiting on a person, at the top of the dashboard: each line only
 * shown to someone who can act on it (attentionService.ts), and the whole
 * section absent when there is nothing.
 */
export function NeedsAttention() {
  const { toast } = useToast();
  const [data, setData] = useState<Attention | null>(null);

  const load = useCallback(() => {
    api.get<Attention>('/attention').then(setData).catch(() => setData(null));
  }, []);
  useEffect(load, [load]);

  async function acknowledge(alert: Alert) {
    try {
      await api.post(`/alerts/${alert.id}/acknowledge`);
      load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not clear the alert', variant: 'destructive' });
    }
  }

  if (!data) return null;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const items = [
    data.paymentsToReview > 0 && {
      href: '/mobile-money', text: `${plural(data.paymentsToReview, 'mobile money payment was', 'mobile money payments were')} collected but not applied to a contract`,
    },
    data.approvalsWaiting > 0 && {
      href: '/approvals', text: `${plural(data.approvalsWaiting, 'reversal, write-off or cancellation is', 'reversals, write-offs or cancellations are')} waiting for your approval`,
    },
    data.contractsToApprove > 0 && {
      href: '/contract-approvals', text: `${plural(data.contractsToApprove, 'contract submitted by an agent is', 'contracts submitted by agents are')} waiting for approval`,
    },
    data.remittancesToConfirm > 0 && {
      href: '/agent-ledger', text: `${plural(data.remittancesToConfirm, 'agent payment-in is', 'agent payments-in are')} waiting to be confirmed`,
    },
    data.contractsSentBack > 0 && {
      href: '/contracts?status=REVISION_REQUESTED', text: `${plural(data.contractsSentBack, 'of your contracts was', 'of your contracts were')} sent back for changes`,
    },
    data.cashToRemitMinor > 0 && {
      href: '/my-deposits', text: `You are holding ${formatCurrency(data.cashToRemitMinor)} of customers' cash to pay in`,
    },
    data.commissionOwedToYouMinor > 0 && {
      href: '/my-deposits', text: `${formatCurrency(data.commissionOwedToYouMinor)} of commission is owed to you`,
    },
    data.followUpsDue > 0 && {
      href: '/collections', text: `${plural(data.followUpsDue, 'customer follow-up is', 'customer follow-ups are')} due`,
    },
    data.refundsOwed > 0 && {
      href: '/refunds', text: `${formatCurrency(data.refundsOwedMinor)} is owed back on ${plural(data.refundsOwed, 'cancelled contract', 'cancelled contracts')}`,
    },
    data.smsNotSending && {
      href: '/settings', text: 'Text messages are not being sent: no SMS provider is set up, so receipts, reminders and alerts reach nobody',
    },
  ].filter((i): i is { href: string; text: string } => !!i);

  if (items.length === 0 && data.alerts.length === 0) return null;

  return (
    <section>
      <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Needs attention</h2>
      <div className="rounded-xl border border-amber-200 bg-amber-50/70 divide-y divide-amber-200/70 overflow-hidden">
        {data.alerts.slice(0, MAX_ALERTS_SHOWN).map((a) => (
          <div key={a.id} className="flex items-start gap-3 px-4 py-3 bg-red-50/80">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-red-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-red-800">{a.message}</p>
              <p className="text-xs text-red-600/80 mt-0.5">
                Last happened {formatDateTime(a.lastSeenAt)}{a.occurrences > 1 ? ` · ${a.occurrences} times` : ''}
              </p>
            </div>
            <button onClick={() => acknowledge(a)} className="shrink-0 text-xs font-medium text-red-700 underline hover:text-red-900">Clear</button>
          </div>
        ))}
        {data.alerts.length > MAX_ALERTS_SHOWN && (
          <p className="px-4 py-2 text-xs text-red-700 bg-red-50/80">And {data.alerts.length - MAX_ALERTS_SHOWN} more. Clear the ones above to see them.</p>
        )}
        {items.map((item) => (
          <Link key={item.href} href={item.href} className="flex items-center gap-3 px-4 py-3 hover:bg-amber-100/60 transition-colors">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            <p className="flex-1 text-sm text-amber-900">{item.text}</p>
            <ChevronRight className="h-4 w-4 shrink-0 text-amber-400" />
          </Link>
        ))}
      </div>
    </section>
  );
}
