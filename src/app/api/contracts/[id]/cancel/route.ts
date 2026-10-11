import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { cancelContract, cancelProblem, ContractError } from '@/lib/services/contractService';
import { requestApproval, secondApprovalRequired, ApprovalError } from '@/lib/services/approvalService';
import { logAudit } from '@/lib/services/auditService';

/**
 * Cancels a contract. One that money has been paid on unwinds or refunds
 * those payments, so with the second-approval control on it is only filed
 * for a different person to approve (202, nothing cancelled yet).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.cancel');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { reason } = (await req.json()) as { reason?: string };
  if (!reason?.trim()) return NextResponse.json({ error: 'reason is required' }, { status: 400 });

  const existing = await prisma.contract.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, existing.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    if (existing.totalPaidMinor > 0 && await secondApprovalRequired()) {
      const problem = cancelProblem(existing);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      const approval = await requestApproval({
        kind: 'CONTRACT_CANCEL', targetId: id, contractId: id, branchId: existing.branchId,
        reason: reason.trim(), requestedById: auth.user.id,
      });
      await logAudit({ userId: auth.user.id, action: 'CONTRACT_CANCEL_REQUEST', entityType: 'Contract', entityId: id, newValues: { reason, approvalRequestId: approval.id } });
      return NextResponse.json({ pendingApproval: true, approval }, { status: 202 });
    }

    const contract = await cancelContract({ contractId: id, reason, userId: auth.user.id });
    await logAudit({ userId: auth.user.id, action: 'CONTRACT_CANCEL', entityType: 'Contract', entityId: id, oldValues: existing, newValues: { reason } });
    return NextResponse.json({ contract });
  } catch (e) {
    if (e instanceof ContractError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ApprovalError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
