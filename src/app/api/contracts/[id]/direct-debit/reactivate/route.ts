import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { reactivatePreapproval, PreapprovalError } from '@/lib/services/hubtelPreapprovalService';
import { logAudit } from '@/lib/services/auditService';

/** Restores a cancelled mandate; the customer approves again by USSD prompt or OTP, as Hubtel decides. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.reschedule');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const contract = await prisma.contract.findUnique({ where: { id } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!contract.hubtelPreapprovalId) return NextResponse.json({ error: 'This contract has no direct-debit mandate' }, { status: 400 });

  try {
    const preapproval = await reactivatePreapproval({ preapprovalId: contract.hubtelPreapprovalId });
    await logAudit({
      userId: auth.user.id, action: 'DIRECT_DEBIT_MANDATE_REACTIVATE', entityType: 'Contract', entityId: id,
      newValues: { preapprovalId: preapproval.id, status: preapproval.status },
    });
    return NextResponse.json({ preapproval });
  } catch (e) {
    if (e instanceof PreapprovalError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
