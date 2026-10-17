import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { ledgerEntriesWithBalances } from '@/lib/services/agentLedgerService';

/**
 * The signed-in agent's own ledger — the cash they have collected on the
 * company's behalf, the commission they have earned, what they owe the
 * office or the office owes them, how long they have held cash, and every remittance they have filed against it
 * (pending, confirmed or rejected). See agentLedgerService.ts.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'agent.ledger.view');
  if (!perm.authorized) return perm.error;

  const rows = await prisma.agentDepositLedger.findMany({
    where: { agentId: auth.user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      contract: { select: { id: true, contractNumber: true, status: true, customer: { select: { firstName: true, lastName: true, membershipId: true } } } },
      remittances: { orderBy: { createdAt: 'desc' } },
      payouts: { orderBy: { createdAt: 'desc' } },
    },
  });
  const entries = await ledgerEntriesWithBalances(rows);

  const totals = entries.reduce(
    (acc, e) => ({
      depositAmountMinor: acc.depositAmountMinor + e.depositAmountMinor,
      commissionAmountMinor: acc.commissionAmountMinor + e.commissionAmountMinor,
      amountRemittedMinor: acc.amountRemittedMinor + e.amountRemittedMinor,
      commissionPaidMinor: acc.commissionPaidMinor + e.commissionPaidMinor,
      agentOwesMinor: acc.agentOwesMinor + e.agentOwesMinor,
      owedToAgentMinor: acc.owedToAgentMinor + e.owedToAgentMinor,
    }),
    { depositAmountMinor: 0, commissionAmountMinor: 0, amountRemittedMinor: 0, commissionPaidMinor: 0, agentOwesMinor: 0, owedToAgentMinor: 0 },
  );

  return NextResponse.json({ entries, totals });
}
