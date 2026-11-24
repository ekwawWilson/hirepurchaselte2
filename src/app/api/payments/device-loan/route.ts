import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess, assertOwnRecordAccess } from '@/lib/auth/rbac';
import { cashCollectorFor, AgentLedgerError } from '@/lib/services/agentLedgerService';
import { postDeviceLoanPayment, PaymentError } from '@/lib/services/paymentService';
import { logAudit } from '@/lib/services/auditService';
import { assertPaymentsAcceptedToday, PaymentsClosedError } from '@/lib/services/operatingSettingsService';

/**
 * DEVICE_LOAN's own payment route — postPayment (the generic /payments/cash
 * one) refuses this contract type outright (paymentService.ts). Only two
 * exact amounts are ever valid: the currently accrued interest, or the full
 * loan amount — see postDeviceLoanPayment.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  // Cash is recorded by an administrator only (payment.cash.take): an agent
  // once recorded cash no customer had paid.
  if (!requirePermission(auth.user, 'payment.cash.take').authorized) return NextResponse.json({ error: 'Only an administrator can record cash. Ask the customer to pay by mobile money, or bring the cash to the office.' }, { status: 403 });

  const { contractId, amountMinor, option, transactionRef, collectedByAgent } = (await req.json()) as Record<string, unknown>;

  if (!contractId || typeof amountMinor !== 'number' || amountMinor <= 0) {
    return NextResponse.json({ error: 'contractId and a positive amountMinor are required' }, { status: 400 });
  }
  if (option !== 'INTEREST' && option !== 'PRINCIPAL') {
    return NextResponse.json({ error: 'option must be INTEREST or PRINCIPAL' }, { status: 400 });
  }

  const contract = await prisma.contract.findUnique({ where: { id: contractId as string } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  // An agent records the cash they collect, on their own contracts only.
  if (!assertOwnRecordAccess(auth.user, contract.createdById)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let collectedByAgentId: string | undefined;
  try {
    collectedByAgentId = await cashCollectorFor({ contractCreatedById: contract.createdById, recorder: { id: auth.user.id, roleName: auth.user.roleName }, collectedByAgent });
  } catch (e) {
    if (e instanceof AgentLedgerError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  try {
    await assertPaymentsAcceptedToday();
    const result = await postDeviceLoanPayment({
      contractId: contractId as string,
      amountMinor,
      option: option as 'INTEREST' | 'PRINCIPAL',
      channel: 'CASH',
      transactionRef: transactionRef as string | undefined,
      createdById: auth.user.id,
      collectedByAgentId,
    });
    await logAudit({
      userId: auth.user.id, action: 'PAYMENT_CASH_RECORD', entityType: 'Payment', entityId: result.payment.id,
      newValues: { contractId, amountMinor, option, collectedByAgentId: collectedByAgentId ?? null },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentsClosedError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof PaymentError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
