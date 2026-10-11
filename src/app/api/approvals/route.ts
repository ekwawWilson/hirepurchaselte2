import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { listApprovals, APPROVAL_PERMISSIONS } from '@/lib/services/approvalService';

/** Reversals, write-offs and cancellations waiting for a second person (?status=PENDING, the default) or already decided (?status=DECIDED). */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, ...APPROVAL_PERMISSIONS);
  if (!perm.authorized) return perm.error;

  const status = req.nextUrl.searchParams.get('status') === 'DECIDED' ? 'DECIDED' : 'PENDING';
  return NextResponse.json({ approvals: await listApprovals({ user: auth.user, status }) });
}
