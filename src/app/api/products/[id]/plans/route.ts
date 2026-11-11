import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { listPlans, savePlans, PlanError, type PlanInput } from '@/lib/services/deviceFinancingPlanService';

/** A Device Financing phone's price plans: read by whoever sells or prices, set by those who price. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'pricechart.view', 'contract.create');
  if (!perm.authorized) return perm.error;
  return NextResponse.json({ plans: await listPlans((await params).id) });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'pricechart.edit');
  if (!perm.authorized) return perm.error;
  const body = (await req.json().catch(() => ({}))) as { plans?: unknown };
  if (!Array.isArray(body.plans)) return NextResponse.json({ error: 'plans must be a list' }, { status: 400 });
  const plans = (body.plans as Array<Record<string, unknown>>).map((p): PlanInput => ({
    months: Number(p.months), totalPriceMinor: Number(p.totalPriceMinor), depositMinor: Number(p.depositMinor),
  }));
  try {
    return NextResponse.json({ plans: await savePlans((await params).id, plans, auth.user.id) });
  } catch (e) {
    if (e instanceof PlanError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
