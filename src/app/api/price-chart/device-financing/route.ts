import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { allPlans } from '@/lib/services/deviceFinancingPlanService';

/** Every Device Financing phone on sale with its plans, for the price chart agents carry. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'pricechart.view');
  if (!perm.authorized) return perm.error;
  return NextResponse.json({ products: await allPlans() });
}
