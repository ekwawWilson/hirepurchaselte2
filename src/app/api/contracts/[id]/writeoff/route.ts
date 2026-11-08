import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { writeOffContract, closingProblem, ContractError } from '@/lib/services/contractService';
import { requestApproval, secondApprovalRequired, ApprovalError } from '@/lib/services/approvalService';
import { PRE_APPROVAL_STATUSES } from '@/lib/constants/contracts';
import { logAudit } from '@/lib/services/auditService';

/**
 * Writes off a contract — or, with the second-approval control on, files the
 * write-off for a different person to approve (202, nothing written off yet).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.writeoff');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { reason, phoneReturned } = (await req.json()) as { reason?: string; phoneReturned?: unknown };
  if (!reason?.trim()) return NextResponse.json({ error: 'reason is required' }, { status: 400 });
  // A phone sale: whether the customer handed the phone back (contractService.closingProblem).
  if (phoneReturned !== undefined && typeof phoneReturned !== 'boolean') return NextResponse.json({ error: 'phoneReturned must be true or false' }, { status: 400 });

  const existing = await prisma.contract.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, existing.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    // Turning down a contract an agent submitted gives up no money — nothing
    // can have been paid on it — so it is not a write-off in the sense the
    // control is there for, and one approver's decision is enough.
    const givesUpDebt = !PRE_APPROVAL_STATUSES.includes(existing.status);
    if (givesUpDebt && await secondApprovalRequired()) {
      const problem = await closingProblem('writeoff', existing, phoneReturned);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      const approval = await requestApproval({
        kind: 'CONTRACT_WRITEOFF', targetId: id, contractId: id, branchId: existing.branchId,
        reason: reason.trim(), requestedById: auth.user.id, phoneReturned,
      });
      await logAudit({ userId: auth.user.id, action: 'CONTRACT_WRITEOFF_REQUEST', entityType: 'Contract', entityId: id, newValues: { reason, approvalRequestId: approval.id } });
      return NextResponse.json({ pendingApproval: true, approval }, { status: 202 });
    }

    const contract = await writeOffContract({ contractId: id, reason, userId: auth.user.id, phoneReturned });
    await logAudit({ userId: auth.user.id, action: 'CONTRACT_WRITEOFF', entityType: 'Contract', entityId: id, oldValues: existing, newValues: { reason, phoneReturned } });
    return NextResponse.json({ contract });
  } catch (e) {
    if (e instanceof ContractError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ApprovalError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
