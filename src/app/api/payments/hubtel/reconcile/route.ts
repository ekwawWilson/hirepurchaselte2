import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { reconcilePendingHubtelTransactions } from '@/lib/services/hubtelPaymentService';

/** Manual trigger for the same sweep instrumentation.ts runs on a schedule. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.view');
  if (!perm.authorized) return perm.error;

  const result = await reconcilePendingHubtelTransactions();
  return NextResponse.json(result);
}
