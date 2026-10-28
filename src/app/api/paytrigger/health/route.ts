import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { payTriggerHealth } from '@/lib/paytrigger/admin';

/** The switches (dry run, live, canary), licences, device counts and the last sweep. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'paytrigger.view');
  if (!perm.authorized) return perm.error;
  return NextResponse.json(await payTriggerHealth());
}
