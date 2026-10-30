import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { assignStock, StockAssignmentError } from '@/lib/services/stockAssignmentService';

/**
 * Hands units to an agent to sell, moves them between agents, or takes them
 * back into the shop ({ agentId: null }). Units on a contract never move.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.transfer');
  if (!perm.authorized) return perm.error;
  const body = (await req.json().catch(() => ({}))) as { inventoryItemIds?: unknown; agentId?: unknown; reason?: unknown };
  if (!Array.isArray(body.inventoryItemIds) || !body.inventoryItemIds.every((i) => typeof i === 'string')) {
    return NextResponse.json({ error: 'inventoryItemIds must be a list of inventory item ids' }, { status: 400 });
  }
  if (body.agentId !== null && typeof body.agentId !== 'string') return NextResponse.json({ error: 'agentId must be an agent id, or null to take the units back' }, { status: 400 });
  try {
    const result = await assignStock({
      inventoryItemIds: body.inventoryItemIds as string[], agentId: body.agentId as string | null,
      reason: typeof body.reason === 'string' ? body.reason : undefined, actor: { id: auth.user.id, branchId: auth.user.branchId },
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof StockAssignmentError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
