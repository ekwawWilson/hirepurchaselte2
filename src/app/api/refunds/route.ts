import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { listRefunds } from '@/lib/services/refundService';

/** Refunds owed on cancelled contracts (?status=OWED, the default) or already recorded (?status=SETTLED). */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.view');
  if (!perm.authorized) return perm.error;

  const status = req.nextUrl.searchParams.get('status') === 'SETTLED' ? 'SETTLED' : 'OWED';
  return NextResponse.json(await listRefunds({ scope: branchScopeWhere(auth.user), status }));
}
