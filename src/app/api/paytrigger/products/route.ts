import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { listProducts, setProductBrand, PayTriggerError } from '@/lib/paytrigger/admin';

/** Which products are TECNO, Infinix or itel phones, sold only on Device Financing. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'paytrigger.view');
  if (!perm.authorized) return perm.error;
  return NextResponse.json({ products: await listProducts() });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;
  const body = (await req.json().catch(() => ({}))) as { productId?: unknown; brand?: unknown };
  if (typeof body.productId !== 'string') return NextResponse.json({ error: 'productId is required' }, { status: 400 });
  if (body.brand !== null && typeof body.brand !== 'string') return NextResponse.json({ error: 'brand must be TECNO, INFINIX, ITEL or null' }, { status: 400 });
  try {
    await setProductBrand(body.productId, body.brand as string | null, auth.user.id);
    return NextResponse.json({ products: await listProducts() });
  } catch (e) {
    if (e instanceof PayTriggerError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
