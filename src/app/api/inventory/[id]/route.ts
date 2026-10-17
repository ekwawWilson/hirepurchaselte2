import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { logAudit } from '@/lib/services/auditService';

/**
 * Corrects a unit's model name and specification — for units received before
 * either was recorded, or entered wrongly. Its product, serial number and
 * status are not changed here: those carry the stock history.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.receive', 'inventory.adjust');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const existing = await prisma.inventoryItem.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Inventory item not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, existing.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { name, description } = (await req.json().catch(() => ({}))) as { name?: string | null; description?: string | null };
  const item = await prisma.inventoryItem.update({
    where: { id },
    data: {
      ...(name !== undefined && { name: name?.trim() || null }),
      ...(description !== undefined && { description: description?.trim() || null }),
    },
    include: { product: { include: { category: true } }, branch: { select: { name: true } } },
  });
  await logAudit({
    userId: auth.user.id, action: 'INVENTORY_ITEM_UPDATE', entityType: 'InventoryItem', entityId: id,
    oldValues: { name: existing.name, description: existing.description }, newValues: { name: item.name, description: item.description },
  });
  return NextResponse.json({ item });
}
