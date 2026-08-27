import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { cancelContract, ContractError } from '@/lib/services/contractService';
import { logAudit } from '@/lib/services/auditService';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.cancel');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { reason } = (await req.json()) as { reason?: string };
  if (!reason) return NextResponse.json({ error: 'reason is required' }, { status: 400 });

  const existing = await prisma.contract.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, existing.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const contract = await cancelContract({ contractId: id, reason, userId: auth.user.id });
    await logAudit({ userId: auth.user.id, action: 'CONTRACT_CANCEL', entityType: 'Contract', entityId: id, oldValues: existing, newValues: { reason } });
    return NextResponse.json({ contract });
  } catch (e) {
    if (e instanceof ContractError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
