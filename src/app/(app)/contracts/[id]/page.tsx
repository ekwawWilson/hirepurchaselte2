'use client';

import { useEffect, useState, use } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDate, formatDateTime, getStatusColor, contractTypeLabel } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';

interface Instalment { id: string; instalmentNo: number; dueDate: string; amountDueMinor: number; principalPortionMinor: number; interestPortionMinor: number; amountPaidMinor: number; status: string; daysPastDue?: number }
interface Payment { id: string; entryType: string; amountMinor: number; channel: string; status: string; receiptNumber: string | null; notes: string | null; reversesPaymentId: string | null; reversedById: string | null; createdAt: string }
interface Preapproval { id: string; status: string; network: string; customerMsisdn: string; verificationType: string | null }
interface DeviceLoanState {
  principalMinor: number; principalOutstanding: boolean;
  accruedInterestMinor: number; interestPaidMinor: number; totalOwedMinor: number;
}
interface ContractDetail {
  id: string; contractNumber: string; contractType: string; status: string; paymentFrequency: string;
  // Null for SAVE_TO_OWN/DEVICE_LOAN — neither has a fixed target/product (contractService.ts).
  totalPayableMinor: number | null; totalPaidMinor: number; balanceMinor: number | null; creditMinor: number;
  depositAmountMinor: number; principalMinor: number | null; interestRateBps: number | null;
  // Only populated for DEVICE_LOAN — derived from Penalty/PaymentAllocation rows,
  // never stored directly (paymentService.ts's getDeviceLoanState).
  deviceLoanState: DeviceLoanState | null;
  customer: { firstName: string; lastName: string; phone: string | null; phone2: string | null; phone3: string | null };
  product: { name: string } | null;
  instalments: Instalment[];
  payments: Payment[];
  hubtelPreapprovalId: string | null;
  hubtelPreapproval: Preapproval | null;
  paymentMethod: string;
}

// DEVICE_LOAN's self-directed two-option payment model has no "auto-charge the
// due amount" equivalent, so it's no longer direct-debit eligible (constants/contracts.ts).
const DIRECT_DEBIT_ELIGIBLE_TYPES = ['DEPOSIT_INSTALMENT'];
const DIRECT_DEBIT_NETWORKS = ['MTN', 'VODAFONE', 'TELECEL'];

export default function ContractDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { hasPermission } = useAuthStore();
  const { toast } = useToast();
  const [contract, setContract] = useState<ContractDetail | null>(null);
  const [amount, setAmount] = useState('');
  const [entryType, setEntryType] = useState<'DEPOSIT' | 'INSTALMENT_PAYMENT'>('INSTALMENT_PAYMENT');
  const [paymentNotes, setPaymentNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawNotes, setWithdrawNotes] = useState('');
  const [withdrawing, setWithdrawing] = useState(false);

  const [loanPaying, setLoanPaying] = useState<'INTEREST' | 'PRINCIPAL' | null>(null);

  const [reverseTarget, setReverseTarget] = useState<Payment | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'writeoff' | 'release' | null>(null);
  const [actionReason, setActionReason] = useState('');

  const [ddMsisdn, setDdMsisdn] = useState('');
  const [ddNetwork, setDdNetwork] = useState('MTN');
  const [ddMode, setDdMode] = useState<'DIRECT_DEBIT' | 'BOTH'>('DIRECT_DEBIT');
  const [ddSaving, setDdSaving] = useState(false);
  const [chargeAmount, setChargeAmount] = useState('');
  const [charging, setCharging] = useState(false);

  async function load() {
    try {
      const { contract } = await api.get<{ contract: ContractDetail }>(`/contracts/${id}`);
      // Computed once here (not at render time — Date.now() in JSX is an impure call
      // React can invoke unpredictably) so each overdue row can show its arrears age.
      const now = Date.now();
      contract.instalments = contract.instalments.map((i) => ({
        ...i,
        daysPastDue: i.status === 'OVERDUE' ? Math.floor((now - new Date(i.dueDate).getTime()) / 86400000) : undefined,
      }));
      setContract(contract);
      if (contract.status === 'PENDING_DEPOSIT') setEntryType('DEPOSIT');
      setDdMsisdn((prev) => prev || contract.customer.phone || contract.customer.phone2 || contract.customer.phone3 || '');
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load contract', variant: 'destructive' });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function recordPayment(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      const amountMinor = Math.round(parseFloat(amount) * 100);
      await api.post('/payments/cash', { contractId: id, amountMinor, entryType, notes: paymentNotes.trim() || undefined });
      toast({ title: 'Payment recorded', description: formatCurrency(amountMinor) });
      setAmount('');
      setPaymentNotes('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to record payment', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  }

  async function recordWithdrawal(e: React.FormEvent) {
    e.preventDefault();
    setWithdrawing(true);
    try {
      const amountMinor = Math.round(parseFloat(withdrawAmount) * 100);
      await api.post('/payments/withdraw', { contractId: id, amountMinor, notes: withdrawNotes.trim() || undefined });
      toast({ title: 'Withdrawal recorded', description: formatCurrency(amountMinor) });
      setWithdrawAmount('');
      setWithdrawNotes('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to record withdrawal', variant: 'destructive' });
    } finally {
      setWithdrawing(false);
    }
  }

  async function payLoan(option: 'INTEREST' | 'PRINCIPAL', amountMinor: number) {
    setLoanPaying(option);
    try {
      await api.post('/payments/device-loan', { contractId: id, amountMinor, option });
      toast({ title: option === 'INTEREST' ? 'Interest paid' : 'Loan amount paid', description: formatCurrency(amountMinor) });
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to record payment', variant: 'destructive' });
    } finally {
      setLoanPaying(null);
    }
  }

  async function confirmReverse() {
    if (!reverseTarget || !reverseReason.trim()) return;
    try {
      await api.post(`/payments/${reverseTarget.id}/reverse`, { reason: reverseReason });
      toast({ title: 'Payment reversed' });
      setReverseTarget(null);
      setReverseReason('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to reverse payment', variant: 'destructive' });
    }
  }

  async function runConfirmedAction() {
    if (!confirmAction) return;
    if (confirmAction !== 'release' && !actionReason.trim()) {
      toast({ title: 'A reason is required', variant: 'destructive' });
      return;
    }
    try {
      const res = await api.post<{ contract: ContractDetail & { refundDueMinor?: number } }>(
        `/contracts/${id}/${confirmAction}`,
        confirmAction === 'release' ? undefined : { reason: actionReason },
      );
      const refundDue = confirmAction === 'cancel' ? res.contract.refundDueMinor ?? 0 : 0;
      toast({
        title: `Contract ${confirmAction === 'writeoff' ? 'written off' : confirmAction === 'release' ? 'released' : 'cancelled'}`,
        description: refundDue > 0 ? `${formatCurrency(refundDue)} already paid — refund to the customer` : undefined,
      });
      setConfirmAction(null);
      setActionReason('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : `Failed to ${confirmAction} contract`, variant: 'destructive' });
    }
  }

  async function setupDirectDebit(e: React.FormEvent) {
    e.preventDefault();
    setDdSaving(true);
    try {
      const res = await api.post<{ reused: boolean; preapproval: { status: string; verificationType: string | null } }>(
        `/contracts/${id}/direct-debit`, { msisdn: ddMsisdn, network: ddNetwork, paymentMethod: ddMode },
      );
      const pending = res.preapproval.status === 'PENDING';
      const isOtp = res.preapproval.verificationType === 'OTP';
      toast({
        title: res.reused ? 'Existing mandate reused' : pending ? 'Awaiting customer approval' : 'Direct debit mandate approved',
        description: !pending ? undefined : isOtp
          ? "This number already has a mandate with another Hubtel merchant — Hubtel sent an OTP instead of a USSD prompt, which this app doesn't support entering. Try a different number."
          : 'The customer must confirm on their phone via a USSD prompt before this can be charged.',
        variant: isOtp ? 'destructive' : undefined,
      });
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to set up direct debit', variant: 'destructive' });
    } finally {
      setDdSaving(false);
    }
  }

  async function disableDirectDebit() {
    try {
      await api.delete(`/contracts/${id}/direct-debit`);
      toast({ title: 'Direct debit disabled' });
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to disable direct debit', variant: 'destructive' });
    }
  }

  async function chargeNow(e: React.FormEvent) {
    e.preventDefault();
    setCharging(true);
    try {
      const amountMinor = Math.round(parseFloat(chargeAmount) * 100);
      await api.post(`/contracts/${id}/direct-debit/charge`, { amountMinor });
      toast({ title: 'Charged', description: formatCurrency(amountMinor) });
      setChargeAmount('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Charge failed', variant: 'destructive' });
    } finally {
      setCharging(false);
    }
  }

  if (!contract) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  const canPay = hasPermission('payment.cash.record');
  const canReverse = hasPermission('payment.reverse');
  const canCancel = hasPermission('contract.cancel');
  const canWriteOff = hasPermission('contract.writeoff');
  const canRelease = hasPermission('inventory.issue');
  const terminal = ['COMPLETED', 'RELEASED', 'CANCELLED', 'WRITTEN_OFF'].includes(contract.status);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{contract.contractNumber}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {contract.customer.firstName} {contract.customer.lastName} &middot; {contract.customer.phone ?? contract.customer.phone2 ?? contract.customer.phone3}
            {contract.product && <> &middot; {contract.product.name}</>} &middot; {contractTypeLabel(contract.contractType)}
            {contract.contractType !== 'SAVE_TO_OWN' && <> &middot; {contract.paymentFrequency.charAt(0) + contract.paymentFrequency.slice(1).toLowerCase()}</>}
          </p>
        </div>
        <span className={`text-[11px] font-semibold uppercase tracking-wide px-3 py-1.5 rounded-full ${getStatusColor(contract.status)}`}>{contract.status}</span>
      </div>

      {contract.contractType === 'SAVE_TO_OWN' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Card className="min-w-0"><CardContent className="p-4"><p className="text-xs text-gray-500">Total saved</p><p className="text-base sm:text-lg font-semibold text-gray-900 break-words">{formatCurrency(contract.totalPaidMinor)}</p></CardContent></Card>
        </div>
      ) : contract.contractType === 'DEVICE_LOAN' ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Card className="min-w-0"><CardContent className="p-4"><p className="text-xs text-gray-500">Loan amount</p><p className="text-base sm:text-lg font-semibold text-gray-900 break-words">{formatCurrency(contract.deviceLoanState?.principalMinor ?? contract.principalMinor ?? 0)}</p></CardContent></Card>
          <Card className="min-w-0"><CardContent className="p-4"><p className="text-xs text-gray-500">Principal</p><p className="text-base sm:text-lg font-semibold text-gray-900 break-words">{contract.deviceLoanState?.principalOutstanding ? 'Outstanding' : 'Paid'}</p></CardContent></Card>
          <Card className="min-w-0"><CardContent className="p-4"><p className="text-xs text-gray-500">Interest owed</p><p className="text-base sm:text-lg font-semibold text-gray-900 break-words">{formatCurrency(contract.deviceLoanState?.accruedInterestMinor ?? 0)}</p></CardContent></Card>
          <Card className="min-w-0"><CardContent className="p-4"><p className="text-xs text-gray-500">Total owed</p><p className="text-base sm:text-lg font-semibold text-gray-900 break-words">{formatCurrency(contract.deviceLoanState?.totalOwedMinor ?? 0)}</p></CardContent></Card>
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-4">
          <Card className="min-w-0"><CardContent className="p-4"><p className="text-xs text-gray-500">Total payable</p><p className="text-base sm:text-lg font-semibold text-gray-900 break-words">{formatCurrency(contract.totalPayableMinor ?? 0)}</p></CardContent></Card>
          <Card className="min-w-0"><CardContent className="p-4"><p className="text-xs text-gray-500">Total paid</p><p className="text-base sm:text-lg font-semibold text-gray-900 break-words">{formatCurrency(contract.totalPaidMinor)}</p></CardContent></Card>
          <Card className="min-w-0">
            <CardContent className="p-4">
              <p className="text-xs text-gray-500">Balance</p>
              <p className="text-base sm:text-lg font-semibold text-gray-900 break-words">{formatCurrency(contract.balanceMinor ?? 0)}</p>
              {contract.creditMinor > 0 && <p className="text-xs text-green-700 mt-0.5 break-words">Credit: {formatCurrency(contract.creditMinor)}</p>}
            </CardContent>
          </Card>
        </div>
      )}

      {canPay && !terminal && contract.contractType === 'DEVICE_LOAN' && (
        <Card>
          <CardHeader><CardTitle>Record a payment</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            <Button
              onClick={() => contract.deviceLoanState && payLoan('INTEREST', contract.deviceLoanState.accruedInterestMinor)}
              disabled={!contract.deviceLoanState || contract.deviceLoanState.accruedInterestMinor <= 0 || loanPaying !== null}
            >
              {loanPaying === 'INTEREST' ? 'Paying...' : `Pay interest (${formatCurrency(contract.deviceLoanState?.accruedInterestMinor ?? 0)})`}
            </Button>
            <Button
              variant="outline"
              onClick={() => contract.deviceLoanState && payLoan('PRINCIPAL', contract.deviceLoanState.principalMinor)}
              disabled={!contract.deviceLoanState || !contract.deviceLoanState.principalOutstanding || loanPaying !== null}
            >
              {loanPaying === 'PRINCIPAL' ? 'Paying...' : `Pay full loan amount (${formatCurrency(contract.deviceLoanState?.principalMinor ?? 0)})`}
            </Button>
            <p className="text-xs text-gray-400 w-full">Paying the full loan amount clears the principal only — any interest already accrued at that point is still owed separately.</p>
          </CardContent>
        </Card>
      )}

      {canPay && !terminal && contract.contractType !== 'DEVICE_LOAN' && (
        <Card>
          <CardHeader><CardTitle>Record a cash payment</CardTitle></CardHeader>
          <CardContent>
            <form className="flex items-end gap-3" onSubmit={recordPayment}>
              {contract.contractType === 'DEPOSIT_INSTALMENT' && contract.status === 'PENDING_DEPOSIT' && (
                <div>
                  <Label>Type</Label>
                  <select
                    className="mt-1.5 flex h-10 border border-input bg-white/90 px-3 py-2 text-sm"
                    value={entryType}
                    onChange={(e) => setEntryType(e.target.value as 'DEPOSIT' | 'INSTALMENT_PAYMENT')}
                  >
                    <option value="DEPOSIT">Deposit</option>
                    <option value="INSTALMENT_PAYMENT">Instalment</option>
                  </select>
                </div>
              )}
              <div>
                <Label>Amount (GHS)</Label>
                <Input required type="number" step="0.01" className="mt-1.5 w-40" value={amount} onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div className="flex-1 min-w-[10rem]">
                <Label>Description</Label>
                <Input
                  placeholder="e.g. counter cash deposit"
                  className="mt-1.5"
                  value={paymentNotes}
                  onChange={(e) => setPaymentNotes(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={saving}>{saving ? 'Recording...' : 'Record payment'}</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {DIRECT_DEBIT_ELIGIBLE_TYPES.includes(contract.contractType) && !terminal && (
        <Card>
          <CardHeader><CardTitle>Direct debit</CardTitle></CardHeader>
          <CardContent>
            {contract.hubtelPreapproval ? (
              <div className="space-y-3">
                <div className="flex items-center gap-3">
                  <span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${getStatusColor(contract.hubtelPreapproval.status)}`}>
                    {contract.hubtelPreapproval.status}
                  </span>
                  <span className="text-sm text-gray-600">{contract.hubtelPreapproval.customerMsisdn} &middot; {contract.hubtelPreapproval.network}</span>
                </div>
                {contract.hubtelPreapproval.status === 'PENDING' && (
                  contract.hubtelPreapproval.verificationType === 'OTP' ? (
                    <p className="text-xs text-red-600">
                      Hubtel sent this customer an OTP instead of a USSD prompt — their number already has a
                      direct-debit mandate with a different Hubtel merchant, so Hubtel requires OTP verification for
                      it. This app doesn&apos;t support entering that OTP yet. Ask the customer for a different mobile
                      money number, or disable this mandate and try again with one.
                    </p>
                  ) : (
                    <p className="text-xs text-gray-500">
                      Waiting on the customer to approve on their phone — a USSD prompt, or *170# &rarr; My Wallet
                      &rarr; My Approvals &rarr; PreApprovals if they missed it.
                    </p>
                  )
                )}
                {contract.status === 'PENDING_DEPOSIT' && (
                  <p className="text-xs text-amber-600">
                    Mandate {contract.hubtelPreapproval.status === 'APPROVED' ? 'approved' : 'requested'} — nothing is charged until the deposit
                    clears and the contract activates.
                  </p>
                )}
                {canPay && contract.hubtelPreapproval.status === 'APPROVED' && contract.status === 'ACTIVE' && (
                  <form className="flex items-end gap-3" onSubmit={chargeNow}>
                    <div>
                      <Label>Charge amount (GHS)</Label>
                      <Input required type="number" step="0.01" className="mt-1.5 w-40" value={chargeAmount} onChange={(e) => setChargeAmount(e.target.value)} />
                    </div>
                    <Button type="submit" disabled={charging}>{charging ? 'Charging...' : 'Charge now'}</Button>
                    <Button type="button" variant="outline" onClick={disableDirectDebit}>Disable</Button>
                  </form>
                )}
                {canPay && !(contract.hubtelPreapproval.status === 'APPROVED' && contract.status === 'ACTIVE') && (
                  <Button type="button" variant="outline" size="sm" onClick={disableDirectDebit}>Disable</Button>
                )}
                {contract.status === 'ACTIVE' && (
                  <p className="text-xs text-gray-400">
                    {contract.paymentMethod === 'BOTH'
                      ? 'Customer can pay cash/USSD themselves — direct debit only charges once an instalment goes overdue (they defaulted on paying it).'
                      : 'The mandate is charged automatically the moment each instalment is due.'}
                    {' '}&quot;Charge now&quot; is only for an out-of-cycle collection.
                  </p>
                )}
              </div>
            ) : contract.status === 'ACTIVE' ? (
              <form className="flex items-end gap-3" onSubmit={setupDirectDebit}>
                <div>
                  <Label>Mobile money number</Label>
                  <Input required className="mt-1.5 w-44" value={ddMsisdn} onChange={(e) => setDdMsisdn(e.target.value)} />
                </div>
                <div>
                  <Label>Network</Label>
                  <select
                    className="mt-1.5 flex h-10 border border-input bg-white/90 px-3 py-2 text-sm"
                    value={ddNetwork}
                    onChange={(e) => setDdNetwork(e.target.value)}
                  >
                    {DIRECT_DEBIT_NETWORKS.map((n) => <option key={n} value={n}>{n}</option>)}
                  </select>
                </div>
                <div>
                  <Label>Mode</Label>
                  <select
                    className="mt-1.5 flex h-10 border border-input bg-white/90 px-3 py-2 text-sm"
                    value={ddMode}
                    onChange={(e) => setDdMode(e.target.value as 'DIRECT_DEBIT' | 'BOTH')}
                  >
                    <option value="DIRECT_DEBIT">Direct debit only</option>
                    <option value="BOTH">Both — on default</option>
                  </select>
                </div>
                <Button type="submit" disabled={ddSaving}>{ddSaving ? 'Setting up...' : 'Set up direct debit'}</Button>
              </form>
            ) : (
              <p className="text-sm text-gray-500">Direct debit becomes available once the contract is ACTIVE.</p>
            )}
          </CardContent>
        </Card>
      )}

      {contract.contractType === 'SAVE_TO_OWN' ? (
        <Card>
          <CardHeader><CardTitle>Savings progress</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-gray-500">
              {contract.product
                ? `Save to Own has no fixed schedule — the customer deposits any amount, any time, toward ${contract.product.name}. The device is released once staff decide the saved amount is enough.`
                : 'Save to Own has no fixed schedule, no target, and no linked product — the customer deposits any amount, any time, until they withdraw or the saved amount is put toward a purchase.'}
            </p>
            {canReverse && contract.status === 'ACTIVE' && contract.totalPaidMinor > 0 && (
              <form className="flex flex-wrap items-end gap-3 border-t border-gray-100 pt-4" onSubmit={recordWithdrawal}>
                <div>
                  <Label>Withdraw savings (GHS)</Label>
                  <Input
                    required type="number" step="0.01" min="0.01" max={contract.totalPaidMinor / 100}
                    className="mt-1.5 w-40" value={withdrawAmount} onChange={(e) => setWithdrawAmount(e.target.value)}
                  />
                </div>
                <div className="flex-1 min-w-[10rem]">
                  <Label>Reason</Label>
                  <Input
                    placeholder="e.g. emergency withdrawal"
                    className="mt-1.5"
                    value={withdrawNotes}
                    onChange={(e) => setWithdrawNotes(e.target.value)}
                  />
                </div>
                <Button type="submit" variant="outline" disabled={withdrawing}>{withdrawing ? 'Withdrawing...' : 'Withdraw'}</Button>
                <p className="text-xs text-gray-400 pb-2.5 w-full sm:w-auto">Up to {formatCurrency(contract.totalPaidMinor)} saved so far</p>
              </form>
            )}
          </CardContent>
        </Card>
      ) : contract.contractType === 'DEVICE_LOAN' ? (
        <Card>
          <CardHeader><CardTitle>Daily interest</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-gray-500">
              No fixed instalment schedule — 1% of the loan amount accrues each working day (after the grace period) until
              the customer pays it off, either as accrued interest or the full loan amount at once.
            </p>
          </CardContent>
        </Card>
      ) : (
      <Card>
        <CardHeader><CardTitle>Instalment schedule</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead><TableHead>Due date</TableHead><TableHead>Amount due</TableHead>
                <TableHead>Paid</TableHead><TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contract.instalments.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{i.instalmentNo}</TableCell>
                  <TableCell>{formatDate(i.dueDate)}</TableCell>
                  <TableCell>{formatCurrency(i.amountDueMinor)}</TableCell>
                  <TableCell>{formatCurrency(i.amountPaidMinor)}</TableCell>
                  <TableCell>
                    <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${getStatusColor(i.status)}`}>{i.status}</span>
                    {i.status === 'OVERDUE' && (
                      <span className="ml-1.5 text-[11px] text-red-600">{i.daysPastDue}d past due</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
      )}

      <Card>
        <CardHeader><CardTitle>Payments</CardTitle></CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Channel</TableHead><TableHead>Amount</TableHead><TableHead>Description</TableHead><TableHead>Receipt</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {contract.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-gray-500">{formatDateTime(p.createdAt)}</TableCell>
                  <TableCell>{p.entryType}{p.reversesPaymentId && ' (reversal)'}</TableCell>
                  <TableCell>{p.channel}</TableCell>
                  <TableCell className={p.entryType === 'WITHDRAWAL' && !p.reversesPaymentId ? 'text-red-600' : undefined}>
                    {p.entryType === 'WITHDRAWAL' && !p.reversesPaymentId ? '-' : ''}{formatCurrency(p.amountMinor)}
                  </TableCell>
                  <TableCell className="text-gray-500 max-w-[14rem] truncate" title={p.notes ?? undefined}>{p.notes ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{p.receiptNumber ?? '—'}</TableCell>
                  <TableCell>
                    {canReverse && !p.reversesPaymentId && !p.reversedById && (
                      <button className="text-xs text-red-600 hover:underline" onClick={() => setReverseTarget(p)}>Reverse</button>
                    )}
                    {p.reversedById && <span className="text-xs text-gray-400">Reversed</span>}
                  </TableCell>
                </TableRow>
              ))}
              {contract.payments.length === 0 && (
                <TableRow><TableCell colSpan={7} className="text-center py-6 text-gray-400">No payments yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {(canCancel || canWriteOff || canRelease) && !terminal && (
        <Card>
          <CardHeader><CardTitle>Actions</CardTitle></CardHeader>
          <CardContent className="flex gap-3">
            {canRelease && contract.contractType === 'SAVE_TO_OWN' && contract.status === 'COMPLETED' && (
              <Button onClick={() => setConfirmAction('release')}>Release device</Button>
            )}
            {canCancel && contract.contractType !== 'DEVICE_LOAN' && (
              <Button variant="outline" onClick={() => setConfirmAction('cancel')}>Cancel contract</Button>
            )}
            {canWriteOff && contract.contractType === 'DEVICE_LOAN' && (
              <Button variant="destructive" onClick={() => setConfirmAction('writeoff')}>Write off</Button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Reverse payment dialog */}
      <Dialog open={!!reverseTarget} onOpenChange={(open) => !open && setReverseTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse payment</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This creates a reversal entry for {reverseTarget && formatCurrency(reverseTarget.amountMinor)} — the original
            payment record is kept, not deleted.
          </p>
          <div>
            <Label>Reason</Label>
            <Input className="mt-1.5" value={reverseReason} onChange={(e) => setReverseReason(e.target.value)} placeholder="e.g. entered in error" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReverseTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={confirmReverse} disabled={!reverseReason.trim()}>Reverse payment</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel/writeoff/release confirmation */}
      <AlertDialog open={!!confirmAction} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === 'release' ? 'Release device to customer?' : confirmAction === 'writeoff' ? 'Write off this contract?' : 'Cancel this contract?'}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === 'release'
                ? 'This marks the device as issued and the contract as RELEASED.'
                : 'This action is recorded against your user and cannot be undone from the UI.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {confirmAction !== 'release' && (
            <div>
              <Label>Reason</Label>
              <Input className="mt-1.5" value={actionReason} onChange={(e) => setActionReason(e.target.value)} />
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setActionReason('')}>Back</AlertDialogCancel>
            <AlertDialogAction onClick={runConfirmedAction}>Confirm</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
