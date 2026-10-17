import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { agentPerformanceReport } from '@/lib/services/agentReportService';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'report.view.branch', 'report.view.all');
  if (!perm.authorized) return perm.error;

  const { searchParams } = req.nextUrl;
  return NextResponse.json(await agentPerformanceReport(
    branchScopeWhere(auth.user), searchParams.get('from') ?? undefined, searchParams.get('to') ?? undefined,
  ));
}
