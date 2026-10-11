import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission, branchScopeWhere, ownRecordsWhere } from '@/lib/auth/rbac';
import { listMobileMoneyAttempts, type MobileMoneyFilter } from '@/lib/services/mobileMoneyOpsService';

const FILTERS: MobileMoneyFilter[] = ['NEEDS_REVIEW', 'PENDING', 'FAILED', 'SUCCESS', 'ALL'];

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.view');
  if (!perm.authorized) return perm.error;

  const { searchParams } = req.nextUrl;
  const filter = (searchParams.get('filter') ?? 'ALL') as MobileMoneyFilter;
  if (!FILTERS.includes(filter)) return NextResponse.json({ error: `filter must be one of: ${FILTERS.join(', ')}` }, { status: 400 });

  const result = await listMobileMoneyAttempts({
    scope: { ...branchScopeWhere(auth.user), ...ownRecordsWhere(auth.user) },
    filter,
    q: searchParams.get('q') ?? undefined,
    page: Math.max(1, Number(searchParams.get('page')) || 1),
  });
  return NextResponse.json(result);
}
