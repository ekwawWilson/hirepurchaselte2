import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { reversePayment, reversalProblem, PaymentError } from '@/lib/services/paymentService';
import { requestApproval, secondApprovalRequired, ApprovalError } from '@/lib/services/approvalService';
import { logAudit } from '@/lib/services/auditService';

/**
 * Reverses a payment — or, with the second-approval control on, files the
 * reversal for a different person to approve (202, nothing reversed yet).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.reverse');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { reason } = (await req.json()) as { reason?: string };
  if (!reason?.trim()) return NextResponse.json({ error: 'reason is required' }, { status: 400 });

  const payment = await prisma.payment.findUnique({ where: { id }, include: { contract: true } });
  if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, payment.contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    if (await secondApprovalRequired()) {
      // Refused now rather than after someone has been asked to approve it.
      const problem = reversalProblem(payment);
      if (problem) return NextResponse.json({ error: problem }, { status: 400 });
      const approval = await requestApproval({
        kind: 'PAYMENT_REVERSAL', targetId: id, contractId: payment.contractId, branchId: payment.contract.branchId,
        reason: reason.trim(), requestedById: auth.user.id,
      });
      await logAudit({ userId: auth.user.id, action: 'PAYMENT_REVERSE_REQUEST', entityType: 'Payment', entityId: id, newValues: { reason, approvalRequestId: approval.id } });
      return NextResponse.json({ pendingApproval: true, approval }, { status: 202 });
    }

    const reversal = await reversePayment({ paymentId: id, reason, reversedById: auth.user.id });
    await logAudit({ userId: auth.user.id, action: 'PAYMENT_REVERSE', entityType: 'Payment', entityId: id, oldValues: payment, newValues: { reason } });
    return NextResponse.json({ reversal }, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ApprovalError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
