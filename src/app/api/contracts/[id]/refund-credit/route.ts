import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { postCreditRefund, PaymentError } from '@/lib/services/paymentService';
import { logAudit } from '@/lib/services/auditService';

/** Hands a customer back money they paid beyond what the contract costs (paymentService.postCreditRefund). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.reverse');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { amountMinor, method, notes } = (await req.json().catch(() => ({}))) as { amountMinor?: number; method?: string; notes?: string };
  if (typeof amountMinor !== 'number') return NextResponse.json({ error: 'amountMinor is required' }, { status: 400 });
  if (method !== 'CASH' && method !== 'MOBILE_MONEY') return NextResponse.json({ error: 'method must be CASH or MOBILE_MONEY' }, { status: 400 });

  const contract = await prisma.contract.findUnique({ where: { id } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const refund = await postCreditRefund({ contractId: id, amountMinor, method, notes, createdById: auth.user.id });
    await logAudit({ userId: auth.user.id, action: 'CREDIT_REFUND', entityType: 'Payment', entityId: refund.id, newValues: { contractId: id, amountMinor, method, notes: notes ?? null } });
    return NextResponse.json({ refund }, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
