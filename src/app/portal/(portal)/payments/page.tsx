'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { CheckCircle2, CreditCard, Loader2, Receipt } from 'lucide-react';
import { portalApi, ApiError } from '@/lib/portalApi';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, contractTypeLabel, formatDate, cn } from '@/lib/utils';
import { MOBILE_MONEY_NETWORKS, MOBILE_MONEY_NETWORK_LABELS } from '@/lib/constants/contracts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import type { PortalContract, PortalPayment } from '@/lib/portalTypes';
import { amountOwed, paymentLabel } from '@/lib/portalTypes';

// How often to ask whether a charge has been approved on the customer's phone.
const POLL_INTERVAL_MS = 3000;
const POLL_ATTEMPTS = 40; // ~2 minutes, about as long as a customer will wait

export default function PortalPaymentsPage() {
  return (
    <Suspense fallback={<div className="h-40" />}>
      <PaymentsContent />
    </Suspense>
  );
}

function PaymentsContent() {
  const searchParams = useSearchParams();
  const { toast } = useToast();

  const [contracts, setContracts] = useState<PortalContract[]>([]);
  const [payments, setPayments] = useState<PortalPayment[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [contractId, setContractId] = useState(searchParams.get('contract') ?? '');
  const [amount, setAmount] = useState('');
  const [network, setNetwork] = useState<string>('MTN');
  const [msisdn, setMsisdn] = useState('');
  const [stage, setStage] = useState<'idle' | 'waiting' | 'done'>('idle');

  const load = useCallback(async () => {
    try {
      const [c, p] = await Promise.all([
        portalApi.get<{ contracts: PortalContract[] }>('/contracts'),
        portalApi.get<{ payments: PortalPayment[] }>('/payments'),
      ]);
      setContracts(c.contracts);
      setPayments(p.payments);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load your payments', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => { load(); }, [load]);

  const payable = contracts.filter((c) => !['COMPLETED', 'RELEASED', 'CANCELLED', 'WRITTEN_OFF'].includes(c.status));
  const selected = payable.find((c) => c.id === contractId) ?? null;
  const isLoan = selected?.contractType === 'DEVICE_LOAN';
  const owed = selected ? amountOwed(selected) : 0;

  // A device loan takes exactly one of two amounts (the same two the USSD
  // menu offers), so the customer picks rather than types.
  const loanOptions = isLoan && selected?.deviceLoanState
    ? [
        ...(selected.deviceLoanState.accruedInterestMinor > 0
          ? [{ label: 'Interest owed', amountMinor: selected.deviceLoanState.accruedInterestMinor }] : []),
        ...(selected.deviceLoanState.principalOutstanding
          ? [{ label: 'Full loan amount', amountMinor: selected.deviceLoanState.principalMinor }] : []),
      ]
    : [];

  const amountMinor = Math.round(parseFloat(amount || '0') * 100);
  const canPay = !!selected && Number.isFinite(amountMinor) && amountMinor > 0 && !!msisdn.trim() && stage !== 'waiting';

  async function pay() {
    if (!selected) return;
    setStage('waiting');
    try {
      const { reference } = await portalApi.post<{ reference: string; status: string }>('/pay', {
        contractId: selected.id, amountMinor, network, msisdn: msisdn.trim(),
      });

      // Mock mode settles at once; a live charge waits on the customer
      // approving it on their handset, so poll until it resolves.
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        const status = await portalApi.get<{ status: string; recorded: boolean }>(`/pay/${reference}`);
        if (status.status === 'SUCCESS' || status.status === 'NEEDS_REVIEW') {
          setStage('done');
          toast({
            title: 'Payment received',
            description: status.recorded
              ? 'Thank you — your account has been updated.'
              : 'Thank you — your payment is being applied to your account.',
          });
          setAmount('');
          await load();
          return;
        }
        if (status.status === 'FAILED') {
          setStage('idle');
          toast({ title: 'Payment failed', description: 'The payment was not completed. Please try again.', variant: 'destructive' });
          return;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      setStage('idle');
      toast({ title: 'Still waiting', description: 'We have not had confirmation yet. Check your payment history in a moment.' });
    } catch (e) {
      setStage('idle');
      toast({ title: 'Payment not started', description: e instanceof ApiError ? e.message : 'Something went wrong', variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Payments</h1>
        <p className="text-sm text-gray-500 mt-0.5">Pay by mobile money, and see everything you have paid</p>
      </div>

      <Card>
        <CardHeader><CardTitle>Make a payment</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {payable.length === 0 ? (
            <p className="text-sm text-gray-500">You have nothing to pay right now.</p>
          ) : (
            <>
              <div>
                <Label>Contract</Label>
                <Select value={contractId} onValueChange={(v) => { setContractId(v); setAmount(''); }}>
                  <SelectTrigger className="mt-1.5"><SelectValue placeholder="Choose a contract" /></SelectTrigger>
                  <SelectContent>
                    {payable.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.contractNumber} — {c.product?.name ?? contractTypeLabel(c.contractType)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selected && (
                  <p className="text-xs text-gray-400 mt-1">
                    {selected.contractType === 'SAVE_TO_OWN'
                      ? 'Savings — pay in any amount you like.'
                      : owed > 0 ? `Outstanding: ${formatCurrency(owed)}` : 'Nothing outstanding.'}
                  </p>
                )}
              </div>

              {isLoan ? (
                <div>
                  <Label>Amount</Label>
                  <div className="mt-1.5 grid gap-2 sm:grid-cols-2">
                    {loanOptions.length === 0 && <p className="text-sm text-gray-500">This loan is fully paid.</p>}
                    {loanOptions.map((o) => {
                      const active = amountMinor === o.amountMinor;
                      return (
                        <button
                          key={o.label}
                          type="button"
                          onClick={() => setAmount((o.amountMinor / 100).toFixed(2))}
                          className={cn('border p-3 text-left transition-colors',
                            active ? 'border-primary bg-blue-50' : 'border-gray-200 hover:border-blue-300')}
                        >
                          <p className="text-sm font-semibold text-gray-900">{o.label}</p>
                          <p className="text-lg font-bold text-gray-900">{formatCurrency(o.amountMinor)}</p>
                        </button>
                      );
                    })}
                  </div>
                  <p className="text-xs text-gray-400 mt-1">A loan is paid as either the interest owed or the whole loan — no other amount.</p>
                </div>
              ) : (
                <div>
                  <Label htmlFor="amount">Amount (GHS)</Label>
                  <Input
                    id="amount" type="number" min="0.01" step="0.01" className="mt-1.5"
                    value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00"
                  />
                  {owed > 0 && (
                    <button type="button" onClick={() => setAmount((owed / 100).toFixed(2))}
                      className="text-xs text-primary hover:underline mt-1">
                      Pay everything outstanding ({formatCurrency(owed)})
                    </button>
                  )}
                </div>
              )}

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label>Mobile money network</Label>
                  <Select value={network} onValueChange={setNetwork}>
                    <SelectTrigger className="mt-1.5"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {MOBILE_MONEY_NETWORKS.map((n) => (
                        <SelectItem key={n} value={n}>{MOBILE_MONEY_NETWORK_LABELS[n]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label htmlFor="msisdn">Mobile money number</Label>
                  <Input id="msisdn" type="tel" inputMode="tel" className="mt-1.5"
                    value={msisdn} onChange={(e) => setMsisdn(e.target.value)} placeholder="024 000 0000" />
                </div>
              </div>

              <button
                type="button" onClick={pay} disabled={!canPay}
                className="w-full sm:w-auto h-11 px-6 bg-primary hover:bg-primary/90 text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-2 transition-colors"
              >
                {stage === 'waiting'
                  ? <><Loader2 className="h-4 w-4 animate-spin" /> Waiting for your approval…</>
                  : <><CreditCard className="h-4 w-4" /> Pay {amountMinor > 0 ? formatCurrency(amountMinor) : ''}</>}
              </button>

              {stage === 'waiting' && (
                <p className="text-xs text-gray-500">Check your phone and approve the payment prompt. Keep this page open.</p>
              )}
              {stage === 'done' && (
                <p className="text-sm text-emerald-600 flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" /> Payment received. Thank you.</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Payment history</CardTitle></CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          {isLoading ? (
            <p className="py-8 text-center text-sm text-gray-400">Loading…</p>
          ) : payments.length === 0 ? (
            <div className="py-10 text-center">
              <Receipt className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">No payments yet.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Contract</TableHead>
                  <TableHead>What</TableHead>
                  <TableHead>How</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payments.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>{p.receivedAt ? formatDate(p.receivedAt) : '—'}</TableCell>
                    <TableCell className="font-mono text-xs">{p.contract?.contractNumber}</TableCell>
                    <TableCell>{paymentLabel(p)}</TableCell>
                    <TableCell className="text-gray-500">{p.channel === 'CASH' ? 'Cash' : p.channel === 'USSD' ? 'Mobile money' : 'Direct debit'}</TableCell>
                    <TableCell className={cn('text-right font-medium', p.reversesPaymentId || p.entryType === 'WITHDRAWAL' ? 'text-red-500' : 'text-gray-900')}>
                      {p.reversesPaymentId || p.entryType === 'WITHDRAWAL' ? '−' : ''}{formatCurrency(p.amountMinor)}
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
