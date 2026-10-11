import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess, assertOwnRecordAccess } from '@/lib/auth/rbac';

/**
 * Where a prompt sent from this contract has got to, for the page to poll: a
 * live charge is only confirmed when Hubtel calls back, which takes as long
 * as the customer takes to approve it on their phone.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; reference: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.cash.record', 'payment.view');
  if (!perm.authorized) return perm.error;

  const { id, reference } = await params;
  const txn = await prisma.hubtelTransaction.findFirst({
    where: { clientReference: reference, contractId: id },
    select: { clientReference: true, status: true, amountMinor: true, paymentId: true, contract: { select: { branchId: true, createdById: true } } },
  });
  if (!txn) return NextResponse.json({ error: 'Payment not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, txn.contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!assertOwnRecordAccess(auth.user, txn.contract.createdById)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  return NextResponse.json({
    reference: txn.clientReference, status: txn.status, amountMinor: txn.amountMinor, recorded: txn.paymentId !== null,
  });
}
