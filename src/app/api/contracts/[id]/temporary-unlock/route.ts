import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { getTemporaryUnlockOffer, takeCashForTemporaryUnlock, TemporaryUnlockError } from '@/lib/paytrigger/temporaryUnlock';
import { assertPaymentsAcceptedToday, PaymentsClosedError } from '@/lib/services/operatingSettingsService';
import { PaymentError } from '@/lib/services/paymentService';
import { logAudit } from '@/lib/services/auditService';

async function contractFor(req: NextRequest, params: Promise<{ id: string }>) {
  const auth = await requireAuth(req);
  if ('error' in auth) return { error: auth.error };
  const perm = requirePermission(auth.user, 'payment.cash.record');
  if (!perm.authorized) return { error: perm.error! };
  const contract = await prisma.contract.findUnique({ where: { id: (await params).id }, select: { id: true, branchId: true } });
  if (!contract) return { error: NextResponse.json({ error: 'Contract not found' }, { status: 404 }) };
  if (!assertBranchAccess(auth.user, contract.branchId)) return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  return { user: auth.user, contract };
}

/** What can be offered to this customer now, for the contract page. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await contractFor(req, params);
  if (found.error) return found.error;
  return NextResponse.json({ offer: await getTemporaryUnlockOffer(found.contract.id) });
}

/**
 * Office staff taking cash for a tier. Not for agents: cash an agent holds
 * keeps the phone locked until it is remitted, so it could not open the phone.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await contractFor(req, params);
  if (found.error) return found.error;
  if (found.user.roleName === 'AGENT') return NextResponse.json({ error: 'A temporary unlock for cash is taken at the office' }, { status: 403 });
  const { percent } = (await req.json().catch(() => ({}))) as { percent?: number };
  if (typeof percent !== 'number' || !Number.isInteger(percent)) return NextResponse.json({ error: 'Choose a tier' }, { status: 400 });

  try {
    await assertPaymentsAcceptedToday();
    const { payment, option } = await takeCashForTemporaryUnlock({ contractId: found.contract.id, percent, userId: found.user.id });
    await logAudit({ userId: found.user.id, action: 'PAYMENT_CASH_RECORD', entityType: 'Payment', entityId: payment.id, newValues: { contractId: found.contract.id, amountMinor: option.amountMinor, temporaryUnlockPercent: percent } });
    return NextResponse.json({ payment, option }, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentsClosedError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof TemporaryUnlockError || e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
