import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { initiatePreapproval, enableDirectDebit, disableDirectDebit, PreapprovalError } from '@/lib/services/hubtelPreapprovalService';
import { logAudit } from '@/lib/services/auditService';

/** Sets up direct debit on a contract: requests (or reuses) a mandate, then attaches it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.reschedule');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { msisdn, network } = (await req.json()) as { msisdn?: string; network?: string };
  if (!msisdn || !network) return NextResponse.json({ error: 'msisdn and network are required' }, { status: 400 });

  const contract = await prisma.contract.findUnique({ where: { id } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const { preapproval, reused } = await initiatePreapproval({
      customerId: contract.customerId, msisdn, network, createdById: auth.user.id,
    });
    const updated = await enableDirectDebit({ contractId: id, preapprovalId: preapproval.id, userId: auth.user.id });
    await logAudit({
      userId: auth.user.id, action: 'DIRECT_DEBIT_ENABLE', entityType: 'Contract', entityId: id,
      newValues: { preapprovalId: preapproval.id, msisdn, network, reused },
    });
    return NextResponse.json({ contract: updated, preapproval, reused });
  } catch (e) {
    if (e instanceof PreapprovalError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

/** Removes direct debit from a contract (the underlying mandate itself stays APPROVED for reuse elsewhere). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.reschedule');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const contract = await prisma.contract.findUnique({ where: { id } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const updated = await disableDirectDebit({ contractId: id, userId: auth.user.id });
  await logAudit({ userId: auth.user.id, action: 'DIRECT_DEBIT_DISABLE', entityType: 'Contract', entityId: id });
  return NextResponse.json({ contract: updated });
}
