import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { agentStockOverview } from '@/lib/services/stockAssignmentService';

/** Each agent in the caller's branches, with the units they hold: available, reserved, sold. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.transfer');
  if (!perm.authorized) return perm.error;
  return NextResponse.json({ agents: await agentStockOverview(auth.user.branchId) });
}
