import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { enrolmentCandidates, enrolPhones, PayTriggerError } from '@/lib/paytrigger/admin';

/** TECNO/Infinix/itel stock still to enrol with PayTrigger. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'paytrigger.manage');
  if (!perm.authorized) return perm.error;
  return NextResponse.json({ candidates: await enrolmentCandidates(branchScopeWhere(auth.user).branchId) });
}

/** Enrols the chosen phones: each locks itself when first switched on, until its contract opens it. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'paytrigger.manage');
  if (!perm.authorized) return perm.error;
  const body = (await req.json().catch(() => ({}))) as { inventoryItemIds?: unknown };
  if (!Array.isArray(body.inventoryItemIds) || !body.inventoryItemIds.every((i) => typeof i === 'string')) {
    return NextResponse.json({ error: 'inventoryItemIds must be a list of inventory item ids' }, { status: 400 });
  }
  try {
    return NextResponse.json({ outcomes: await enrolPhones(body.inventoryItemIds as string[], auth.user.id) });
  } catch (e) {
    if (e instanceof PayTriggerError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
