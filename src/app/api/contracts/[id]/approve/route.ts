import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { approveContract, ContractError } from '@/lib/services/contractService';
import { logAudit } from '@/lib/services/auditService';

/**
 * The Agent module: an approver accepts an agent-submitted contract. Not
 * ownership-checked against the creator (assertOwnRecordAccess) — that
 * check exists to stop an AGENT reaching into someone else's book, and an
 * approver reviewing an agent's submission is exactly the opposite case; only
 * contract.approve (BRANCH_MANAGER/ADMIN/SUPER_ADMIN) plus the ordinary
 * branch check below gate this.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.approve');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const existing = await prisma.contract.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, existing.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const contract = await approveContract({ contractId: id, approvedById: auth.user.id });
    await logAudit({ userId: auth.user.id, action: 'CONTRACT_APPROVE', entityType: 'Contract', entityId: id, oldValues: existing, newValues: contract });
    // Same reasoning as the ordinary contract-creation route: DEVICE_LOAN
    // disbursement is only real, and only auditable as such, once approved.
    if (contract.contractType === 'DEVICE_LOAN') {
      await logAudit({
        userId: auth.user.id, action: 'DEVICE_LOAN_DISBURSEMENT', entityType: 'Contract', entityId: contract.id,
        newValues: { principalMinor: contract.principalMinor, customerId: contract.customerId },
      });
    }
    return NextResponse.json({ contract });
  } catch (e) {
    if (e instanceof ContractError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
