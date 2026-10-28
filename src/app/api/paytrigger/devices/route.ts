import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { listDevices } from '@/lib/paytrigger/admin';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'paytrigger.view');
  if (!perm.authorized) return perm.error;
  const { searchParams } = req.nextUrl;
  const devices = await listDevices({ status: searchParams.get('status') ?? undefined, q: searchParams.get('q') ?? undefined });
  return NextResponse.json({ devices });
}
