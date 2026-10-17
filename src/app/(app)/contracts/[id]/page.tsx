'use client';

import Link from 'next/link';
import { FileText, FileSignature } from 'lucide-react';
import { useEffect, useState, use } from 'react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { unitTitle } from '@/lib/unitLabel';
import { RescheduleDialog } from '@/components/RescheduleDialog';
import { RecordRefundDialog } from '@/components/RecordRefundDialog';
import { ContractFollowUps } from '@/components/ContractFollowUps';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDate, formatDateTime, getStatusColor, contractTypeLabel } from '@/lib/utils';
import { MOBILE_MONEY_NETWORKS, MOBILE_MONEY_NETWORK_LABELS } from '@/lib/constants/contracts';
import { networkForPhone } from '@/lib/constants/customers';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AccessDenied } from '@/components/AccessDenied';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog';

interface Instalment { id: string; instalmentNo: number; dueDate: string; amountDueMinor: number; principalPortionMinor: number; interestPortionMinor: number; amountPaidMinor: number; status: string; daysPastDue?: number }
interface Payment { id: string; entryType: string; amountMinor: number; channel: string; status: string; receiptNumber: string | null; notes: string | null; reversesPaymentId: string | null; reversedById: string | null; createdAt: string }
interface PendingApproval { id: string; kind: string; targetId: string; reason: string; createdAt: string; requestedBy: { firstName: string; lastName: string } }
interface Preapproval { id: string; status: string; network: string; customerMsisdn: string; verificationType: string | null; otpPrefix: string | null }
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
  inventoryItem: { serialNumber: string; name: string | null; description: string | null } | null;
  instalments: Instalment[];
  payments: Payment[];
  // Reversals, write-offs or a cancellation asked for and not yet approved by a second person.
  approvalRequests: PendingApproval[];
  hubtelPreapprovalId: string | null;
  hubtelPreapproval: Preapproval | null;
  // The number/network asked for at creation — kept so a request that failed
  // then can be retried from here without retyping them.
  pendingDirectDebitNetwork: string | null;
  pendingDirectDebitMsisdn: string | null;
  paymentMethod: string;
  // The Agent module (schema.prisma's Contract comment) — null on every
  // contract not created by an agent.
  createdById: string;
  revisionReason: string | null;
  termWeeks: number | null;
  // What cancelling left owed back to the customer, and what was recorded as handed over.
  refundDueMinor: number | null; refundedMinor: number | null; refundedAt: string | null; refundNote: string | null;
  gracePeriodDays: number;
  penaltyRateBps: number;
}

// DEVICE_LOAN's self-directed two-option payment model has no "auto-charge the
// due amount" equivalent, so it's no longer direct-debit eligible (constants/contracts.ts).
const DIRECT_DEBIT_ELIGIBLE_TYPES = ['DEPOSIT_INSTALMENT'];
const DIRECT_DEBIT_NETWORKS = ['MTN', 'VODAFONE', 'TELECEL'];

export default function ContractDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { hasPermission, user } = useAuthStore();
  const canView = hasPermission('contract.view');
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
  const [otpCode, setOtpCode] = useState('');
  const [otpSubmitting, setOtpSubmitting] = useState(false);
  // Mobile money prompt (Hubtel Receive Money) sent from the counter.
  const [momoMsisdn, setMomoMsisdn] = useState('');
  const [momoNetwork, setMomoNetwork] = useState('');
  const [momoAmount, setMomoAmount] = useState('');
  const [momoWaiting, setMomoWaiting] = useState(false);
  const [mandateBusy, setMandateBusy] = useState<'status' | 'cancel' | 'reactivate' | null>(null);
  const [revokeOpen, setRevokeOpen] = useState(false);

  // The Agent module.
  const [approving, setApproving] = useState(false);
  const [revisionDialogOpen, setRevisionDialogOpen] = useState(false);
  const [revisionReasonInput, setRevisionReasonInput] = useState('');
  const [revisionSaving, setRevisionSaving] = useState(false);
  const [resubmitDialogOpen, setResubmitDialogOpen] = useState(false);
  const [resubmitForm, setResubmitForm] = useState({
    totalPayable: '', deposit: '', termWeeks: '', paymentFrequency: 'WEEKLY', gracePeriodDays: '', penaltyRateBps: '', loanAmount: '',
  });
  const [resubmitSaving, setResubmitSaving] = useState(false);
  const [rescheduleOpen, setRescheduleOpen] = useState(false);
  const [refundOpen, setRefundOpen] = useState(false);

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
      setDdMsisdn((prev) => prev || contract.pendingDirectDebitMsisdn || contract.customer.phone || contract.customer.phone2 || contract.customer.phone3 || '');
      if (contract.pendingDirectDebitNetwork) setDdNetwork(contract.pendingDirectDebitNetwork);
      const firstNumber = contract.customer.phone || contract.customer.phone2 || contract.customer.phone3 || '';
      setMomoMsisdn((prev) => prev || firstNumber);
      setMomoNetwork((prev) => prev || networkForPhone(firstNumber) || '');
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load contract', variant: 'destructive' });
    }
  }

  useEffect(() => {
    if (!canView) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, canView]);

  // The Agent module.
  function openResubmitDialog() {
    if (!contract) return;
    setResubmitForm({
      totalPayable: contract.totalPayableMinor !== null ? (contract.totalPayableMinor / 100).toString() : '',
      deposit: (contract.depositAmountMinor / 100).toString(),
      termWeeks: contract.termWeeks?.toString() ?? '',
      paymentFrequency: contract.paymentFrequency,
      gracePeriodDays: contract.gracePeriodDays.toString(),
      penaltyRateBps: contract.penaltyRateBps.toString(),
      loanAmount: contract.principalMinor !== null ? (contract.principalMinor / 100).toString() : '',
    });
    setResubmitDialogOpen(true);
  }

  async function approveContractNow() {
    setApproving(true);
    try {
      await api.post(`/contracts/${id}/approve`);
      toast({ title: 'Contract approved' });
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to approve contract', variant: 'destructive' });
    } finally {
      setApproving(false);
    }
  }

  async function requestRevisionNow() {
    if (!revisionReasonInput.trim()) return;
    setRevisionSaving(true);
    try {
      await api.post(`/contracts/${id}/request-revision`, { reason: revisionReasonInput });
      toast({ title: 'Sent back for revision' });
      setRevisionDialogOpen(false);
      setRevisionReasonInput('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to send back for revision', variant: 'destructive' });
    } finally {
      setRevisionSaving(false);
    }
  }

  async function resubmitNow() {
    if (!contract) return;
    setResubmitSaving(true);
    try {
      const body: Record<string, unknown> = {};
      if (contract.contractType === 'DEPOSIT_INSTALMENT') {
        body.totalPayableMinor = Math.round(parseFloat(resubmitForm.totalPayable) * 100);
        body.depositAmountMinor = Math.round(parseFloat(resubmitForm.deposit) * 100);
        body.termWeeks = parseInt(resubmitForm.termWeeks, 10);
        body.paymentFrequency = resubmitForm.paymentFrequency;
        body.gracePeriodDays = parseInt(resubmitForm.gracePeriodDays, 10);
        body.penaltyRateBps = parseInt(resubmitForm.penaltyRateBps, 10);
      } else if (contract.contractType === 'DEVICE_LOAN') {
        body.loanAmountMinor = Math.round(parseFloat(resubmitForm.loanAmount) * 100);
      }
      await api.post(`/contracts/${id}/resubmit`, body);
      toast({ title: 'Resubmitted for approval' });
      setResubmitDialogOpen(false);
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to resubmit', variant: 'destructive' });
    } finally {
      setResubmitSaving(false);
    }
  }

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
      const res = await api.post<{ pendingApproval?: boolean }>(`/payments/${reverseTarget.id}/reverse`, { reason: reverseReason });
      toast(res.pendingApproval
        ? { title: 'Sent for approval', description: 'A second person must approve this reversal before it happens.' }
        : { title: 'Payment reversed' });
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
      const res = await api.post<{ pendingApproval?: boolean; contract?: ContractDetail & { refundDueMinor?: number } }>(
        `/contracts/${id}/${confirmAction}`,
        confirmAction === 'release' ? undefined : { reason: actionReason },
      );
      if (res.pendingApproval) {
        toast({ title: 'Sent for approval', description: `A second person must approve this ${confirmAction === 'writeoff' ? 'write-off' : 'cancellation'} before it happens.` });
      } else {
        const refundDue = confirmAction === 'cancel' ? res.contract?.refundDueMinor ?? 0 : 0;
        toast({
          title: `Contract ${confirmAction === 'writeoff' ? 'written off' : confirmAction === 'release' ? 'released' : 'cancelled'}`,
          description: refundDue > 0 ? `${formatCurrency(refundDue)} already paid — refund to the customer` : undefined,
        });
      }
      setConfirmAction(null);
      setActionReason('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : `Failed to ${confirmAction} contract`, variant: 'destructive' });
    }
  }

  /** What staff do next for a mandate Hubtel has just left pending — the two ways it gets approved. */
  function pendingMandateHint(verificationType: string | null) {
    return verificationType === 'OTP'
      ? 'Hubtel texted the customer an OTP instead of sending a USSD prompt. Enter it below once they read it out.'
      : 'The customer must confirm on their phone via a USSD prompt before this can be charged.';
  }

  async function requestMandate(msisdn: string, network: string, mode: 'DIRECT_DEBIT' | 'BOTH') {
    setDdSaving(true);
    try {
      const res = await api.post<{ reused: boolean; preapproval: { status: string; verificationType: string | null } }>(
        `/contracts/${id}/direct-debit`, { msisdn, network, paymentMethod: mode },
      );
      const pending = res.preapproval.status === 'PENDING';
      toast({
        title: res.reused ? 'Existing mandate reused' : pending ? 'Awaiting customer approval' : 'Direct debit mandate approved',
        description: pending ? pendingMandateHint(res.preapproval.verificationType) : undefined,
      });
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to set up direct debit', variant: 'destructive' });
    } finally {
      setDdSaving(false);
    }
  }

  function setupDirectDebit(e: React.FormEvent) {
    e.preventDefault();
    void requestMandate(ddMsisdn, ddNetwork, ddMode);
  }

  async function mandateAction(action: 'status' | 'cancel' | 'reactivate') {
    setMandateBusy(action);
    try {
      const { preapproval } = await api.post<{ preapproval: Preapproval }>(`/contracts/${id}/direct-debit/${action}`);
      if (action === 'cancel') {
        toast({ title: 'Mandate revoked', description: 'Hubtel will no longer debit this number for this business.' });
      } else if (preapproval.status === 'APPROVED') {
        toast({ title: action === 'reactivate' ? 'Mandate reactivated' : 'Mandate approved' });
      } else if (preapproval.status === 'PENDING') {
        toast({
          title: action === 'reactivate' ? 'Awaiting customer approval' : 'Still waiting on the customer',
          description: pendingMandateHint(preapproval.verificationType),
        });
      } else {
        toast({ title: 'Mandate was not approved', description: 'The customer declined the request, or it expired.', variant: 'destructive' });
      }
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not reach Hubtel', variant: 'destructive' });
    } finally {
      setMandateBusy(null);
    }
  }

  async function submitOtp(e: React.FormEvent) {
    e.preventDefault();
    setOtpSubmitting(true);
    try {
      await api.post(`/contracts/${id}/direct-debit/verify-otp`, { otpCode });
      toast({ title: 'OTP accepted', description: 'Waiting on Hubtel to confirm the mandate.' });
      setOtpCode('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to verify OTP', variant: 'destructive' });
    } finally {
      setOtpSubmitting(false);
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

  /**
   * Sends the customer a mobile money prompt and waits for them to approve it
   * on their phone. Mock mode settles at once; a live charge is only final
   * when Hubtel calls back, so this polls until it is.
   */
  async function sendMomoPrompt(e: React.FormEvent) {
    e.preventDefault();
    const amountMinor = Math.round(parseFloat(momoAmount) * 100);
    setMomoWaiting(true);
    try {
      const { reference } = await api.post<{ reference: string; status: string }>(
        `/contracts/${id}/mobile-money`, { amountMinor, msisdn: momoMsisdn, ...(momoNetwork && { network: momoNetwork }) },
      );
      for (let attempt = 0; attempt < 40; attempt++) { // ~2 minutes, about as long as a customer takes at the counter
        const status = await api.get<{ status: string; recorded: boolean }>(`/contracts/${id}/mobile-money/${reference}`);
        if (status.status === 'SUCCESS' || status.status === 'NEEDS_REVIEW') {
          toast({
            title: 'Payment received',
            description: status.recorded ? formatCurrency(amountMinor) : `${formatCurrency(amountMinor)} was collected but could not be applied automatically — it needs review.`,
          });
          setMomoAmount('');
          await load();
          return;
        }
        if (status.status === 'FAILED') {
          toast({ title: 'Payment not completed', description: 'The customer did not approve the prompt, or their wallet declined it.', variant: 'destructive' });
          return;
        }
        await new Promise((r) => setTimeout(r, 3000));
      }
      toast({ title: 'Still waiting on the customer', description: 'No confirmation yet. If they approve later, the payment is recorded automatically.' });
    } catch (e) {
      toast({ title: 'Prompt not sent', description: e instanceof ApiError ? e.message : 'Could not reach the server', variant: 'destructive' });
    } finally {
      setMomoWaiting(false);
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

  if (!canView) {
    return (
      <div className="max-w-4xl space-y-6">
        <AccessDenied
          message="You don't have permission to view contracts."
          hint="Ask an administrator for the contract.view permission."
        />
      </div>
    );
  }

  if (!contract) {
    return <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>;
  }

  const canPay = hasPermission('payment.cash.record');
  // Mirrors the routes: setting a mandate up, taking it off or revoking it is
  // contract.reschedule; seeing an approval through (the OTP, a status check)
  // is also open to whoever can create a contract, since they are the one at
  // the counter with the customer when Hubtel asks for it.
  const canManageMandate = hasPermission('contract.reschedule');
  const canVerifyMandate = hasPermission('contract.reschedule', 'contract.create');
  const canReverse = hasPermission('payment.reverse');
  const canCancel = hasPermission('contract.cancel');
  const canWriteOff = hasPermission('contract.writeoff');
  const canRelease = hasPermission('inventory.issue');
  const canApprove = hasPermission('contract.approve');
  const canRecordRefund = hasPermission('payment.reverse', 'contract.cancel');
  const canLogContact = hasPermission('customer.create', 'payment.cash.record');
  const scheduleOutstandingMinor = contract.instalments.reduce((s, i) => s + Math.max(0, i.amountDueMinor - i.amountPaidMinor), 0);
  const canReschedule = canManageMandate && contract.contractType === 'DEPOSIT_INSTALMENT'
    && ['ACTIVE', 'DEFAULTED'].includes(contract.status) && scheduleOutstandingMinor > 0;
  const inArrears = contract.status === 'DEFAULTED' || contract.instalments.some((i) => i.status === 'OVERDUE');
  const terminal = ['COMPLETED', 'RELEASED', 'CANCELLED', 'WRITTEN_OFF'].includes(contract.status);
  // The Agent module: nothing has been agreed yet on either of these two
  // statuses, so no money can move and no mandate can be requested — see
  // PRE_APPROVAL_STATUSES/schema.prisma's Contract comment. Cancel/write-off
  // stay available throughout (contractService.ts) — they double as an
  // approver's outright reject.
  const preApproval = ['PENDING_APPROVAL', 'REVISION_REQUESTED'].includes(contract.status);
  const isOwnSubmission = user?.id === contract.createdById;

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{contract.contractNumber}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            {contract.customer.firstName} {contract.customer.lastName} &middot; {contract.customer.phone ?? contract.customer.phone2 ?? contract.customer.phone3}
            {contract.product && <> &middot; {unitTitle(contract.product.name, contract.inventoryItem?.name)}</>} &middot; {contractTypeLabel(contract.contractType)}
            {contract.contractType !== 'SAVE_TO_OWN' && <> &middot; {contract.paymentFrequency.charAt(0) + contract.paymentFrequency.slice(1).toLowerCase()}</>}
          </p>
          {contract.inventoryItem && (
            <p className="text-xs text-gray-500 mt-0.5">
              {contract.inventoryItem.description && <>{contract.inventoryItem.description} &middot; </>}
              <span className="font-mono">{contract.inventoryItem.serialNumber}</span>
            </p>
          )}
        </div>
        <span className={`text-[11px] font-semibold uppercase tracking-wide px-3 py-1.5 rounded-full ${getStatusColor(contract.status)}`}>{contract.status}</span>
      </div>

      {!preApproval && (
        <div className="flex flex-wrap gap-2">
          <Link href={`/contracts/${contract.id}/statement`} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
            <FileText className="h-3.5 w-3.5" /> Statement
          </Link>
          <Link href={`/contracts/${contract.id}/agreement`} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
            <FileSignature className="h-3.5 w-3.5" /> Agreement
          </Link>
        </div>
      )}

      {contract.status === 'CANCELLED' && !!contract.refundDueMinor && (
        <Card className={contract.refundedAt ? undefined : 'border-red-200 bg-red-50/60'}>
          <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <p className={`flex-1 text-sm ${contract.refundedAt ? 'text-gray-600' : 'text-red-800'}`}>
              {contract.refundedAt ? (
                <>
                  <strong>{formatCurrency(contract.refundedMinor ?? 0)}</strong> of the {formatCurrency(contract.refundDueMinor)} paid in was handed back on {formatDate(contract.refundedAt)}.
                  {contract.refundNote && <> {contract.refundNote}</>}
                </>
              ) : (
                <>The customer had paid <strong>{formatCurrency(contract.refundDueMinor)}</strong> when this contract was cancelled. Nothing has been recorded as handed back yet.</>
              )}
            </p>
            {!contract.refundedAt && canRecordRefund && <Button size="sm" className="shrink-0" onClick={() => setRefundOpen(true)}>Record refund</Button>}
          </CardContent>
        </Card>
      )}

      {contract.approvalRequests.length > 0 && (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 text-sm text-amber-800 space-y-1">
              {contract.approvalRequests.map((a) => (
                <p key={a.id}>
                  <strong>{a.kind === 'PAYMENT_REVERSAL' ? 'A payment reversal' : a.kind === 'CONTRACT_WRITEOFF' ? 'A write-off' : 'A cancellation'}</strong>{' '}
                  asked for by {a.requestedBy.firstName} {a.requestedBy.lastName} is waiting for a second person to approve it: &ldquo;{a.reason}&rdquo;
                </p>
              ))}
            </div>
            <Link href="/approvals" className="shrink-0 text-sm font-medium text-amber-900 underline">Open approvals</Link>
          </CardContent>
        </Card>
      )}

      {/* The Agent module: this contract still needs a decision, or was sent back for one. */}
      {contract.status === 'PENDING_APPROVAL' && (
        <Card className="border-amber-200 bg-amber-50/60">
          <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="flex-1 text-sm text-amber-800">
              {canApprove
                ? 'This contract was submitted by an agent and is waiting for your decision.'
                : 'Submitted for approval — waiting for a manager or admin to review it.'}
            </p>
            {canApprove && (
              <div className="flex gap-2 shrink-0">
                <Button size="sm" variant="outline" disabled={approving} onClick={() => { setRevisionDialogOpen(true); setRevisionReasonInput(''); }}>
                  Request revision
                </Button>
                <Button size="sm" disabled={approving} onClick={approveContractNow}>{approving ? 'Approving...' : 'Approve'}</Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {contract.status === 'REVISION_REQUESTED' && (
        <Card className="border-orange-200 bg-orange-50/60">
          <CardContent className="p-4 space-y-3">
            <div>
              <p className="text-sm font-semibold text-orange-800">Sent back for revision</p>
              <p className="text-sm text-orange-700 mt-0.5">{contract.revisionReason}</p>
            </div>
            {isOwnSubmission && hasPermission('contract.create') && (
              <Button size="sm" onClick={openResubmitDialog}>Edit terms &amp; resubmit</Button>
            )}
          </CardContent>
        </Card>
      )}

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

      {canPay && !terminal && !preApproval && contract.contractType === 'DEVICE_LOAN' && (
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

      {canPay && !terminal && !preApproval && contract.contractType !== 'DEVICE_LOAN' && (
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

      {canPay && !terminal && !preApproval && (() => {
        const numbers = [contract.customer.phone, contract.customer.phone2, contract.customer.phone3].filter((p): p is string => !!p);
        const loan = contract.contractType === 'DEVICE_LOAN' ? contract.deviceLoanState : null;
        return (
          <Card>
            <CardHeader><CardTitle>Mobile money prompt</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {numbers.length === 0 ? (
                <p className="text-sm text-gray-500">This customer has no phone number on file to send a prompt to.</p>
              ) : (
                <form className="flex flex-wrap items-end gap-3" onSubmit={sendMomoPrompt}>
                  <div>
                    <Label>Customer&apos;s number</Label>
                    <select
                      className="mt-1.5 flex h-10 border border-input bg-white/90 px-3 py-2 text-sm"
                      value={momoMsisdn}
                      onChange={(e) => { setMomoMsisdn(e.target.value); setMomoNetwork(networkForPhone(e.target.value) || ''); }}
                      disabled={momoWaiting}
                    >
                      {numbers.map((n) => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  <div>
                    <Label>Network</Label>
                    <select
                      required
                      className="mt-1.5 flex h-10 border border-input bg-white/90 px-3 py-2 text-sm"
                      value={momoNetwork}
                      onChange={(e) => setMomoNetwork(e.target.value)}
                      disabled={momoWaiting}
                    >
                      {!momoNetwork && <option value="">Choose…</option>}
                      {MOBILE_MONEY_NETWORKS.map((n) => <option key={n} value={n}>{MOBILE_MONEY_NETWORK_LABELS[n]}</option>)}
                    </select>
                  </div>
                  <div>
                    <Label>Amount (GHS)</Label>
                    <Input
                      required type="number" step="0.01" min="0.01" className="mt-1.5 w-36"
                      value={momoAmount} onChange={(e) => setMomoAmount(e.target.value)} disabled={momoWaiting}
                    />
                  </div>
                  <Button type="submit" disabled={momoWaiting}>{momoWaiting ? 'Waiting for approval...' : 'Send prompt'}</Button>
                </form>
              )}
              {loan && (
                <p className="text-xs text-gray-500">
                  A device loan takes one of two amounts:{' '}
                  {loan.accruedInterestMinor > 0 && (
                    <button type="button" className="text-primary hover:underline" onClick={() => setMomoAmount((loan.accruedInterestMinor / 100).toFixed(2))}>
                      interest owed ({formatCurrency(loan.accruedInterestMinor)})
                    </button>
                  )}
                  {loan.accruedInterestMinor > 0 && loan.principalOutstanding && ' or '}
                  {loan.principalOutstanding && (
                    <button type="button" className="text-primary hover:underline" onClick={() => setMomoAmount((loan.principalMinor / 100).toFixed(2))}>
                      the full loan ({formatCurrency(loan.principalMinor)})
                    </button>
                  )}
                  .
                </p>
              )}
              <p className="text-xs text-gray-400">
                {momoWaiting
                  ? 'Ask the customer to approve the prompt on their phone with their mobile money PIN. The payment is recorded as soon as they do.'
                  : 'Sends a payment request to the customer\'s phone; they approve it with their mobile money PIN. Only numbers registered to this customer can be prompted.'}
              </p>
            </CardContent>
          </Card>
        );
      })()}

      {DIRECT_DEBIT_ELIGIBLE_TYPES.includes(contract.contractType) && !terminal && !preApproval && (
        <Card>
          <CardHeader><CardTitle>Direct debit</CardTitle></CardHeader>
          <CardContent>
            {contract.hubtelPreapproval ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className={`text-[11px] font-semibold uppercase tracking-wide px-2.5 py-1 rounded-full ${getStatusColor(contract.hubtelPreapproval.status)}`}>
                    {contract.hubtelPreapproval.status}
                  </span>
                  <span className="text-sm text-gray-600">{contract.hubtelPreapproval.customerMsisdn} &middot; {contract.hubtelPreapproval.network}</span>
                  {contract.hubtelPreapproval.status === 'PENDING' && contract.hubtelPreapproval.verificationType && (
                    <span className="text-xs text-gray-400">
                      {contract.hubtelPreapproval.verificationType === 'OTP' ? 'Approval by OTP' : 'Approval by USSD prompt'}
                    </span>
                  )}
                </div>
                {contract.hubtelPreapproval.status === 'PENDING' && (
                  contract.hubtelPreapproval.verificationType === 'OTP' ? (
                    <div className="space-y-2">
                      <p className="text-xs text-amber-600">
                        Hubtel texted the customer a code instead of sending a USSD prompt — it does this when the
                        number already has a mandate with another business. Ask them to read it out and enter it
                        below.
                      </p>
                      {canVerifyMandate && (
                        <form className="flex items-end gap-3" onSubmit={submitOtp}>
                          <div>
                            <Label>OTP code</Label>
                            <div className="mt-1.5 flex items-center gap-2">
                              {contract.hubtelPreapproval.otpPrefix && (
                                <span className="text-sm font-mono text-gray-400">{contract.hubtelPreapproval.otpPrefix}-</span>
                              )}
                              <Input
                                required
                                className="w-24"
                                inputMode="numeric"
                                pattern="\d{4}"
                                maxLength={4}
                                placeholder="0000"
                                value={otpCode}
                                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, '').slice(0, 4))}
                              />
                            </div>
                          </div>
                          <Button type="submit" disabled={otpSubmitting || otpCode.length !== 4}>
                            {otpSubmitting ? 'Verifying...' : 'Verify OTP'}
                          </Button>
                        </form>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-gray-500">
                      Waiting on the customer to approve on their phone — a USSD prompt, or *170# &rarr; My Wallet
                      &rarr; My Approvals &rarr; PreApprovals if they missed it.
                    </p>
                  )
                )}
                {contract.hubtelPreapproval.status === 'FAILED' && (
                  <p className="text-xs text-red-600">
                    The customer declined this request, or it expired before they approved it. Nothing can be charged
                    until a new request is approved.
                  </p>
                )}
                {contract.hubtelPreapproval.status === 'CANCELLED' && (
                  <p className="text-xs text-gray-500">
                    This mandate was cancelled, so nothing can be charged. Reactivating it asks the customer to approve
                    again.
                  </p>
                )}
                {contract.status === 'PENDING_DEPOSIT' && ['PENDING', 'APPROVED'].includes(contract.hubtelPreapproval.status) && (
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
                  </form>
                )}
                <div className="flex flex-wrap items-center gap-2">
                  {canVerifyMandate && contract.hubtelPreapproval.status === 'PENDING' && (
                    <Button type="button" variant="outline" size="sm" disabled={mandateBusy !== null} onClick={() => mandateAction('status')}>
                      {mandateBusy === 'status' ? 'Checking...' : 'Check status'}
                    </Button>
                  )}
                  {canManageMandate && contract.hubtelPreapproval.status === 'FAILED' && (
                    <Button
                      type="button" size="sm" disabled={ddSaving}
                      onClick={() => requestMandate(
                        contract.hubtelPreapproval!.customerMsisdn, contract.hubtelPreapproval!.network,
                        contract.paymentMethod === 'BOTH' ? 'BOTH' : 'DIRECT_DEBIT',
                      )}
                    >
                      {ddSaving ? 'Requesting...' : 'Request again'}
                    </Button>
                  )}
                  {canManageMandate && contract.hubtelPreapproval.status === 'CANCELLED' && (
                    <Button type="button" size="sm" disabled={mandateBusy !== null} onClick={() => mandateAction('reactivate')}>
                      {mandateBusy === 'reactivate' ? 'Reactivating...' : 'Reactivate'}
                    </Button>
                  )}
                  {canManageMandate && (
                    <Button type="button" variant="outline" size="sm" onClick={disableDirectDebit}>Disable</Button>
                  )}
                  {canManageMandate && ['PENDING', 'APPROVED'].includes(contract.hubtelPreapproval.status) && (
                    <Button type="button" variant="outline" size="sm" disabled={mandateBusy !== null} onClick={() => setRevokeOpen(true)}>
                      {mandateBusy === 'cancel' ? 'Revoking...' : 'Revoke mandate'}
                    </Button>
                  )}
                </div>
                {contract.status === 'ACTIVE' && contract.hubtelPreapproval.status === 'APPROVED' && (
                  <p className="text-xs text-gray-400">
                    {contract.paymentMethod === 'BOTH'
                      ? 'Customer can pay cash/USSD themselves — direct debit only charges once an instalment goes overdue (they defaulted on paying it).'
                      : 'The mandate is charged automatically the moment each instalment is due.'}
                    {' '}&quot;Charge now&quot; is only for an out-of-cycle collection.
                  </p>
                )}
              </div>
            ) : !canManageMandate ? (
              <p className="text-sm text-gray-500">No direct debit on this contract. A manager can set it up.</p>
            ) : contract.status === 'ACTIVE' || contract.status === 'PENDING_DEPOSIT' ? (
              <div className="space-y-2">
                <form className="flex flex-wrap items-end gap-3" onSubmit={setupDirectDebit}>
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
                  <Button type="submit" disabled={ddSaving}>{ddSaving ? 'Requesting...' : 'Set up direct debit'}</Button>
                </form>
                <p className="text-xs text-gray-400">
                  Hubtel asks the customer to approve once — by a USSD prompt on their phone, or by an OTP you enter
                  here if their number already has a mandate with another business.
                  {contract.status === 'PENDING_DEPOSIT' && ' Nothing is charged until the deposit clears.'}
                </p>
              </div>
            ) : (
              <p className="text-sm text-gray-500">Direct debit can only be set up while the contract is active.</p>
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

      {contract.contractType !== 'SAVE_TO_OWN' && !preApproval && (
        <ContractFollowUps
          contractId={contract.id} contractNumber={contract.contractNumber} inArrears={inArrears} canLog={canLogContact}
          customerName={`${contract.customer.firstName} ${contract.customer.lastName}`}
        />
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
                  <TableCell className="font-mono text-xs">
                    {p.status === 'SUCCESS' && !p.reversesPaymentId
                      ? <Link href={`/contracts/${contract.id}/receipt/${p.id}`} className="text-blue-700 hover:underline">{p.receiptNumber ?? 'Receipt'}</Link>
                      : p.receiptNumber ?? '—'}
                  </TableCell>
                  <TableCell>
                    {contract.approvalRequests.some((a) => a.kind === 'PAYMENT_REVERSAL' && a.targetId === p.id)
                      ? <span className="text-xs text-amber-700">Reversal awaiting approval</span>
                      : canReverse && !p.reversesPaymentId && !p.reversedById && (
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

      {(canCancel || canWriteOff || canRelease || canReschedule) && !terminal && (
        <Card>
          <CardHeader><CardTitle>Actions</CardTitle></CardHeader>
          <CardContent className="flex flex-wrap gap-3">
            {canReschedule && (
              <Button variant="outline" onClick={() => setRescheduleOpen(true)}>Reschedule</Button>
            )}
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

      <RescheduleDialog
        open={rescheduleOpen} contractId={contract.id} outstandingMinor={scheduleOutstandingMinor}
        onClose={() => setRescheduleOpen(false)} onSaved={() => { setRescheduleOpen(false); void load(); }}
      />
      <RecordRefundDialog
        target={refundOpen ? { id: contract.id, contractNumber: contract.contractNumber, refundDueMinor: contract.refundDueMinor ?? 0 } : null}
        onClose={() => setRefundOpen(false)} onSaved={() => { setRefundOpen(false); void load(); }}
      />

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

      <AlertDialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this direct debit mandate?</AlertDialogTitle>
            <AlertDialogDescription>
              Hubtel will stop this business debiting {contract.hubtelPreapproval?.customerMsisdn} at all — for this
              contract and any other of the customer&apos;s contracts using the same number. The customer has to
              approve again before it can be charged. To stop direct debit on this contract only, use Disable.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction onClick={() => mandateAction('cancel')}>Revoke mandate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The Agent module: send back for revision */}
      <Dialog open={revisionDialogOpen} onOpenChange={setRevisionDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Send back for revision</DialogTitle></DialogHeader>
          <div>
            <Label>Reason</Label>
            <Input className="mt-1.5" value={revisionReasonInput} onChange={(e) => setRevisionReasonInput(e.target.value)} placeholder="What needs to change?" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevisionDialogOpen(false)}>Cancel</Button>
            <Button disabled={!revisionReasonInput.trim() || revisionSaving} onClick={requestRevisionNow}>
              {revisionSaving ? 'Sending...' : 'Send back'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* The Agent module: edit terms and resubmit */}
      <Dialog open={resubmitDialogOpen} onOpenChange={setResubmitDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Edit terms &amp; resubmit</DialogTitle></DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            {contract.contractType === 'DEPOSIT_INSTALMENT' && (
              <>
                <div>
                  <Label>Total price (GHS)</Label>
                  <Input type="number" min="0" step="0.01" className="mt-1.5" value={resubmitForm.totalPayable}
                    onChange={(e) => setResubmitForm({ ...resubmitForm, totalPayable: e.target.value })} />
                </div>
                <div>
                  <Label>Deposit (GHS)</Label>
                  <Input type="number" min="0" step="0.01" className="mt-1.5" value={resubmitForm.deposit}
                    onChange={(e) => setResubmitForm({ ...resubmitForm, deposit: e.target.value })} />
                </div>
                <div>
                  <Label>Term (weeks)</Label>
                  <Input type="number" min="1" max="24" step="1" className="mt-1.5" value={resubmitForm.termWeeks}
                    onChange={(e) => setResubmitForm({ ...resubmitForm, termWeeks: e.target.value })} />
                </div>
                <div>
                  <Label>Frequency</Label>
                  <select
                    className="mt-1.5 flex h-10 w-full rounded-xl border border-input bg-white/90 px-3 text-sm"
                    value={resubmitForm.paymentFrequency}
                    onChange={(e) => setResubmitForm({ ...resubmitForm, paymentFrequency: e.target.value })}
                  >
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                  </select>
                </div>
                <div>
                  <Label>Grace period (days)</Label>
                  <Input type="number" min="0" step="1" className="mt-1.5" value={resubmitForm.gracePeriodDays}
                    onChange={(e) => setResubmitForm({ ...resubmitForm, gracePeriodDays: e.target.value })} />
                </div>
                <div>
                  <Label>Penalty rate (bps)</Label>
                  <Input type="number" min="0" step="1" className="mt-1.5" value={resubmitForm.penaltyRateBps}
                    onChange={(e) => setResubmitForm({ ...resubmitForm, penaltyRateBps: e.target.value })} />
                </div>
              </>
            )}
            {contract.contractType === 'DEVICE_LOAN' && (
              <div className="col-span-2">
                <Label>Loan amount (GHS)</Label>
                <Input type="number" min="0" step="0.01" className="mt-1.5" value={resubmitForm.loanAmount}
                  onChange={(e) => setResubmitForm({ ...resubmitForm, loanAmount: e.target.value })} />
              </div>
            )}
            {contract.contractType === 'SAVE_TO_OWN' && (
              <p className="col-span-2 text-sm text-gray-500">Save to Own has no terms to edit — resubmit as-is for another look.</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResubmitDialogOpen(false)}>Cancel</Button>
            <Button disabled={resubmitSaving} onClick={resubmitNow}>{resubmitSaving ? 'Resubmitting...' : 'Resubmit for approval'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
