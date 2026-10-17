import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess, assertOwnRecordAccess } from '@/lib/auth/rbac';
import { cashCollectorFor, AgentLedgerError } from '@/lib/services/agentLedgerService';
import { paymentAmountProblem } from '@/lib/services/paymentLimitsService';

/** How recent an identical cash payment by the same person must be to be asked about. */
const DUPLICATE_WINDOW_MS = 2 * 60_000;
import { postPayment, PaymentError } from '@/lib/services/paymentService';
import { logAudit } from '@/lib/services/auditService';
import { assertPaymentsAcceptedToday, PaymentsClosedError } from '@/lib/services/operatingSettingsService';

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.cash.record');
  if (!perm.authorized) return perm.error;

  const { contractId, amountMinor, entryType, notes, transactionRef, collectedByAgent, confirmDuplicate } = (await req.json()) as Record<string, unknown>;

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
  // An agent records the cash they collect, on their own contracts only.
  if (!assertOwnRecordAccess(auth.user, contract.createdById)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // Never more than is owed, and at least the minimum (paymentLimitsService).
  const amountProblem = await paymentAmountProblem(contract.id, amountMinor);
  if (amountProblem) return NextResponse.json({ error: amountProblem }, { status: 400 });

  // The same amount on the same contract by the same person moments ago is
  // far more often a second press than a second payment. A retry of the same
  // submission carries the same transactionRef and is simply recognised
  // (postPayment); anything else is asked about rather than recorded twice.
  if (confirmDuplicate !== true && !(typeof transactionRef === 'string' && await prisma.payment.findUnique({ where: { transactionRef } }))) {
    const recent = await prisma.payment.findFirst({
      where: {
        contractId: contract.id, amountMinor, channel: 'CASH', createdById: auth.user.id, status: 'SUCCESS',
        reversesPaymentId: null, reversedById: null, createdAt: { gte: new Date(Date.now() - DUPLICATE_WINDOW_MS) },
      },
      select: { createdAt: true, receiptNumber: true },
    });
    if (recent) {
      const seconds = Math.max(1, Math.round((Date.now() - recent.createdAt.getTime()) / 1000));
      return NextResponse.json({
        error: `You recorded the same amount on this contract ${seconds} seconds ago (receipt ${recent.receiptNumber}). Record it again only if the customer really paid twice.`,
        code: 'POSSIBLE_DUPLICATE',
      }, { status: 409 });
    }
  }

  let collectedByAgentId: string | undefined;
  try {
    collectedByAgentId = await cashCollectorFor({ contractCreatedById: contract.createdById, recorder: { id: auth.user.id, roleName: auth.user.roleName }, collectedByAgent });
  } catch (e) {
    if (e instanceof AgentLedgerError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  try {
    await assertPaymentsAcceptedToday();
    const result = await postPayment({
      contractId: contractId as string,
      amountMinor,
      entryType: resolvedEntryType as 'DEPOSIT' | 'INSTALMENT_PAYMENT',
      channel: 'CASH',
      notes: notes as string | undefined,
      transactionRef: transactionRef as string | undefined,
      createdById: auth.user.id,
      collectedByAgentId,
    });
    await logAudit({ userId: auth.user.id, action: 'PAYMENT_CASH_RECORD', entityType: 'Payment', entityId: result.payment.id, newValues: { contractId, amountMinor, entryType: resolvedEntryType, collectedByAgentId: collectedByAgentId ?? null } });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentsClosedError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
