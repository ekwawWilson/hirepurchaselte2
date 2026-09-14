import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';

/**
 * The signed-in agent's own deposit/commission ledger — what they have
 * collected in cash on the company's behalf, what they keep as commission,
 * what they still owe, and every remittance they have filed against it
 * (pending, confirmed or rejected). See agentLedgerService.ts.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'agent.ledger.view');
  if (!perm.authorized) return perm.error;

  const entries = await prisma.agentDepositLedger.findMany({
    where: { agentId: auth.user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      contract: { select: { id: true, contractNumber: true, customer: { select: { firstName: true, lastName: true, membershipId: true } } } },
      remittances: { orderBy: { createdAt: 'desc' } },
    },
  });

  const totals = entries.reduce(
    (acc, e) => ({
      depositAmountMinor: acc.depositAmountMinor + e.depositAmountMinor,
      commissionAmountMinor: acc.commissionAmountMinor + e.commissionAmountMinor,
      amountOwedMinor: acc.amountOwedMinor + e.amountOwedMinor,
      amountRemittedMinor: acc.amountRemittedMinor + e.amountRemittedMinor,
    }),
    { depositAmountMinor: 0, commissionAmountMinor: 0, amountOwedMinor: 0, amountRemittedMinor: 0 },
  );

  return NextResponse.json({ entries, totals });
}
