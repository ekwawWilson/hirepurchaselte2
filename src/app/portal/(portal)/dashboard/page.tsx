'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowRight, CheckCircle, ChevronRight, CreditCard, FileText, Wallet } from 'lucide-react';
import { portalApi, ApiError } from '@/lib/portalApi';
import { useCustomerAuthStore } from '@/lib/customerAuthStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, contractTypeLabel, formatDate, getStatusColor, cn } from '@/lib/utils';
import { StatTile } from '@/components/StatTile';
import { Card, CardContent } from '@/components/ui/card';
import type { PortalContract, PortalUpcoming } from '@/lib/portalTypes';
import { amountOwed, progressPercent } from '@/lib/portalTypes';

export default function PortalDashboardPage() {
  const customer = useCustomerAuthStore((s) => s.customer);
  const { toast } = useToast();
  const [contracts, setContracts] = useState<PortalContract[]>([]);
  const [upcoming, setUpcoming] = useState<PortalUpcoming[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await portalApi.get<{ contracts: PortalContract[]; upcoming: PortalUpcoming[] }>('/contracts');
      setContracts(data.contracts);
      setUpcoming(data.upcoming);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load your account', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const active = contracts.filter((c) => c.status === 'ACTIVE' || c.status === 'PENDING_DEPOSIT' || c.status === 'DEFAULTED');
  const totalOwed = active.reduce((sum, c) => sum + amountOwed(c), 0);
  const nextDue = upcoming[0] ?? null;

  if (isLoading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="h-10 w-10 border-2 border-gray-300 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Hello {customer?.firstName}</h1>
        <p className="text-sm text-gray-500 mt-0.5">Here is where your account stands today</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatTile icon={FileText} label="Contracts" value={String(contracts.length)} caption={`${active.length} running`} />
        <StatTile icon={CheckCircle} label="Running" value={String(active.length)} color="emerald" />
        <StatTile icon={Wallet} label="You owe" value={formatCurrency(totalOwed)} color={totalOwed > 0 ? 'red' : 'gray'} />
        <StatTile
          icon={AlertCircle}
          label="Next payment"
          value={nextDue ? formatCurrency(nextDue.amountDueMinor - nextDue.amountPaidMinor) : '—'}
          color="amber"
          caption={nextDue ? formatDate(nextDue.dueDate) : 'Nothing due'}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <Link href="/portal/payments" className="flex flex-col items-center gap-2 p-4 bg-primary hover:bg-primary/90 text-white transition-colors">
          <CreditCard className="h-6 w-6" />
          <span className="text-sm font-semibold">Make a payment</span>
        </Link>
        <Link href="/portal/contracts" className="flex flex-col items-center gap-2 p-4 bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 transition-colors">
          <FileText className="h-6 w-6" />
          <span className="text-sm font-semibold">My contracts</span>
        </Link>
        <Link href="/portal/profile" className="flex flex-col items-center gap-2 p-4 bg-white hover:bg-gray-50 text-gray-700 border border-gray-200 transition-colors col-span-2 sm:col-span-1">
          <Wallet className="h-6 w-6" />
          <span className="text-sm font-semibold">My details</span>
        </Link>
      </div>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Your contracts</h2>
          <Link href="/portal/contracts" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            See all <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        {active.length === 0 ? (
          <Card>
            <CardContent className="text-center py-10">
              <FileText className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">You have no running contracts.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {active.slice(0, 3).map((c) => <ContractRow key={c.id} contract={c} />)}
          </div>
        )}
      </section>

      {upcoming.length > 0 && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Coming up</h2>
            <Link href="/portal/payments" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              Pay now <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
          <Card>
            <CardContent className="p-0 divide-y divide-gray-100">
              {upcoming.slice(0, 5).map((inst) => (
                <div key={inst.id} className="flex items-center gap-3 px-4 py-3">
                  <span className={cn('h-2 w-2 rounded-full shrink-0', inst.status === 'OVERDUE' ? 'bg-red-500' : 'bg-amber-400')} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono text-gray-500 truncate">{inst.contract.contractNumber}</p>
                    <p className="text-xs text-gray-400">{formatDate(inst.dueDate)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold text-gray-900">{formatCurrency(inst.amountDueMinor - inst.amountPaidMinor)}</p>
                    <span className={cn('text-[10px] font-semibold px-1.5 py-0.5 rounded-full', getStatusColor(inst.status))}>{inst.status}</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  );
}

function ContractRow({ contract }: { contract: PortalContract }) {
  const owed = amountOwed(contract);
  const progress = progressPercent(contract);

  return (
    <Link href={`/portal/contracts/${contract.id}`} className="block bg-white border border-gray-200 p-4 hover:shadow-sm transition-shadow group">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900 truncate">{contract.product?.name ?? contractTypeLabel(contract.contractType)}</p>
          <p className="text-xs text-gray-500 mt-0.5 font-mono">{contract.contractNumber}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="text-sm font-bold text-emerald-600">{formatCurrency(contract.totalPaidMinor)}</p>
          <p className="text-xs text-gray-400">paid so far</p>
        </div>
        <ChevronRight className="h-4 w-4 text-gray-300 shrink-0 mt-0.5 group-hover:text-gray-500 transition-colors" />
      </div>

      {progress !== null && (
        <div className="mt-3">
          <div className="flex justify-between text-[10px] text-gray-400 mb-1">
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      {owed > 0 && <p className="mt-2 text-xs text-red-500 font-medium">Still to pay: {formatCurrency(owed)}</p>}
    </Link>
  );
}
