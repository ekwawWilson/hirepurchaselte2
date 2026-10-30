import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { getAgentPortfolioRisk } from '@/lib/services/portfolioRiskService';
import { getControlSettings } from '@/lib/services/controlSettingsService';

/**
 * Portfolio at risk per agent (PAR30 and PAR1), the same figures the sale
 * limit uses. An agent sees only their own.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const isAgent = auth.user.roleName === 'AGENT';
  if (!isAgent) {
    const perm = requirePermission(auth.user, 'report.view.branch', 'report.view.all');
    if (!perm.authorized) return perm.error;
  }
  const settings = await getControlSettings();
  const agents = await getAgentPortfolioRisk(isAgent ? { agentIds: [auth.user.id] } : { branchId: branchScopeWhere(auth.user).branchId });
  return NextResponse.json({
    agents,
    limit: settings.parBlockEnabled ? { thresholdPercent: settings.parBlockThresholdPercent, minContracts: settings.parBlockMinContracts } : null,
  });
}
