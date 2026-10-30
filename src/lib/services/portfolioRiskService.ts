import { prisma } from '../db/prisma';
import { INSTALMENT_SALE_TYPES } from '../constants/contracts';

/**
 * Portfolio at risk, per agent: the share of what an agent's customers still
 * owe that sits on contracts more than 30 days behind (PAR30), and on any
 * contract behind at all (PAR1, the early warning). One calculation, read by
 * the sale block (saleChecksService), the report and the dashboards, so an
 * agent is never told one figure and judged on another.
 *
 * Thirty days, not "any overdue instalment": phones lock the day after a
 * missed due date and most customers pay within days, so "any overdue"
 * overstates the risk and ranks agents wrongly.
 */

const DAY = 24 * 60 * 60 * 1000;
const LIVE_STATUSES = ['ACTIVE', 'DEFAULTED'];

export interface AgentPortfolioRisk {
  agentId: string;
  agentName: string;
  contracts: number;
  outstandingMinor: number;
  par30Contracts: number;
  par30Minor: number;
  /** Percent, one decimal. 0 when nothing is outstanding. */
  par30Percent: number;
  par1Contracts: number;
  par1Minor: number;
  par1Percent: number;
}

const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);

/** Every agent's PAR (or just those named), largest PAR30 first. */
export async function getAgentPortfolioRisk(opts: { agentIds?: string[]; branchId?: string | null; now?: Date } = {}): Promise<AgentPortfolioRisk[]> {
  const now = opts.now ?? new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY);
  const yesterday = new Date(now.getTime() - DAY);
  const agents = await prisma.user.findMany({
    where: { role: { name: 'AGENT' }, ...(opts.agentIds && { id: { in: opts.agentIds } }), ...(opts.branchId && { branchId: opts.branchId }) },
    select: { id: true, firstName: true, lastName: true },
  });
  const contracts = await prisma.contract.findMany({
    where: {
      createdById: { in: agents.map((a) => a.id) },
      contractType: { in: INSTALMENT_SALE_TYPES },
      status: { in: LIVE_STATUSES },
      balanceMinor: { gt: 0 },
    },
    select: {
      createdById: true, balanceMinor: true,
      // The oldest instalment still unpaid says how far behind the contract is.
      instalments: { where: { status: { not: 'PAID' } }, orderBy: { dueDate: 'asc' }, take: 1, select: { dueDate: true } },
    },
  });

  return agents.map((a) => {
    const book = contracts.filter((c) => c.createdById === a.id);
    const behindSince = (c: (typeof book)[number]) => c.instalments[0]?.dueDate ?? null;
    const par30 = book.filter((c) => { const d = behindSince(c); return !!d && d < thirtyDaysAgo; });
    const par1 = book.filter((c) => { const d = behindSince(c); return !!d && d < yesterday; });
    const sum = (list: typeof book) => list.reduce((s, c) => s + (c.balanceMinor ?? 0), 0);
    const outstandingMinor = sum(book);
    return {
      agentId: a.id,
      agentName: `${a.firstName} ${a.lastName}`,
      contracts: book.length,
      outstandingMinor,
      par30Contracts: par30.length,
      par30Minor: sum(par30),
      par30Percent: percent(sum(par30), outstandingMinor),
      par1Contracts: par1.length,
      par1Minor: sum(par1),
      par1Percent: percent(sum(par1), outstandingMinor),
    };
  }).sort((x, y) => y.par30Percent - x.par30Percent || y.par30Minor - x.par30Minor);
}
