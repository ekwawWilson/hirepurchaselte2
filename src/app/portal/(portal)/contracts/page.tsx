'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ChevronRight, FileText } from 'lucide-react';
import { portalApi, ApiError } from '@/lib/portalApi';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, contractTypeLabel, formatDate, getStatusColor, cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import type { PortalContract } from '@/lib/portalTypes';
import { amountOwed, progressPercent } from '@/lib/portalTypes';

export default function PortalContractsPage() {
  const { toast } = useToast();
  const [contracts, setContracts] = useState<PortalContract[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await portalApi.get<{ contracts: PortalContract[] }>('/contracts');
      setContracts(data.contracts);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load your contracts', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">My contracts</h1>
        <p className="text-sm text-gray-500 mt-0.5">Everything you hold with us</p>
      </div>

      {isLoading ? (
        <div className="flex h-40 items-center justify-center">
          <div className="h-8 w-8 border-2 border-gray-300 border-t-primary rounded-full animate-spin" />
        </div>
      ) : contracts.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12">
            <FileText className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">You have no contracts yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {contracts.map((c) => {
            const owed = amountOwed(c);
            const progress = progressPercent(c);
            return (
              <Link key={c.id} href={`/portal/contracts/${c.id}`} className="block bg-white border border-gray-200 p-4 hover:shadow-sm transition-shadow group">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-gray-900 truncate">
                        {c.product?.name ?? contractTypeLabel(c.contractType)}
                      </p>
                      <Badge className={getStatusColor(c.status)}>{c.status.replace(/_/g, ' ')}</Badge>
                    </div>
                    <p className="text-xs text-gray-500 mt-1 font-mono">{c.contractNumber}</p>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {contractTypeLabel(c.contractType)} · started {formatDate(c.startDate)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-bold text-gray-900">{formatCurrency(c.totalPaidMinor)}</p>
                    <p className="text-xs text-gray-400">paid</p>
                  </div>
                  <ChevronRight className="h-4 w-4 text-gray-300 shrink-0 mt-1 group-hover:text-gray-500 transition-colors" />
                </div>

                {progress !== null && (
                  <div className="mt-3">
                    <div className="flex justify-between text-[10px] text-gray-400 mb-1">
                      <span>Progress</span><span>{progress}%</span>
                    </div>
                    <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                )}

                <p className={cn('mt-2 text-xs font-medium', owed > 0 ? 'text-red-500' : 'text-gray-400')}>
                  {c.contractType === 'SAVE_TO_OWN'
                    ? 'Savings account — pay in any amount, any time'
                    : owed > 0 ? `Still to pay: ${formatCurrency(owed)}` : 'Nothing outstanding'}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
