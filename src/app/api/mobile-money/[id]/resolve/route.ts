import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { resolveCollectedCharge } from '@/lib/services/mobileMoneyOpsService';
import { HubtelError } from '@/lib/services/hubtelPaymentService';
import { logAudit } from '@/lib/services/auditService';

/** Closes a collected-but-unapplied charge that was dealt with outside the ledger, recording what was done. Needs the same authority as reversing a payment. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.reverse');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { note } = (await req.json().catch(() => ({}))) as { note?: string };
  const txn = await prisma.hubtelTransaction.findUnique({ where: { id }, include: { contract: { select: { branchId: true } } } });
  if (!txn) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, txn.contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const updated = await resolveCollectedCharge({ txnId: id, userId: auth.user.id, note: note ?? '' });
    await logAudit({ userId: auth.user.id, action: 'MOBILE_MONEY_RESOLVE', entityType: 'HubtelTransaction', entityId: id, newValues: { status: updated.status, note: updated.resolutionNote } });
    return NextResponse.json({ transaction: { id: updated.id, status: updated.status, paymentId: updated.paymentId, resolvedAt: updated.resolvedAt } });
  } catch (e) {
    if (e instanceof HubtelError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
