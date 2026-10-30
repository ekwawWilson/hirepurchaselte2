import { prisma } from '../db/prisma';
import { logAudit } from './auditService';
import { commissionForContract, getCommissionSettings } from './commissionSettingsService';

/**
 * Split commission. An agent keeps their commission out of the deposit at
 * sale (agentLedgerService); management may also hold part back, and add a
 * bonus, paid once the customer completes, so an agent is paid more for
 * sales that are paid off. The amounts are copied onto the sale when it is
 * approved: a later change of rates re-prices nothing.
 *
 * Only "paid" is stored. Everything else follows the contract, so the code
 * that completes, defaults or cancels contracts knows nothing of this.
 */

export class CompletionCommissionError extends Error {}

export type CompletionStatus = 'PENDING' | 'PAYABLE' | 'ON_HOLD' | 'FORFEITED' | 'PAID';

export function completionStatus(row: { status: string }, contractStatus: string): CompletionStatus {
  if (row.status === 'PAID') return 'PAID';
  if (contractStatus === 'COMPLETED') return 'PAYABLE';
  if (contractStatus === 'DEFAULTED') return 'ON_HOLD';
  if (contractStatus === 'CANCELLED' || contractStatus === 'WRITTEN_OFF') return 'FORFEITED';
  return 'PENDING';
}

/**
 * Records what is owed on completion for an agent's approved sale, if the
 * settings hold anything back or add a bonus. Once per contract; never
 * fails the approval it follows.
 */
export async function accrueCompletionCommission(contractId: string): Promise<void> {
  try {
    const contract = await prisma.contract.findUnique({ where: { id: contractId }, select: { createdById: true, createdBy: { select: { role: { select: { name: true } } } } } });
    if (!contract || contract.createdBy.role.name !== 'AGENT') return;
    const settings = await getCommissionSettings();
    const total = settings.deferredCommissionMinor + settings.completionBonusMinor;
    if (total <= 0) return;
    const upfront = await commissionForContract(prisma, contractId);
    await prisma.agentCompletionCommission.upsert({
      where: { contractId },
      create: {
        contractId, agentId: contract.createdById, upfrontMinor: upfront.commissionMinor,
        deferredMinor: settings.deferredCommissionMinor, bonusMinor: settings.completionBonusMinor, totalMinor: total,
      },
      update: {},
    });
  } catch (e) {
    console.error('Completion commission not recorded (non-blocking):', e);
  }
}

export interface CompletionCommissionRow {
  id: string;
  contractId: string;
  contractNumber: string;
  contractStatus: string;
  completedAt: Date | null;
  customerName: string;
  agentId: string;
  agentName: string;
  upfrontMinor: number;
  deferredMinor: number;
  bonusMinor: number;
  totalMinor: number;
  status: CompletionStatus;
  paidAt: Date | null;
  reference: string | null;
  /** Marked paid, but the contract is no longer completed (a payment was reversed): check it. */
  needsReview: boolean;
}

/** Every completion commission in scope, with totals per status. */
export async function listCompletionCommissions(filter: { branchId?: string | null; agentId?: string; status?: CompletionStatus; completedMonth?: string }) {
  const rows = await prisma.agentCompletionCommission.findMany({
    where: {
      ...(filter.agentId && { agentId: filter.agentId }),
    },
    orderBy: { createdAt: 'desc' },
    take: 2000,
  });
  const contracts = await prisma.contract.findMany({
    where: { id: { in: rows.map((r) => r.contractId) }, ...(filter.branchId && { branchId: filter.branchId }) },
    select: { id: true, contractNumber: true, status: true, completedAt: true, customer: { select: { firstName: true, lastName: true } }, createdBy: { select: { firstName: true, lastName: true } } },
  });
  const byId = new Map(contracts.map((c) => [c.id, c]));
  const all: CompletionCommissionRow[] = rows.flatMap((r) => {
    const c = byId.get(r.contractId);
    if (!c) return [];
    const status = completionStatus(r, c.status);
    return [{
      id: r.id, contractId: r.contractId, contractNumber: c.contractNumber, contractStatus: c.status, completedAt: c.completedAt,
      customerName: `${c.customer.firstName} ${c.customer.lastName}`, agentId: r.agentId, agentName: `${c.createdBy.firstName} ${c.createdBy.lastName}`,
      upfrontMinor: r.upfrontMinor, deferredMinor: r.deferredMinor, bonusMinor: r.bonusMinor, totalMinor: r.totalMinor,
      status, paidAt: r.paidAt, reference: r.reference, needsReview: r.status === 'PAID' && c.status !== 'COMPLETED',
    }];
  });
  const month = filter.completedMonth; // YYYY-MM
  const shown = all.filter((r) => (!filter.status || r.status === filter.status)
    && (!month || (r.completedAt !== null && r.completedAt.toISOString().slice(0, 7) === month)));
  const totals = Object.fromEntries((['PENDING', 'PAYABLE', 'ON_HOLD', 'FORFEITED', 'PAID'] as const).map((s) => {
    const inStatus = all.filter((r) => r.status === s);
    return [s, { count: inStatus.length, totalMinor: inStatus.reduce((t, r) => t + r.totalMinor, 0) }];
  })) as Record<CompletionStatus, { count: number; totalMinor: number }>;
  return { rows: shown, totals };
}

/** Records that finance paid it, with their reference. Only once the customer has completed. */
export async function markCompletionCommissionPaid(id: string, reference: string, actorId: string) {
  if (!reference.trim()) throw new CompletionCommissionError('Enter the payment reference');
  const row = await prisma.agentCompletionCommission.findUnique({ where: { id } });
  if (!row) throw new CompletionCommissionError('Completion commission not found');
  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: row.contractId }, select: { status: true } });
  const status = completionStatus(row, contract.status);
  if (status !== 'PAYABLE') throw new CompletionCommissionError(`Only a payable commission can be marked paid (this one is ${status.toLowerCase().replace('_', ' ')})`);
  await prisma.agentCompletionCommission.update({ where: { id }, data: { status: 'PAID', paidAt: new Date(), paidById: actorId, reference: reference.trim() } });
  await logAudit({ userId: actorId, action: 'COMPLETION_COMMISSION_PAID', entityType: 'AgentCompletionCommission', entityId: id, newValues: { reference: reference.trim(), totalMinor: row.totalMinor } });
}

/** Undoes "paid", for one recorded in error. */
export async function undoCompletionCommissionPaid(id: string, actorId: string) {
  const row = await prisma.agentCompletionCommission.findUnique({ where: { id } });
  if (!row || row.status !== 'PAID') throw new CompletionCommissionError('Only a commission marked paid can be undone');
  await prisma.agentCompletionCommission.update({ where: { id }, data: { status: 'ACCRUED', paidAt: null, paidById: null, reference: null } });
  await logAudit({ userId: actorId, action: 'COMPLETION_COMMISSION_UNPAID', entityType: 'AgentCompletionCommission', entityId: id, oldValues: { reference: row.reference } });
}

/** An agent's own figures: still to come when customers complete, and ready to be paid. */
export async function agentCompletionSummary(agentId: string) {
  const { totals } = await listCompletionCommissions({ agentId });
  return {
    dueOnCompletion: { count: totals.PENDING.count + totals.ON_HOLD.count, totalMinor: totals.PENDING.totalMinor + totals.ON_HOLD.totalMinor },
    payable: totals.PAYABLE,
    paid: totals.PAID,
  };
}
