import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { applyStockMovement } from '@/lib/services/inventoryService';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.adjust');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { toStatus, reason } = (await req.json()) as { toStatus?: string; reason?: string };
  if (!toStatus || !reason) return NextResponse.json({ error: 'toStatus and reason are required' }, { status: 400 });

  try {
    const item = await applyStockMovement({ inventoryItemId: id, type: 'ADJUSTMENT', toStatus, reason, createdById: auth.user.id });
    return NextResponse.json({ item });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }
}
