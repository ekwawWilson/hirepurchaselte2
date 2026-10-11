import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { reapplyCollectedCharge } from '@/lib/services/mobileMoneyOpsService';
import { HubtelError } from '@/lib/services/hubtelPaymentService';
import { logAudit } from '@/lib/services/auditService';

/** Tries again to post a collected-but-unapplied charge to its contract. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.cash.record');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const txn = await prisma.hubtelTransaction.findUnique({ where: { id }, include: { contract: { select: { branchId: true } } } });
  if (!txn) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, txn.contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const updated = await reapplyCollectedCharge(id);
    await logAudit({ userId: auth.user.id, action: 'MOBILE_MONEY_REAPPLY', entityType: 'HubtelTransaction', entityId: id, newValues: { status: updated.status, note: updated.resolutionNote } });
    return NextResponse.json({ transaction: { id: updated.id, status: updated.status, paymentId: updated.paymentId, resolvedAt: updated.resolvedAt } });
  } catch (e) {
    if (e instanceof HubtelError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
