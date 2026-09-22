'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ClipboardCheck, ChevronRight } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { AccessDenied } from '@/components/AccessDenied';
import { useToast } from '@/hooks/useToast';
import { formatCurrency, formatDate, contractTypeLabel } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

interface PendingContract {
  id: string;
  contractNumber: string;
  contractType: string;
  totalPayableMinor: number | null;
  principalMinor: number | null;
  depositAmountMinor: number;
  submittedForApprovalAt: string | null;
  createdAt: string;
  createdBy: { firstName: string; lastName: string } | null;
  customer: { firstName: string; lastName: string; membershipId: string };
  product: { name: string } | null;
}

/**
 * The Agent module: every contract an AGENT has submitted, waiting for a
 * BRANCH_MANAGER/ADMIN/SUPER_ADMIN (contract.approve) to approve it or send
 * it back for revision. GET /api/contracts?status=PENDING_APPROVAL already
 * scopes to the approver's own branch (or all branches for an all-branch
 * user) — the same query the ordinary Contracts page uses, just filtered.
 */
export default function ContractApprovalsPage() {
  const canApprove = useAuthStore((s) => s.hasPermission('contract.approve'));
  const { toast } = useToast();
  const [contracts, setContracts] = useState<PendingContract[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [revisionTarget, setRevisionTarget] = useState<PendingContract | null>(null);
  const [reason, setReason] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const { contracts } = await api.get<{ contracts: PendingContract[] }>('/contracts?status=PENDING_APPROVAL');
      setContracts(contracts);
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to load approvals', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => { if (canApprove) load(); }, [load, canApprove]);

  async function approve(c: PendingContract) {
    setBusyId(c.id);
    try {
      await api.post(`/contracts/${c.id}/approve`);
      toast({ title: 'Contract approved', description: `${c.contractNumber} is now live.` });
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to approve contract', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  async function sendBackForRevision() {
    if (!revisionTarget || !reason.trim()) return;
    setBusyId(revisionTarget.id);
    try {
      await api.post(`/contracts/${revisionTarget.id}/request-revision`, { reason });
      toast({ title: 'Sent back for revision', description: `${revisionTarget.contractNumber} was returned to the agent.` });
      setRevisionTarget(null);
      setReason('');
      await load();
    } catch (e) {
      toast({ title: 'Error', description: e instanceof ApiError ? e.message : 'Failed to send back for revision', variant: 'destructive' });
    } finally {
      setBusyId(null);
    }
  }

  if (!canApprove) {
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Contract Approvals</h1>
          <p className="text-sm text-gray-500 mt-0.5">Agent-submitted contracts waiting for a decision</p>
        </div>
        <AccessDenied
          message="You don't have permission to approve contracts."
          hint="This page requires the contract.approve permission (Branch Managers, Admins and Super Admins)."
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Contract Approvals</h1>
        <p className="text-sm text-gray-500 mt-0.5">Agent-submitted contracts waiting for a decision</p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      ) : contracts.length === 0 ? (
        <Card>
          <CardContent className="text-center py-12 px-4">
            <ClipboardCheck className="h-8 w-8 text-gray-300 mx-auto mb-2" />
            <p className="text-gray-500">Nothing waiting for approval</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {contracts.map((c) => {
            const value = c.contractType === 'DEVICE_LOAN' ? c.principalMinor
              : c.contractType === 'SAVE_TO_OWN' ? null
              : c.totalPayableMinor;
            return (
              <Card key={c.id}>
                <CardContent className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <Link href={`/contracts/${c.id}`} className="flex-1 min-w-0 group">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-mono text-xs text-blue-700 group-hover:underline">{c.contractNumber}</span>
                      <Badge className="bg-amber-50 text-amber-700 ring-1 ring-amber-200/60">{contractTypeLabel(c.contractType)}</Badge>
                    </div>
                    <p className="text-sm font-medium text-gray-900 mt-1 truncate">
                      {c.customer.firstName} {c.customer.lastName} &middot; {c.customer.membershipId}
                    </p>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {c.product?.name && <>{c.product.name} &middot; </>}
                      Submitted by {c.createdBy ? `${c.createdBy.firstName} ${c.createdBy.lastName}` : 'an agent'} on {formatDate(c.submittedForApprovalAt ?? c.createdAt)}
                      {value !== null && <> &middot; {formatCurrency(value)}</>}
                    </p>
                  </Link>
                  <div className="flex gap-2 shrink-0">
                    <Button size="sm" variant="outline" disabled={busyId === c.id} onClick={() => { setRevisionTarget(c); setReason(''); }}>
                      Request revision
                    </Button>
                    <Button size="sm" disabled={busyId === c.id} onClick={() => approve(c)}>
                      {busyId === c.id ? 'Approving...' : 'Approve'}
                    </Button>
                    <Link href={`/contracts/${c.id}`} className="hidden sm:flex items-center text-gray-300">
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={!!revisionTarget} onOpenChange={(open) => !open && setRevisionTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send {revisionTarget?.contractNumber} back for revision</DialogTitle>
          </DialogHeader>
          <div>
            <Label htmlFor="revision-reason">Reason</Label>
            <Textarea
              id="revision-reason"
              className="mt-1.5"
              rows={4}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="What needs to change before this can be approved?"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevisionTarget(null)}>Cancel</Button>
            <Button disabled={!reason.trim() || busyId === revisionTarget?.id} onClick={sendBackForRevision}>
              {busyId === revisionTarget?.id ? 'Sending...' : 'Send back'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
