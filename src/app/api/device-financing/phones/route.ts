import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { listPhones, createPhone, PhoneStockError } from '@/lib/services/phoneStockService';

/** Device Financing phone models, with their plans and stock. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.view', 'contract.create');
  if (!perm.authorized) return perm.error;
  const { searchParams } = req.nextUrl;
  return NextResponse.json({ phones: await listPhones({ includeInactive: searchParams.get('inactive') === '1', q: searchParams.get('q') ?? undefined }) });
}

/** A new phone model with its plans: it sets prices, so it is for those who price. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'pricechart.edit');
  if (!perm.authorized) return perm.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const phone = await createPhone({
      name: String(body.name ?? ''), brand: String(body.brand ?? ''), model: typeof body.model === 'string' ? body.model : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      categoryId: typeof body.categoryId === 'string' ? body.categoryId : null, cashPriceMinor: Number(body.cashPriceMinor),
      plans: Array.isArray(body.plans) ? (body.plans as Array<Record<string, unknown>>).map((p) => ({ months: Number(p.months), totalPriceMinor: Number(p.totalPriceMinor), depositMinor: Number(p.depositMinor) })) : [],
    }, auth.user.id);
    return NextResponse.json({ phone }, { status: 201 });
  } catch (e) {
    if (e instanceof PhoneStockError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
