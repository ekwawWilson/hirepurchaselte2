import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireCustomer } from '@/lib/auth/customerAuth';
import { initiateHubtelPayment, mobileMoneyRequestProblem, HubtelError } from '@/lib/services/hubtelPaymentService';
import { assertPaymentsAcceptedToday, PaymentsClosedError } from '@/lib/services/operatingSettingsService';
import { requestTemporaryUnlock, TemporaryUnlockError } from '@/lib/paytrigger/temporaryUnlock';
import { MOBILE_MONEY_NETWORKS } from '@/lib/constants/contracts';
import { logAudit } from '@/lib/services/auditService';

/**
 * A customer buying a temporary unlock by mobile money: they choose a tier by
 * its percentage, and the server works out the amount. The phone opens when
 * the charge is confirmed (paytrigger/temporaryUnlock.ts).
 */
export async function POST(req: NextRequest) {
  const auth = await requireCustomer(req);
  if ('error' in auth) return auth.error;

  const { contractId, percent, network, msisdn } = (await req.json().catch(() => ({}))) as {
    contractId?: string; percent?: number; network?: string; msisdn?: string;
  };
  if (!contractId || typeof percent !== 'number' || !Number.isInteger(percent)) {
    return NextResponse.json({ error: 'A contract and a tier are required' }, { status: 400 });
  }
  if (network && !(MOBILE_MONEY_NETWORKS as readonly string[]).includes(network)) {
    return NextResponse.json({ error: `Choose a network: ${MOBILE_MONEY_NETWORKS.join(', ')}` }, { status: 400 });
  }
  if (!msisdn || !msisdn.trim()) return NextResponse.json({ error: 'A mobile money number is required' }, { status: 400 });

  const contract = await prisma.contract.findFirst({
    where: { id: contractId, customerId: auth.customer.id },
    include: { customer: { select: { phone: true, phone2: true, phone3: true } } },
  });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });

  try {
    await assertPaymentsAcceptedToday();
    const { clientReference, option } = await requestTemporaryUnlock({ contractId: contract.id, percent, channel: 'APP' });
    const problem = await mobileMoneyRequestProblem({ contract, customer: contract.customer, amountMinor: option.amountMinor - option.chargeMinor, msisdn });
    if (problem) return NextResponse.json({ error: problem.error }, { status: problem.status });
    const txn = await initiateHubtelPayment({ contractId: contract.id, msisdn: msisdn.trim(), amountMinor: option.amountMinor, network, clientReference });
    await logAudit({
      userId: null, action: 'CUSTOMER_TEMPORARY_UNLOCK_INITIATED', entityType: 'HubtelTransaction', entityId: txn.id,
      newValues: { contractId: contract.id, percent, amountMinor: option.amountMinor, network },
    });
    return NextResponse.json({ reference: txn.clientReference, status: txn.status, amountMinor: option.amountMinor, period: option.period }, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentsClosedError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof TemporaryUnlockError || e instanceof HubtelError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
