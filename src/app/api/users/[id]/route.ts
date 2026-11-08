import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { logAudit } from '@/lib/services/auditService';
import { cleanStaffPhone } from '@/lib/services/staffPhoneService';
import { issueAgentPaymentPin } from '@/lib/services/agentPaymentPinService';
import { agentOutstanding } from '@/lib/services/agentLedgerService';
import { assignStock } from '@/lib/services/stockAssignmentService';

function toUserResponse(user: {
  id: string; email: string; phone: string | null; firstName: string; lastName: string; isActive: boolean;
  mustChangePassword: boolean; branchId: string | null; role: { name: string };
}) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
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
  const { firstName, lastName, role, branchId, isActive, acknowledgeOutstanding, phone } = (await req.json()) as {
    firstName?: string; lastName?: string; role?: string; branchId?: string | null; isActive?: boolean; acknowledgeOutstanding?: boolean; phone?: string;
  };

  const existing = await prisma.user.findUnique({ where: { id }, include: { role: true } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  const cleanedPhone = phone === undefined ? null : await cleanStaffPhone(phone, id);
  if (cleanedPhone && 'error' in cleanedPhone) return NextResponse.json({ error: cleanedPhone.error }, { status: 400 });

  // An agent leaving — deactivated, or moved to another role, which also
  // stops their ledger following their contracts — while they still hold the
  // office's cash, or are owed commission, is said out loud first. So are
  // the phones they hold: once confirmed, those come back to the shop, as
  // they do when an agent moves branch (they can only sell in their own).
  const agentLeaving = existing.role.name === 'AGENT'
    && ((isActive === false && existing.isActive) || (role !== undefined && role !== 'AGENT'));
  const agentMoving = existing.role.name === 'AGENT' && branchId !== undefined && branchId !== existing.branchId;
  const heldStock = agentLeaving || agentMoving
    ? await prisma.inventoryItem.findMany({ where: { assignedAgentId: id, status: 'AVAILABLE' }, select: { id: true } })
    : [];
  if ((agentLeaving || agentMoving) && !acknowledgeOutstanding) {
    const outstanding = agentLeaving ? await agentOutstanding(id) : { agentOwesMinor: 0, owedToAgentMinor: 0 };
    if (outstanding.agentOwesMinor > 0 || outstanding.owedToAgentMinor > 0 || heldStock.length > 0) {
      const parts = [
        outstanding.agentOwesMinor > 0 && `still owes GHS ${(outstanding.agentOwesMinor / 100).toFixed(2)} of customers' cash`,
        outstanding.owedToAgentMinor > 0 && `is owed GHS ${(outstanding.owedToAgentMinor / 100).toFixed(2)} of commission`,
        heldStock.length > 0 && `holds ${heldStock.length} unsold unit${heldStock.length === 1 ? '' : 's'} of stock, which will come back to the shop`,
      ].filter(Boolean).join(' and ');
      return NextResponse.json({
        error: `${existing.firstName} ${existing.lastName} ${parts}. Settle it on the Agent Ledger and collect the phones first, or confirm to go ahead anyway.`,
        code: 'AGENT_HAS_BALANCE', ...outstanding, unitsHeld: heldStock.length,
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
      ...(cleanedPhone && { phone: cleanedPhone.phone }),
    },
    include: { role: true },
  });
  if (user.role.name === 'AGENT') await issueAgentPaymentPin(id);
  if (heldStock.length > 0) {
    await assignStock({
      inventoryItemIds: heldStock.map((i) => i.id), agentId: null, actor: { id: auth.user.id, branchId: null },
      reason: agentLeaving ? `${existing.firstName} ${existing.lastName} stopped being an agent` : `${existing.firstName} ${existing.lastName} moved branch`,
    });
  }
  await logAudit({
    userId: auth.user.id, action: 'USER_UPDATE', entityType: 'User', entityId: id,
    oldValues: { roleId: existing.roleId, branchId: existing.branchId, isActive: existing.isActive, phone: existing.phone },
    newValues: { roleId: user.roleId, branchId: user.branchId, isActive: user.isActive, phone: user.phone },
  });

  return NextResponse.json({ user: toUserResponse(user) });
}
