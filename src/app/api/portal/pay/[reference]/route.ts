import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireCustomer } from '@/lib/auth/customerAuth';

/**
 * Where a charge has got to, for the portal to poll after starting one: a
 * live mobile money payment is only confirmed when Hubtel calls back, which
 * takes as long as the customer takes to approve it on their phone.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ reference: string }> }) {
  const auth = await requireCustomer(req);
  if ('error' in auth) return auth.error;

  const txn = await prisma.hubtelTransaction.findFirst({
    where: { clientReference: (await params).reference, contract: { customerId: auth.customer.id } },
    select: { clientReference: true, status: true, amountMinor: true, paymentId: true, contractId: true },
  });
  if (!txn) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });

  // NEEDS_REVIEW means the money was taken but could not be applied
  // automatically (hubtelPaymentService) — never shown to a customer as a
  // failure, or they may pay a second time.
  return NextResponse.json({
    reference: txn.clientReference,
    status: txn.status,
    amountMinor: txn.amountMinor,
    recorded: txn.paymentId !== null,
  });
}
