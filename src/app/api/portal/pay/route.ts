import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireCustomer } from '@/lib/auth/customerAuth';
import { getDeviceLoanState } from '@/lib/services/paymentService';
import { initiateHubtelPayment, HubtelError } from '@/lib/services/hubtelPaymentService';
import { assertPaymentsAcceptedToday, PaymentsClosedError } from '@/lib/services/operatingSettingsService';
import { TERMINAL_CONTRACT_STATUSES, MOBILE_MONEY_NETWORKS } from '@/lib/constants/contracts';
import { logAudit } from '@/lib/services/auditService';

/**
 * A customer paying their own contract by mobile money. Everything the
 * request asks for is re-checked here against the contract itself: the
 * portal never decides what may be paid.
 *
 * The charge goes through the same initiateHubtelPayment the USSD flow uses,
 * so the callback posts it to the ledger exactly as a USSD payment — one
 * payment pipeline, whatever the customer used to start it.
 */
export async function POST(req: NextRequest) {
  const auth = await requireCustomer(req);
  if ('error' in auth) return auth.error;

  const { contractId, amountMinor, network, msisdn } = (await req.json().catch(() => ({}))) as {
    contractId?: string; amountMinor?: number; network?: string; msisdn?: string;
  };

  if (!contractId || typeof amountMinor !== 'number' || !Number.isInteger(amountMinor) || amountMinor <= 0) {
    return NextResponse.json({ error: 'A contract and a positive amount are required' }, { status: 400 });
  }
  if (!network || !(MOBILE_MONEY_NETWORKS as readonly string[]).includes(network)) {
    return NextResponse.json({ error: `Choose a network: ${MOBILE_MONEY_NETWORKS.join(', ')}` }, { status: 400 });
  }
  if (!msisdn || !msisdn.trim()) {
    return NextResponse.json({ error: 'A mobile money number is required' }, { status: 400 });
  }

  const contract = await prisma.contract.findFirst({ where: { id: contractId, customerId: auth.customer.id } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (TERMINAL_CONTRACT_STATUSES.includes(contract.status)) {
    return NextResponse.json({ error: `This contract is ${contract.status.toLowerCase()} and takes no further payments` }, { status: 409 });
  }

  // A device loan is only ever paid as one of two exact amounts — the same
  // two the USSD menu offers (paymentService.postDeviceLoanPayment).
  if (contract.contractType === 'DEVICE_LOAN') {
    const state = await getDeviceLoanState(contract.id);
    const isInterest = state.accruedInterestMinor > 0 && amountMinor === state.accruedInterestMinor;
    const isPrincipal = state.principalOutstanding && amountMinor === state.principalMinor;
    if (!isInterest && !isPrincipal) {
      return NextResponse.json({
        error: 'Pay either the interest owed or the full loan amount — a device loan takes no other amount',
      }, { status: 400 });
    }
  }

  try {
    await assertPaymentsAcceptedToday();
    const txn = await initiateHubtelPayment({ contractId: contract.id, msisdn: msisdn.trim(), amountMinor, network });
    await logAudit({
      userId: null, action: 'CUSTOMER_PORTAL_PAYMENT_INITIATED', entityType: 'HubtelTransaction', entityId: txn.id,
      newValues: { contractId: contract.id, amountMinor, network },
    });
    return NextResponse.json({ reference: txn.clientReference, status: txn.status }, { status: 201 });
  } catch (e) {
    if (e instanceof PaymentsClosedError) return NextResponse.json({ error: e.message }, { status: 409 });
    if (e instanceof HubtelError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
