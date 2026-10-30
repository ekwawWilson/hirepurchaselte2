import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { listCompletionCommissions, agentCompletionSummary, type CompletionStatus } from '@/lib/services/completionCommissionService';

const STATUSES: CompletionStatus[] = ['PENDING', 'PAYABLE', 'ON_HOLD', 'FORFEITED', 'PAID'];

/**
 * Commission paid when customers complete. A manager (agent.ledger.manage)
 * sees every agent's in their branch, filtered by status, agent or month
 * completed; an agent sees their own, with their totals.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const { searchParams } = req.nextUrl;
  const status = searchParams.get('status') as CompletionStatus | null;
  if (status && !STATUSES.includes(status)) return NextResponse.json({ error: `status must be one of ${STATUSES.join(', ')}` }, { status: 400 });
  const month = searchParams.get('month') ?? undefined;
  if (month && !/^\d{4}-\d{2}$/.test(month)) return NextResponse.json({ error: 'month must be YYYY-MM' }, { status: 400 });

  if (requirePermission(auth.user, 'agent.ledger.manage').authorized) {
    return NextResponse.json(await listCompletionCommissions({
      branchId: branchScopeWhere(auth.user).branchId, agentId: searchParams.get('agentId') ?? undefined, status: status ?? undefined, completedMonth: month,
    }));
  }
  const perm = requirePermission(auth.user, 'agent.ledger.view');
  if (!perm.authorized) return perm.error;
  const own = await listCompletionCommissions({ agentId: auth.user.id, status: status ?? undefined, completedMonth: month });
  return NextResponse.json({ ...own, summary: await agentCompletionSummary(auth.user.id) });
}
