import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { deviceDetail, PayTriggerError } from '@/lib/paytrigger/admin';

/** One phone: its state, its contract and every request made about it. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'paytrigger.view');
  if (!perm.authorized) return perm.error;
  try {
    return NextResponse.json(await deviceDetail((await params).id));
  } catch (e) {
    if (e instanceof PayTriggerError) return NextResponse.json({ error: e.message }, { status: 404 });
    throw e;
  }
}
