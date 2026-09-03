import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { postWithdrawal, PaymentError } from '@/lib/services/paymentService';
import { logAudit } from '@/lib/services/auditService';

/**
 * Cash withdrawal from a Save to Own contract's accumulated savings — gated
 * behind payment.reverse rather than payment.cash.record. A withdrawal moves
 * real cash back out to the customer with no receipt-taking counterpart to
 * check it against, the same trust level as reversing a payment (both let
 * staff move money without an offsetting physical good changing hands), so
 * it's reserved for the same roles (Branch Manager/Admin/Super Admin — see
 * constants/rbac.ts), not every cashier who can merely record money coming in.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.reverse');
  if (!perm.authorized) return perm.error;

  const { contractId, amountMinor, notes } = (await req.json()) as Record<string, unknown>;
  if (!contractId || typeof amountMinor !== 'number' || amountMinor <= 0) {
    return NextResponse.json({ error: 'contractId and a positive amountMinor are required' }, { status: 400 });
  }

  const contract = await prisma.contract.findUnique({ where: { id: contractId as string } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const payment = await postWithdrawal({
      contractId: contractId as string,
      amountMinor,
      notes: notes as string | undefined,
      createdById: auth.user.id,
    });
    await logAudit({ userId: auth.user.id, action: 'PAYMENT_WITHDRAWAL_RECORD', entityType: 'Payment', entityId: payment.id, newValues: { contractId, amountMinor } });
    return NextResponse.json({ payment }, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
