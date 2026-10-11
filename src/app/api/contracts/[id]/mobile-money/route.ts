import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess, assertOwnRecordAccess } from '@/lib/auth/rbac';
import { initiateHubtelPayment, mobileMoneyRequestProblem, HubtelError } from '@/lib/services/hubtelPaymentService';
import { assertPaymentsAcceptedToday, PaymentsClosedError } from '@/lib/services/operatingSettingsService';
import { MOBILE_MONEY_NETWORKS } from '@/lib/constants/contracts';
import { logAudit } from '@/lib/services/auditService';

/**
 * Staff sending the customer a mobile money prompt for this contract — the
 * counter's version of what the customer can do for themselves in the portal
 * or by USSD, through the same initiateHubtelPayment, so the callback posts
 * it to the ledger the same way. The prompt only ever goes to a number already
 * registered to the customer (mobileMoneyRequestProblem).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.cash.record');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { amountMinor, msisdn, network } = (await req.json().catch(() => ({}))) as {
    amountMinor?: number; msisdn?: string; network?: string;
  };
  if (typeof amountMinor !== 'number' || !Number.isInteger(amountMinor) || amountMinor <= 0) {
    return NextResponse.json({ error: 'A positive amount is required' }, { status: 400 });
  }
  if (!msisdn || !msisdn.trim()) return NextResponse.json({ error: 'A mobile money number is required' }, { status: 400 });
  if (network && !(MOBILE_MONEY_NETWORKS as readonly string[]).includes(network)) {
    return NextResponse.json({ error: `Choose a network: ${MOBILE_MONEY_NETWORKS.join(', ')}` }, { status: 400 });
  }

  const contract = await prisma.contract.findUnique({
    where: { id },
    include: { customer: { select: { phone: true, phone2: true, phone3: true } } },
  });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!assertOwnRecordAccess(auth.user, contract.createdById)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const problem = await mobileMoneyRequestProblem({ contract, customer: contract.customer, amountMinor, msisdn });
  if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });

  try {
    await assertPaymentsAcceptedToday();
    const txn = await initiateHubtelPayment({ contractId: contract.id, msisdn: msisdn.trim(), amountMinor, network });
    await logAudit({
      userId: auth.user.id, action: 'MOBILE_MONEY_PROMPT_SENT', entityType: 'HubtelTransaction', entityId: txn.id,
      newValues: { contractId: contract.id, amountMinor, msisdn: msisdn.trim() },
    });
    return NextResponse.json({ reference: txn.clientReference, status: txn.status }, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentsClosedError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof HubtelError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
