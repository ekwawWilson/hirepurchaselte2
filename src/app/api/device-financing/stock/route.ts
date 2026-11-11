import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { listPhoneStock, receivePhones, PhoneStockError } from '@/lib/services/phoneStockService';
import { StockAssignmentError } from '@/lib/services/stockAssignmentService';

/** Device Financing phone stock. An agent sees the phones assigned to them. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.view');
  if (!perm.authorized) return perm.error;
  const p = req.nextUrl.searchParams;
  const enrolment = p.get('enrolment');
  return NextResponse.json(await listPhoneStock(auth.user, {
    productId: p.get('productId') ?? undefined, status: p.get('status') ?? undefined, agentId: p.get('agentId') ?? undefined, q: p.get('q') ?? undefined,
    enrolment: enrolment === 'ENROLLED' || enrolment === 'NOT_ENROLLED' ? enrolment : undefined, page: Number(p.get('page') ?? '1') || 1,
  }));
}

/** Receives one phone or a batch, optionally straight to an agent, and enrols them with PayTrigger. */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.receive');
  if (!perm.authorized) return perm.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const branchId = auth.user.branchId ?? (typeof body.branchId === 'string' ? body.branchId : null);
  if (!branchId) return NextResponse.json({ error: 'Choose the branch the phones are received into' }, { status: 400 });
  const imeis = Array.isArray(body.imeis) ? (body.imeis as unknown[]).map(String) : typeof body.imeis === 'string' ? body.imeis : '';
  try {
    const result = await receivePhones({
      productId: String(body.productId ?? ''), branchId, imeis, agentId: typeof body.agentId === 'string' && body.agentId ? body.agentId : null,
      description: typeof body.description === 'string' ? body.description : undefined, actor: { id: auth.user.id, branchId: auth.user.branchId },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof PhoneStockError) return NextResponse.json({ error: e.message, serials: e.serials }, { status: e.serials.length > 0 ? 409 : 400 });
    if (e instanceof StockAssignmentError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
