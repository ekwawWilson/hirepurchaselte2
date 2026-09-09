import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { postDeviceLoanPayment, PaymentError } from '@/lib/services/paymentService';
import { logAudit } from '@/lib/services/auditService';

/**
 * DEVICE_LOAN's own payment route — postPayment (the generic /payments/cash
 * one) refuses this contract type outright (paymentService.ts). Only two
 * exact amounts are ever valid: the currently accrued interest, or the full
 * loan amount — see postDeviceLoanPayment.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.cash.record');
  if (!perm.authorized) return perm.error;

  const { contractId, amountMinor, option, transactionRef } = (await req.json()) as Record<string, unknown>;

  if (!contractId || typeof amountMinor !== 'number' || amountMinor <= 0) {
    return NextResponse.json({ error: 'contractId and a positive amountMinor are required' }, { status: 400 });
  }
  if (option !== 'INTEREST' && option !== 'PRINCIPAL') {
    return NextResponse.json({ error: 'option must be INTEREST or PRINCIPAL' }, { status: 400 });
  }

  const contract = await prisma.contract.findUnique({ where: { id: contractId as string } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const result = await postDeviceLoanPayment({
      contractId: contractId as string,
      amountMinor,
      option: option as 'INTEREST' | 'PRINCIPAL',
      channel: 'CASH',
      transactionRef: transactionRef as string | undefined,
      createdById: auth.user.id,
    });
    await logAudit({
      userId: auth.user.id, action: 'PAYMENT_CASH_RECORD', entityType: 'Payment', entityId: result.payment.id,
      newValues: { contractId, amountMinor, option },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
