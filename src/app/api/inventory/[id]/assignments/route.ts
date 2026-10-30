import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { assignmentHistory } from '@/lib/services/stockAssignmentService';

/** Who held this unit, and when it changed hands. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.view');
  if (!perm.authorized) return perm.error;
  const { id } = await params;
  const item = await prisma.inventoryItem.findUnique({ where: { id }, select: { branchId: true, assignedAgentId: true } });
  if (!item || !assertBranchAccess(auth.user, item.branchId)) return NextResponse.json({ error: 'Inventory item not found' }, { status: 404 });
  if (auth.user.roleName === 'AGENT' && item.assignedAgentId !== auth.user.id) return NextResponse.json({ error: 'Inventory item not found' }, { status: 404 });
  return NextResponse.json({ history: await assignmentHistory(id) });
}
