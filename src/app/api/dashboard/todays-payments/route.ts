import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { todaysPaymentsFeed } from '@/lib/services/reportService';

/**
 * Polled by the notification bell. Anyone who can view payments sees how
 * many came in today and who paid; the cash total is only included for those
 * who can view reports — left out of the response rather than hidden in the
 * page, since anyone can read a response in their browser's network tab.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.view');
  if (!perm.authorized) return perm.error;

  const includeTotal = requirePermission(auth.user, 'report.view.branch', 'report.view.all').authorized;
  const feed = await todaysPaymentsFeed(branchScopeWhere(auth.user), { includeTotal });
  return NextResponse.json(feed, { headers: { 'Cache-Control': 'no-store' } });
}
