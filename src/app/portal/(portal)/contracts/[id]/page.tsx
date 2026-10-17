'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { ArrowLeft, CreditCard, FileText } from 'lucide-react';
import { portalApi, ApiError } from '@/lib/portalApi';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, contractTypeLabel, formatDate, getStatusColor, cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import type { PortalContractDetail } from '@/lib/portalTypes';
import { amountOwed, progressPercent, paymentLabel } from '@/lib/portalTypes';
import { unitTitle } from '@/lib/unitLabel';
import { isMoneyOut } from '@/lib/constants/contracts';

export default function PortalContractDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const [contract, setContract] = useState<PortalContractDetail | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await portalApi.get<{ contract: PortalContractDetail }>(`/contracts/${id}`);
      setContract(data.contract);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load this contract', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [id, toast]);

  useEffect(() => { load(); }, [load]);

  if (isLoading) {
    return (
      <div className="flex h-[50vh] items-center justify-center">
        <div className="h-10 w-10 border-2 border-gray-300 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }
  if (!contract) {
    return (
      <Card><CardContent className="py-12 text-center text-sm text-gray-500">This contract could not be found.</CardContent></Card>
    );
  }

  const owed = amountOwed(contract);
  const progress = progressPercent(contract);
  const isLoan = contract.contractType === 'DEVICE_LOAN';
  const isSavings = contract.contractType === 'SAVE_TO_OWN';

  return (
    <div className="space-y-5">
      <Link href="/portal/contracts" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700">
        <ArrowLeft className="h-4 w-4" /> All contracts
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">
            {contract.product ? unitTitle(contract.product.name, contract.inventoryItem?.name) : contractTypeLabel(contract.contractType)}
          </h1>
          {contract.inventoryItem?.description && <p className="text-sm text-gray-600 mt-0.5">{contract.inventoryItem.description}</p>}
          <p className="text-sm text-gray-500 mt-0.5 font-mono">{contract.contractNumber}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href={`/portal/contracts/${contract.id}/statement`} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
            <FileText className="h-3.5 w-3.5" /> Statement
          </Link>
          <Badge className={getStatusColor(contract.status)}>{contract.status.replace(/_/g, ' ')}</Badge>
        </div>
      </div>

      {!isSavings && contract.totalPayableMinor !== null && contract.totalPaidMinor > contract.totalPayableMinor && (
        <Card className="border-emerald-200 bg-emerald-50/60">
          <CardContent className="p-4 text-sm text-emerald-800">
            You have paid {formatCurrency(contract.totalPaidMinor - contract.totalPayableMinor)} more than this contract costs. Visit us to have it refunded.
          </CardContent>
        </Card>
      )}

      {/* Headline figures, worded for the contract type in hand */}
      <Card>
        <CardContent className="p-5 grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Figure label={isSavings ? 'Saved so far' : 'Paid so far'} value={formatCurrency(contract.totalPaidMinor)} tone="good" />
          {isSavings ? (
            <Figure label="Type" value="Open savings" />
          ) : isLoan ? (
            <>
              <Figure label="Loan amount" value={formatCurrency(contract.deviceLoanState?.principalMinor ?? 0)} />
              <Figure label="Interest owed" value={formatCurrency(contract.deviceLoanState?.accruedInterestMinor ?? 0)} tone={owed > 0 ? 'bad' : undefined} />
            </>
          ) : (
            <>
              <Figure label="Total price" value={formatCurrency(contract.totalPayableMinor ?? 0)} />
              <Figure label="Still to pay" value={formatCurrency(owed)} tone={owed > 0 ? 'bad' : undefined} />
            </>
          )}
        </CardContent>
      </Card>

      {progress !== null && (
        <Card>
          <CardContent className="p-5">
            <div className="flex justify-between text-xs text-gray-500 mb-2">
              <span>Progress</span><span>{progress}% paid</span>
            </div>
            <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${progress}%` }} />
            </div>
          </CardContent>
        </Card>
      )}

      <Link
        href={`/portal/payments?contract=${contract.id}`}
        className="inline-flex items-center gap-2 h-11 px-5 bg-primary hover:bg-primary/90 text-white text-sm font-semibold transition-colors"
      >
        <CreditCard className="h-4 w-4" /> {isSavings ? 'Pay into this account' : 'Make a payment'}
      </Link>

      {contract.instalments.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Payment schedule</CardTitle></CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contract.instalments.map((inst) => (
                  <TableRow key={inst.id}>
                    <TableCell className="text-gray-400">{inst.instalmentNo}</TableCell>
                    <TableCell>{formatDate(inst.dueDate)}</TableCell>
                    <TableCell className="text-right">{formatCurrency(inst.amountDueMinor)}</TableCell>
                    <TableCell className="text-right text-emerald-600">{formatCurrency(inst.amountPaidMinor)}</TableCell>
                    <TableCell><Badge className={getStatusColor(inst.status)}>{inst.status}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Payments on this contract</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {contract.payments.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">No payments yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>Receipt</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {contract.payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.receivedAt ? formatDate(p.receivedAt) : '—'}</TableCell>
                    <TableCell>{paymentLabel(p)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {!p.reversesPaymentId
                        ? <Link href={`/portal/contracts/${contract.id}/receipt/${p.id}`} className="text-primary hover:underline">{p.receiptNumber ?? 'Receipt'}</Link>
                        : <span className="text-gray-500">{p.receiptNumber ?? '—'}</span>}
                    </TableCell>
                    <TableCell className={cn('text-right font-medium', p.reversesPaymentId || isMoneyOut(p.entryType) ? 'text-red-500' : 'text-gray-900')}>
                      {p.reversesPaymentId || isMoneyOut(p.entryType) ? '−' : ''}{formatCurrency(p.amountMinor)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-gray-500">{label}</p>
      <p className={cn('text-lg font-semibold truncate',
        tone === 'good' ? 'text-emerald-600' : tone === 'bad' ? 'text-red-600' : 'text-gray-900')}>
        {value}
      </p>
    </div>
  );
}
