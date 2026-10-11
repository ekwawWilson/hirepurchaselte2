'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ShieldCheck } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { AccessDenied } from '@/components/AccessDenied';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDateTime, cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

interface Approval {
  id: string;
  kind: 'PAYMENT_REVERSAL' | 'CONTRACT_WRITEOFF' | 'CONTRACT_CANCEL';
  reason: string;
  status: string;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
  amountMinor: number | null;
  mine: boolean;
  payment: { channel: string; receiptNumber: string | null; receivedAt: string } | null;
  contract: { id: string; contractNumber: string; customer: { firstName: string; lastName: string } };
  requestedBy: { firstName: string; lastName: string };
  decidedBy: { firstName: string; lastName: string } | null;
}

const KIND: Record<Approval['kind'], { label: string; amount: string; done: string }> = {
  PAYMENT_REVERSAL: { label: 'Reverse a payment', amount: 'Payment', done: 'Payment reversed' },
  CONTRACT_WRITEOFF: { label: 'Write off a contract', amount: 'Still unpaid', done: 'Contract written off' },
  CONTRACT_CANCEL: { label: 'Cancel a contract', amount: 'Paid so far', done: 'Contract cancelled' },
};

/**
 * Reversals, write-offs and paid-up cancellations someone has asked for,
 * waiting on a different person to approve them (approvalService.ts). The
 * person who asked sees their own requests here too, but can only withdraw them.
 */
export default function ApprovalsPage() {
  const canDecide = useAuthStore((s) => s.hasPermission('payment.reverse', 'contract.writeoff', 'contract.cancel'));
  const { toast } = useToast();
  const [tab, setTab] = useState<'PENDING' | 'DECIDED'>('PENDING');
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectTarget, setRejectTarget] = useState<Approval | null>(null);
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      setApprovals((await api.get<{ approvals: Approval[] }>(`/approvals?status=${tab}`)).approvals);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not load approvals', variant: 'destructive' });
    }
  }, [tab, toast]);

  useEffect(() => { if (canDecide) void load(); }, [canDecide, load]);

  async function decide(approval: Approval, decision: 'APPROVE' | 'REJECT', decisionNote?: string) {
    setBusyId(approval.id);
    try {
      await api.post(`/approvals/${approval.id}`, { decision, note: decisionNote });
      toast({ title: decision === 'APPROVE' ? KIND[approval.kind].done : approval.mine ? 'Request withdrawn' : 'Request rejected' });
      setRejectTarget(null);
      setNote('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Could not record the decision', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  if (!canDecide) {
    return <AccessDenied message="You don't have permission to approve reversals, write-offs or cancellations." hint="This page is for people who can reverse payments, write off or cancel contracts." />;
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Second Approvals</h1>
        <p className="text-sm text-gray-500 mt-0.5">Reversals, write-offs and cancellations that need a second person before they happen</p>
      </div>

      <div className="flex gap-2">
        {(['PENDING', 'DECIDED'] as const).map((t) => (
          <button
            key={t} type="button" onClick={() => { setApprovals(null); setTab(t); }}
            className={cn('rounded-full px-3 py-1.5 text-xs font-semibold transition-colors',
              tab === t ? 'bg-primary text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200')}
          >
            {t === 'PENDING' ? 'Waiting' : 'Decided'}
          </button>
        ))}
      </div>

      {approvals === null ? (
        <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" /></div>
      ) : approvals.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 px-4">
            <ShieldCheck className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-gray-500">{tab === 'PENDING' ? 'Nothing waiting for approval' : 'Nothing decided yet'}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {approvals.map((a) => (
            <Card key={a.id}>
              <CardContent className="p-4 flex flex-col sm:flex-row sm:items-start gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge className="bg-amber-50 text-amber-700 ring-1 ring-amber-200/60">{KIND[a.kind].label}</Badge>
                    <Link href={`/contracts/${a.contract.id}`} className="font-mono text-xs text-blue-700 hover:underline">{a.contract.contractNumber}</Link>
                    {a.status !== 'PENDING' && (
                      <Badge variant={a.status === 'APPROVED' ? 'success' : 'secondary'}>{a.status === 'APPROVED' ? 'Approved' : 'Rejected'}</Badge>
                    )}
                  </div>
                  <p className="text-sm font-medium text-gray-900 mt-1">
                    {a.contract.customer.firstName} {a.contract.customer.lastName}
                    {a.amountMinor !== null && <span className="font-normal text-gray-500"> &middot; {KIND[a.kind].amount}: <strong className="text-gray-900">{formatCurrency(a.amountMinor)}</strong></span>}
                  </p>
                  {a.payment && (
                    <p className="text-xs text-gray-500 mt-0.5">
                      {a.payment.channel} payment{a.payment.receiptNumber ? ` ${a.payment.receiptNumber}` : ''}, received {formatDateTime(a.payment.receivedAt)}
                    </p>
                  )}
                  <p className="text-sm text-gray-700 mt-1.5">&ldquo;{a.reason}&rdquo;</p>
                  <p className="text-xs text-gray-500 mt-1">
                    Asked for by {a.mine ? 'you' : `${a.requestedBy.firstName} ${a.requestedBy.lastName}`} on {formatDateTime(a.createdAt)}
                    {a.decidedBy && a.decidedAt && <> &middot; {a.status === 'APPROVED' ? 'approved' : 'rejected'} by {a.decidedBy.firstName} {a.decidedBy.lastName} on {formatDateTime(a.decidedAt)}</>}
                  </p>
                  {a.decisionNote && <p className="text-xs text-gray-500 mt-0.5">Note: {a.decisionNote}</p>}
                </div>
                {a.status === 'PENDING' && (
                  <div className="flex gap-2 shrink-0">
                    {a.mine ? (
                      <>
                        <span className="self-center text-xs text-gray-500">Needs someone else</span>
                        <Button size="sm" variant="outline" disabled={busyId === a.id} onClick={() => decide(a, 'REJECT')}>Withdraw</Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" variant="outline" disabled={busyId === a.id} onClick={() => { setRejectTarget(a); setNote(''); }}>Reject</Button>
                        <Button size="sm" disabled={busyId === a.id} onClick={() => decide(a, 'APPROVE')}>
                          {busyId === a.id ? 'Working...' : 'Approve'}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!rejectTarget} onOpenChange={(open) => { if (!open) setRejectTarget(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reject this request</DialogTitle></DialogHeader>
          <div>
            <Label>Why?</Label>
            <Textarea className="mt-1.5" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. The receipt matches the cash book" />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectTarget(null)}>Back</Button>
            <Button variant="destructive" disabled={!note.trim() || busyId !== null} onClick={() => rejectTarget && decide(rejectTarget, 'REJECT', note)}>Reject</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
