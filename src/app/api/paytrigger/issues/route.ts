import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { payTriggerIssues } from '@/lib/paytrigger/admin';

/** What needs a person, most urgent first: paid but still locked, deposit holds, failures. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'paytrigger.view');
  if (!perm.authorized) return perm.error;
  return NextResponse.json(await payTriggerIssues());
}
