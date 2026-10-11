import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess, assertOwnRecordAccess } from '@/lib/auth/rbac';
import { checkPreapprovalStatus, PreapprovalError } from '@/lib/services/hubtelPreapprovalService';
import { logAudit } from '@/lib/services/auditService';

/**
 * Asks Hubtel where a pending mandate stands, for when the customer says they
 * approved but the callback never landed. Open to whoever can create a
 * contract, not only to those who can reschedule one: the person who sold the
 * contract is the one at the counter with the customer while it is pending.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.reschedule', 'contract.create');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const contract = await prisma.contract.findUnique({ where: { id } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!assertOwnRecordAccess(auth.user, contract.createdById)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!contract.hubtelPreapprovalId) return NextResponse.json({ error: 'This contract has no direct-debit mandate' }, { status: 400 });

  try {
    const preapproval = await checkPreapprovalStatus({ preapprovalId: contract.hubtelPreapprovalId });
    await logAudit({
      userId: auth.user.id, action: 'DIRECT_DEBIT_STATUS_CHECK', entityType: 'Contract', entityId: id,
      newValues: { preapprovalId: preapproval.id, status: preapproval.status },
    });
    return NextResponse.json({ preapproval });
  } catch (e) {
    if (e instanceof PreapprovalError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
