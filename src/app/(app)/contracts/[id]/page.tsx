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
interface Payment { id: string; entryType: string; amountMinor: number; channel: string; status: string; receiptNumber: string | null; reversesPaymentId: string | null; reversedById: string | null; createdAt: string }
interface ContractDetail {
  id: string; contractNumber: string; contractType: string; status: string; paymentFrequency: string;
  totalPayableMinor: number; totalPaidMinor: number; balanceMinor: number; creditMinor: number;
  depositAmountMinor: number; principalMinor: number | null; interestRateBps: number | null;
  customer: { firstName: string; lastName: string; phone: string };
  product: { name: string };
  instalments: Instalment[];
  payments: Payment[];
}

export default function ContractDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { hasPermission } = useAuthStore();
  const { toast } = useToast();
  const [contract, setContract] = useState<ContractDetail | null>(null);
  const [amount, setAmount] = useState('');
  const [entryType, setEntryType] = useState<'DEPOSIT' | 'INSTALMENT_PAYMENT'>('INSTALMENT_PAYMENT');
  const [saving, setSaving] = useState(false);

  const [reverseTarget, setReverseTarget] = useState<Payment | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const [confirmAction, setConfirmAction] = useState<'cancel' | 'writeoff' | 'release' | null>(null);
  const [actionReason, setActionReason] = useState('');

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
      await api.post('/payments/cash', { contractId: id, amountMinor, entryType });
      toast({ title: 'Payment recorded', description: formatCurrency(amountMinor) });
      setAmount('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to record payment', variant: 'destructive' });
    } finally {
      setSaving(false);
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

  if (!contract) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" /></div>;
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
            {contract.customer.firstName} {contract.customer.lastName} &middot; {contract.customer.phone} &middot; {contract.product.name} &middot; {contractTypeLabel(contract.contractType)} &middot; {contract.paymentFrequency.charAt(0) + contract.paymentFrequency.slice(1).toLowerCase()}
          </p>
        </div>
        <span className={`text-[11px] font-semibold uppercase tracking-wide px-3 py-1.5 ${getStatusColor(contract.status)}`}>{contract.status}</span>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Total payable</p><p className="text-lg font-semibold text-gray-900">{formatCurrency(contract.totalPayableMinor)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-gray-500">Total paid</p><p className="text-lg font-semibold text-gray-900">{formatCurrency(contract.totalPaidMinor)}</p></CardContent></Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-gray-500">Balance</p>
            <p className="text-lg font-semibold text-gray-900">{formatCurrency(contract.balanceMinor)}</p>
            {contract.creditMinor > 0 && <p className="text-xs text-green-700 mt-0.5">Credit: {formatCurrency(contract.creditMinor)}</p>}
          </CardContent>
        </Card>
      </div>

      {canPay && !terminal && (
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
              <Button type="submit" disabled={saving}>{saving ? 'Recording...' : 'Record payment'}</Button>
            </form>
          </CardContent>
        </Card>
      )}

      {contract.contractType === 'SAVE_TO_OWN' ? (
        <Card>
          <CardHeader><CardTitle>Savings progress</CardTitle></CardHeader>
          <CardContent>
            <p className="text-sm text-gray-500">
              Save to Own has no fixed schedule — the customer deposits any amount, any time, toward the total
              above. The device is released once the balance reaches zero.
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
                {contract.contractType === 'DEVICE_LOAN' && <><TableHead>Interest</TableHead><TableHead>Principal</TableHead></>}
                <TableHead>Paid</TableHead><TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {contract.instalments.map((i) => (
                <TableRow key={i.id}>
                  <TableCell>{i.instalmentNo}</TableCell>
                  <TableCell>{formatDate(i.dueDate)}</TableCell>
                  <TableCell>{formatCurrency(i.amountDueMinor)}</TableCell>
                  {contract.contractType === 'DEVICE_LOAN' && (
                    <>
                      <TableCell>{formatCurrency(i.interestPortionMinor)}</TableCell>
                      <TableCell>{formatCurrency(i.principalPortionMinor)}</TableCell>
                    </>
                  )}
                  <TableCell>{formatCurrency(i.amountPaidMinor)}</TableCell>
                  <TableCell>
                    <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 ${getStatusColor(i.status)}`}>{i.status}</span>
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
                <TableHead>Date</TableHead><TableHead>Type</TableHead><TableHead>Channel</TableHead><TableHead>Amount</TableHead><TableHead>Receipt</TableHead><TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {contract.payments.map((p) => (
                <TableRow key={p.id}>
                  <TableCell className="text-gray-500">{formatDateTime(p.createdAt)}</TableCell>
                  <TableCell>{p.entryType}{p.reversesPaymentId && ' (reversal)'}</TableCell>
                  <TableCell>{p.channel}</TableCell>
                  <TableCell>{formatCurrency(p.amountMinor)}</TableCell>
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
                <TableRow><TableCell colSpan={6} className="text-center py-6 text-gray-400">No payments yet.</TableCell></TableRow>
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
