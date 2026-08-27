import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { dailyCashReceivedReport } from '@/lib/services/reportService';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'report.view.branch', 'report.view.all');
  if (!perm.authorized) return perm.error;

  const { searchParams } = req.nextUrl;
  const report = await dailyCashReceivedReport(
    branchScopeWhere(auth.user),
    searchParams.get('from') ?? undefined,
    searchParams.get('to') ?? undefined,
  );
  return NextResponse.json(report);
}
