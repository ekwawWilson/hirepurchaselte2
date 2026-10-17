import { prisma } from '../db/prisma';
import { ledgerEntriesWithBalances } from './agentLedgerService';

type Scope = { branchId?: string };

function dayRange(from?: string, to?: string) {
  const start = from ? new Date(new Date(from).setHours(0, 0, 0, 0)) : new Date(new Date().setHours(0, 0, 0, 0));
  const end = to ? new Date(new Date(to).setHours(23, 59, 59, 999)) : new Date(new Date().setHours(23, 59, 59, 999));
  return { start, end };
}

/**
 * One row per agent: what they brought in during the range (submitted,
 * approved, sent back, cancelled), the cash they collected and commission
 * they earned in it, what stands between them and the office now, and how
 * the customers they brought in are paying.
 */
export async function agentPerformanceReport(scope: Scope, from?: string, to?: string) {
  const { start, end } = dayRange(from, to);
  const agents = await prisma.user.findMany({
    where: { role: { name: 'AGENT' }, ...(scope.branchId && { branchId: scope.branchId }) },
    select: { id: true, firstName: true, lastName: true, isActive: true, branch: { select: { name: true } } },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });

  const rows = await Promise.all(agents.map(async (agent) => {
    const [submitted, approved, sentBack, cancelled, pending, collections, earned, ledger, portfolio] = await Promise.all([
      prisma.contract.count({ where: { createdById: agent.id, createdAt: { gte: start, lte: end } } }),
      prisma.contract.count({ where: { createdById: agent.id, approvedAt: { gte: start, lte: end } } }),
      prisma.auditLog.count({ where: { action: 'CONTRACT_REQUEST_REVISION', createdAt: { gte: start, lte: end }, entityId: { in: (await prisma.contract.findMany({ where: { createdById: agent.id }, select: { id: true } })).map((c) => c.id) } } }),
      prisma.contract.count({ where: { createdById: agent.id, status: 'CANCELLED', cancelledAt: { gte: start, lte: end } } }),
      prisma.contract.count({ where: { createdById: agent.id, status: { in: ['PENDING_APPROVAL', 'REVISION_REQUESTED'] } } }),
      prisma.payment.findMany({
        where: { collectedByAgentId: agent.id, status: 'SUCCESS', reversesPaymentId: null, reversedById: null, createdAt: { gte: start, lte: end } },
        select: { amountMinor: true },
      }),
      prisma.agentDepositLedger.aggregate({
        where: { agentId: agent.id, commissionAmountMinor: { gt: 0 }, contract: { activatedAt: { gte: start, lte: end } } },
        _sum: { commissionAmountMinor: true },
      }),
      prisma.agentDepositLedger.findMany({ where: { agentId: agent.id, status: { not: 'SETTLED' } } }),
      prisma.contract.findMany({
        where: { createdById: agent.id, status: { in: ['ACTIVE', 'DEFAULTED', 'PENDING_DEPOSIT'] } },
        select: { status: true, instalments: { where: { status: 'OVERDUE' }, select: { amountDueMinor: true, amountPaidMinor: true } } },
      }),
    ]);
    const balances = await ledgerEntriesWithBalances(ledger);
    const overdueMinor = portfolio.reduce((s, c) => s + c.instalments.reduce((t, i) => t + i.amountDueMinor - i.amountPaidMinor, 0), 0);
    return {
      agentId: agent.id,
      name: `${agent.firstName} ${agent.lastName}`,
      branchName: agent.branch?.name ?? null,
      isActive: agent.isActive,
      submitted, approved, sentBack, cancelled, awaitingDecision: pending,
      cashCollectedMinor: collections.reduce((s, p) => s + p.amountMinor, 0),
      commissionEarnedMinor: earned._sum.commissionAmountMinor ?? 0,
      agentOwesMinor: balances.reduce((s, b) => s + b.agentOwesMinor, 0),
      owedToAgentMinor: balances.reduce((s, b) => s + b.owedToAgentMinor, 0),
      longestHeldDays: balances.reduce<number | null>((m, b) => (b.daysHeld !== null && (m === null || b.daysHeld > m) ? b.daysHeld : m), null),
      liveContracts: portfolio.length,
      contractsInArrears: portfolio.filter((c) => c.status === 'DEFAULTED' || c.instalments.length > 0).length,
      overdueMinor,
    };
  }));

  const sum = (key: 'submitted' | 'approved' | 'cashCollectedMinor' | 'commissionEarnedMinor' | 'agentOwesMinor' | 'owedToAgentMinor' | 'overdueMinor') =>
    rows.reduce((s, r) => s + r[key], 0);
  return {
    range: { start, end },
    rows,
    totals: {
      submitted: sum('submitted'), approved: sum('approved'), cashCollectedMinor: sum('cashCollectedMinor'),
      commissionEarnedMinor: sum('commissionEarnedMinor'), agentOwesMinor: sum('agentOwesMinor'),
      owedToAgentMinor: sum('owedToAgentMinor'), overdueMinor: sum('overdueMinor'),
    },
  };
}
