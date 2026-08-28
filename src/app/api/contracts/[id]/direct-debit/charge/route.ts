import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { chargeDirectDebit, PreapprovalError } from '@/lib/services/hubtelPreapprovalService';
import { logAudit } from '@/lib/services/auditService';

/** Staff-triggered "charge now" against an already-approved mandate — same charge path the automated collections run uses. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.cash.record');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { amountMinor } = (await req.json()) as { amountMinor?: number };
  if (typeof amountMinor !== 'number' || amountMinor <= 0) {
    return NextResponse.json({ error: 'amountMinor must be a positive number' }, { status: 400 });
  }

  const contract = await prisma.contract.findUnique({ where: { id } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const transaction = await chargeDirectDebit({ contractId: id, amountMinor });
    await logAudit({ userId: auth.user.id, action: 'DIRECT_DEBIT_CHARGE', entityType: 'Contract', entityId: id, newValues: { amountMinor, status: transaction.status } });
    return NextResponse.json({ transaction });
  } catch (e) {
    if (e instanceof PreapprovalError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
