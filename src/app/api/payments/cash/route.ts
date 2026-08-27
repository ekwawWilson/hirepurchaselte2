import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { postPayment, PaymentError } from '@/lib/services/paymentService';
import { logAudit } from '@/lib/services/auditService';

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.cash.record');
  if (!perm.authorized) return perm.error;

  const { contractId, amountMinor, entryType, notes, transactionRef } = (await req.json()) as Record<string, unknown>;

  if (!contractId || typeof amountMinor !== 'number' || amountMinor <= 0) {
    return NextResponse.json({ error: 'contractId and a positive amountMinor are required' }, { status: 400 });
  }
  const resolvedEntryType = (entryType as string) || 'INSTALMENT_PAYMENT';
  if (!['DEPOSIT', 'INSTALMENT_PAYMENT'].includes(resolvedEntryType)) {
    return NextResponse.json({ error: 'entryType must be DEPOSIT or INSTALMENT_PAYMENT' }, { status: 400 });
  }

  const contract = await prisma.contract.findUnique({ where: { id: contractId as string } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const result = await postPayment({
      contractId: contractId as string,
      amountMinor,
      entryType: resolvedEntryType as 'DEPOSIT' | 'INSTALMENT_PAYMENT',
      channel: 'CASH',
      notes: notes as string | undefined,
      transactionRef: transactionRef as string | undefined,
      createdById: auth.user.id,
    });
    await logAudit({ userId: auth.user.id, action: 'PAYMENT_CASH_RECORD', entityType: 'Payment', entityId: result.payment.id, newValues: { contractId, amountMinor, entryType: resolvedEntryType } });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
