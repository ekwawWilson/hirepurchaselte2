import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { reversePayment, PaymentError } from '@/lib/services/paymentService';
import { logAudit } from '@/lib/services/auditService';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.reverse');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { reason } = (await req.json()) as { reason?: string };
  if (!reason) return NextResponse.json({ error: 'reason is required' }, { status: 400 });

  const payment = await prisma.payment.findUnique({ where: { id }, include: { contract: true } });
  if (!payment) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, payment.contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const reversal = await reversePayment({ paymentId: id, reason, reversedById: auth.user.id });
    await logAudit({ userId: auth.user.id, action: 'PAYMENT_REVERSE', entityType: 'Payment', entityId: id, oldValues: payment, newValues: { reason } });
    return NextResponse.json({ reversal }, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
