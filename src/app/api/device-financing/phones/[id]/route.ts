import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { updatePhone, PhoneStockError } from '@/lib/services/phoneStockService';
import { PlanError } from '@/lib/services/deviceFinancingPlanService';

/** Changes a phone model: its details, whether it is still sold, and its plans. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'pricechart.edit');
  if (!perm.authorized) return perm.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  try {
    const phone = await updatePhone((await params).id, {
      name: typeof body.name === 'string' ? body.name : undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
      cashPriceMinor: body.cashPriceMinor === undefined ? undefined : Number(body.cashPriceMinor),
      categoryId: body.categoryId === undefined ? undefined : (body.categoryId as string | null) || null,
      isActive: typeof body.isActive === 'boolean' ? body.isActive : undefined,
      plans: Array.isArray(body.plans) ? (body.plans as Array<Record<string, unknown>>).map((p) => ({ months: Number(p.months), totalPriceMinor: Number(p.totalPriceMinor), depositMinor: Number(p.depositMinor) })) : undefined,
    }, auth.user.id);
    return NextResponse.json({ phone });
  } catch (e) {
    if (e instanceof PhoneStockError || e instanceof PlanError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
