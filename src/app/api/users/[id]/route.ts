import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { logAudit } from '@/lib/services/auditService';
import { agentOutstanding } from '@/lib/services/agentLedgerService';

function toUserResponse(user: {
  id: string; email: string; firstName: string; lastName: string; isActive: boolean;
  mustChangePassword: boolean; branchId: string | null; role: { name: string };
}) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    isActive: user.isActive,
    mustChangePassword: user.mustChangePassword,
    branchId: user.branchId,
    role: user.role.name,
  };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'user.manage');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { firstName, lastName, role, branchId, isActive, acknowledgeOutstanding } = (await req.json()) as {
    firstName?: string; lastName?: string; role?: string; branchId?: string | null; isActive?: boolean; acknowledgeOutstanding?: boolean;
  };

  const existing = await prisma.user.findUnique({ where: { id }, include: { role: true } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  // An agent leaving — deactivated, or moved to another role, which also
  // stops their ledger following their contracts — while they still hold the
  // office's cash, or are owed commission, is said out loud first.
  const agentLeaving = existing.role.name === 'AGENT'
    && ((isActive === false && existing.isActive) || (role !== undefined && role !== 'AGENT'));
  if (agentLeaving && !acknowledgeOutstanding) {
    const outstanding = await agentOutstanding(id);
    if (outstanding.agentOwesMinor > 0 || outstanding.owedToAgentMinor > 0) {
      const parts = [
        outstanding.agentOwesMinor > 0 && `still owes GHS ${(outstanding.agentOwesMinor / 100).toFixed(2)} of customers' cash`,
        outstanding.owedToAgentMinor > 0 && `is owed GHS ${(outstanding.owedToAgentMinor / 100).toFixed(2)} of commission`,
      ].filter(Boolean).join(' and ');
      return NextResponse.json({
        error: `${existing.firstName} ${existing.lastName} ${parts}. Settle it on the Agent Ledger first, or confirm to go ahead anyway.`,
        code: 'AGENT_HAS_BALANCE', ...outstanding,
      }, { status: 409 });
    }
  }

  let roleId: string | undefined;
  if (role !== undefined) {
    // Looked up rather than checked against a fixed list — see the matching
    // comment in POST /api/users.
    const roleRow = await prisma.role.findUnique({ where: { name: role } });
    if (!roleRow) return NextResponse.json({ error: `Unknown role: ${role}` }, { status: 400 });
    roleId = roleRow.id;
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(roleId !== undefined && { roleId }),
      ...(branchId !== undefined && { branchId }),
      ...(isActive !== undefined && { isActive }),
    },
    include: { role: true },
  });
  await logAudit({
    userId: auth.user.id, action: 'USER_UPDATE', entityType: 'User', entityId: id,
    oldValues: { roleId: existing.roleId, branchId: existing.branchId, isActive: existing.isActive },
    newValues: { roleId: user.roleId, branchId: user.branchId, isActive: user.isActive },
  });

  return NextResponse.json({ user: toUserResponse(user) });
}
