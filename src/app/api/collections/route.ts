import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission, branchScopeWhere, ownRecordsWhere } from '@/lib/auth/rbac';
import { listCollectionsQueue, COLLECTIONS_FILTERS, type CollectionsFilter } from '@/lib/services/arrearsFollowUpService';

/** Every contract in arrears the caller may see, worst first. ?filter=ALL|FOLLOW_UP_DUE|PROMISES|NOT_CONTACTED&q= */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.view');
  if (!perm.authorized) return perm.error;

  const { searchParams } = req.nextUrl;
  const filter = (searchParams.get('filter') ?? 'ALL') as CollectionsFilter;
  if (!COLLECTIONS_FILTERS.includes(filter)) {
    return NextResponse.json({ error: `filter must be one of: ${COLLECTIONS_FILTERS.join(', ')}` }, { status: 400 });
  }
  const queue = await listCollectionsQueue({
    scope: { ...branchScopeWhere(auth.user), ...ownRecordsWhere(auth.user) }, filter, q: searchParams.get('q') ?? undefined,
  });
  return NextResponse.json(queue);
}
