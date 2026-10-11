import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { recordRefund, RefundError } from '@/lib/services/refundService';
import { logAudit } from '@/lib/services/auditService';

/** Records what was handed back to the customer on a cancelled contract. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.reverse', 'contract.cancel');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { refundedMinor, note } = (await req.json().catch(() => ({}))) as { refundedMinor?: number; note?: string };
  if (typeof refundedMinor !== 'number') return NextResponse.json({ error: 'refundedMinor is required' }, { status: 400 });

  const existing = await prisma.contract.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, existing.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const refund = await recordRefund({ contractId: id, refundedMinor, note, userId: auth.user.id });
    await logAudit({
      userId: auth.user.id, action: 'CONTRACT_REFUND_RECORD', entityType: 'Contract', entityId: id,
      newValues: { refundDueMinor: existing.refundDueMinor, refundedMinor, note: note ?? null },
    });
    return NextResponse.json({ refund });
  } catch (e) {
    if (e instanceof RefundError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
