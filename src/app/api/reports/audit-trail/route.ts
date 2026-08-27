import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { auditTrailReport } from '@/lib/services/reportService';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'audit.view');
  if (!perm.authorized) return perm.error;

  const { searchParams } = req.nextUrl;
  const entries = await auditTrailReport(searchParams.get('from') ?? undefined, searchParams.get('to') ?? undefined);
  return NextResponse.json({ entries });
}
