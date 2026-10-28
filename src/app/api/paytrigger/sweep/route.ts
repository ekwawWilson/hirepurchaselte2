import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { runPayTriggerSweep } from '@/lib/paytrigger/sweep';

/** Runs the 08:36 sweep now: for going live, or after fixing something it reported. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'paytrigger.manage');
  if (!perm.authorized) return perm.error;
  return NextResponse.json({ summary: await runPayTriggerSweep() });
}
