import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { applyStockMovement } from '@/lib/services/inventoryService';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.transfer');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { toBranchId, reason } = (await req.json()) as { toBranchId?: string; reason?: string };
  if (!toBranchId) return NextResponse.json({ error: 'toBranchId is required' }, { status: 400 });

  try {
    const item = await applyStockMovement({ inventoryItemId: id, type: 'TRANSFER', toBranchId, reason, createdById: auth.user.id });
    return NextResponse.json({ item });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
