import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { outstandingBalancesReport } from '@/lib/services/reportService';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'report.view.branch', 'report.view.all');
  if (!perm.authorized) return perm.error;

  const report = await outstandingBalancesReport(branchScopeWhere(auth.user));
  return NextResponse.json(report);
}
