import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { commissionForContract } from './commissionSettingsService';
import { AGENT_CASH_HOLD_ALERT_DAYS } from '../constants/agents';

export class AgentLedgerError extends Error {}

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/**
 * What an agent and the office owe each other on one contract the agent
 * brought in — re-derived from the payments, remittances and payouts every
 * time any of them changes, never adjusted by hand:
 *
 *  - cash collected: every effective cash payment on the contract recorded
 *    as taken by the agent (Payment.collectedByAgentId). A part-deposit, a
 *    second part, an instalment the agent collected — all of it; a payment
 *    later reversed drops out, as does everything when a cancellation
 *    unwinds the deposit.
 *  - commission: earned on a Deposit + Instalment sale once its deposit has
 *    been paid in full, however it was paid — cash to the agent, cash at the
 *    counter or mobile money. The rate is fixed the first time it is earned;
 *    the commission falls back to nothing if the deposit is later unwound.
 *
 * Called inside the transaction that changed the money, so the ledger can
 * never be seen disagreeing with it. A no-op for a contract no AGENT created.
 */
export async function syncAgentLedger(tx: Db, contractId: string): Promise<void> {
  const contract = await tx.contract.findUniqueOrThrow({
    where: { id: contractId },
    select: {
      id: true, contractType: true, activatedAt: true, depositAmountMinor: true, createdById: true,
      createdBy: { select: { role: { select: { name: true } } } },
    },
  });
  if (contract.createdBy.role.name !== 'AGENT') return;

  const payments = await effectivePayments(tx, contractId);
  const cashCollected = payments
    .filter((p) => p.channel === 'CASH' && p.collectedByAgentId === contract.createdById && p.entryType !== 'WITHDRAWAL')
    .reduce((sum, p) => sum + p.amountMinor, 0);
  const depositPaid = payments.filter((p) => p.entryType === 'DEPOSIT').reduce((sum, p) => sum + p.amountMinor, 0);
  const earned = contract.contractType === 'DEPOSIT_INSTALMENT' && contract.activatedAt !== null && depositPaid >= contract.depositAmountMinor;

  const existing = await tx.agentDepositLedger.findUnique({ where: { contractId } });
  if (!existing && cashCollected === 0 && !earned) return;

  let rate = existing?.commissionRateMinor ?? null;
  let categoryName = existing?.commissionCategoryName ?? null;
  if (earned && rate === null) {
    const applicable = await commissionForContract(tx, contractId);
    rate = applicable.commissionMinor;
    categoryName = applicable.categoryName;
  }
  const commission = earned ? rate ?? 0 : 0;
  const owed = cashCollected - commission;
  const remitted = existing?.amountRemittedMinor ?? 0;
  const paidOut = existing?.commissionPaidMinor ?? 0;
  const data = {
    depositAmountMinor: cashCollected,
    commissionAmountMinor: commission,
    commissionRateMinor: rate,
    commissionCategoryName: categoryName,
    amountOwedMinor: owed,
    status: statusFor(owed - remitted + paidOut),
  };
  await tx.agentDepositLedger.upsert({
    where: { contractId },
    create: { contractId, agentId: contract.createdById, ...data },
    update: data,
  });
}

/** Positive: the agent owes the office. Negative: the office owes the agent. */
export function ledgerBalance(entry: { amountOwedMinor: number; amountRemittedMinor: number; commissionPaidMinor: number }): number {
  return entry.amountOwedMinor - entry.amountRemittedMinor + entry.commissionPaidMinor;
}

function statusFor(balance: number): 'OWED' | 'DUE_TO_AGENT' | 'SETTLED' {
  return balance > 0 ? 'OWED' : balance < 0 ? 'DUE_TO_AGENT' : 'SETTLED';
}

/** Successful payments that count: not a reversal row, and not themselves reversed. */
async function effectivePayments(db: Db, contractId: string) {
  const payments = await db.payment.findMany({
    where: { contractId, status: 'SUCCESS' },
    select: { id: true, amountMinor: true, channel: true, entryType: true, collectedByAgentId: true, reversesPaymentId: true, receivedAt: true, createdAt: true },
  });
  const reversed = new Set(payments.map((p) => p.reversesPaymentId).filter((id): id is string => !!id));
  return payments.filter((p) => !p.reversesPaymentId && !reversed.has(p.id));
}

export const REMITTANCE_METHODS = ['CASH', 'MOBILE_MONEY', 'BANK_TRANSFER'] as const;
export type RemittanceMethod = (typeof REMITTANCE_METHODS)[number];

/**
 * The agent's claim that they have paid some of what they owe on one ledger
 * entry — cash handed over at the branch, or a mobile money/bank transfer
 * made outside this app and reported here with a reference. Sits PENDING
 * until confirmRemittance below actually applies it; nothing here touches
 * the ledger's own running totals yet.
 */
export async function fileRemittance(params: {
  ledgerId: string;
  agentId: string;
  amountMinor: number;
  method: RemittanceMethod;
  reference?: string;
}) {
  if (!Number.isInteger(params.amountMinor) || params.amountMinor <= 0) throw new AgentLedgerError('amountMinor must be positive');
  if (!REMITTANCE_METHODS.includes(params.method)) {
    throw new AgentLedgerError(`method must be one of: ${REMITTANCE_METHODS.join(', ')}`);
  }

  const ledger = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { id: params.ledgerId } });
  if (ledger.agentId !== params.agentId) throw new AgentLedgerError('This ledger entry does not belong to you');
  const balance = ledgerBalance(ledger);
  if (balance <= 0) throw new AgentLedgerError('You owe nothing on this entry');

  // Claims still waiting count against what is owed, so an agent can't file
  // two overlapping claims that together overshoot it.
  const pending = await prisma.agentRemittance.aggregate({
    where: { ledgerId: ledger.id, status: 'PENDING' },
    _sum: { amountMinor: true },
  });
  const remaining = balance - (pending._sum.amountMinor ?? 0);
  if (params.amountMinor > remaining) {
    throw new AgentLedgerError(`You owe at most GHS ${(Math.max(0, remaining) / 100).toFixed(2)} more on this entry, once any pending claims are counted`);
  }

  return prisma.agentRemittance.create({
    data: {
      ledgerId: ledger.id,
      agentId: params.agentId,
      amountMinor: params.amountMinor,
      method: params.method,
      reference: params.reference?.trim() || null,
    },
  });
}

/** Whether `user` may act on an entry for this agent: same branch, or a user who covers every branch. */
async function assertSameBranch(db: Db, agentId: string, userBranchId: string | null) {
  if (!userBranchId) return;
  const agent = await db.user.findUniqueOrThrow({ where: { id: agentId }, select: { branchId: true } });
  if (agent.branchId !== userBranchId) throw new AgentLedgerError('This agent belongs to another branch', );
}

/**
 * An approver (agent.ledger.manage) checks a filed remittance against what
 * actually arrived (cash counted, or the mobile money/bank statement) and
 * confirms or rejects it. Only confirming moves the ledger's own totals — a
 * rejected claim leaves it untouched, exactly as if it had never been filed.
 * Limited to agents in the approver's own branch.
 */
export async function confirmRemittance(params: { remittanceId: string; confirmedById: string; confirmerBranchId: string | null }) {
  return prisma.$transaction(async (tx) => {
    const remittance = await tx.agentRemittance.findUniqueOrThrow({ where: { id: params.remittanceId } });
    await assertSameBranch(tx, remittance.agentId, params.confirmerBranchId);
    // Claimed on its PENDING status, so two approvers cannot both apply it.
    const claimed = await tx.agentRemittance.updateMany({
      where: { id: remittance.id, status: 'PENDING' },
      data: { status: 'CONFIRMED', confirmedById: params.confirmedById, confirmedAt: new Date() },
    });
    if (claimed.count === 0) throw new AgentLedgerError(`This remittance was already ${remittance.status.toLowerCase()}`);

    await tx.agentDepositLedger.update({
      where: { id: remittance.ledgerId },
      data: { amountRemittedMinor: { increment: remittance.amountMinor } },
    });
    const ledger = await tx.agentDepositLedger.findUniqueOrThrow({ where: { id: remittance.ledgerId } });
    await syncAgentLedger(tx, ledger.contractId);
    return tx.agentRemittance.findUniqueOrThrow({ where: { id: remittance.id } });
  });
}

export async function rejectRemittance(params: { remittanceId: string; confirmedById: string; confirmerBranchId: string | null; reason: string }) {
  const remittance = await prisma.agentRemittance.findUniqueOrThrow({ where: { id: params.remittanceId } });
  await assertSameBranch(prisma, remittance.agentId, params.confirmerBranchId);
  if (remittance.status !== 'PENDING') throw new AgentLedgerError(`This remittance was already ${remittance.status.toLowerCase()}`);
  if (!params.reason.trim()) throw new AgentLedgerError('A reason is required');

  return prisma.agentRemittance.update({
    where: { id: remittance.id },
    data: { status: 'REJECTED', rejectionReason: params.reason.trim(), confirmedById: params.confirmedById, confirmedAt: new Date() },
  });
}

/**
 * The office paying an agent commission it owes them on one entry — where
 * the commission earned is more than the cash they held. Never more than is
 * owed to them.
 */
export async function payCommission(params: {
  ledgerId: string; amountMinor: number; method: RemittanceMethod; reference?: string; paidById: string; payerBranchId: string | null;
}) {
  if (!Number.isInteger(params.amountMinor) || params.amountMinor <= 0) throw new AgentLedgerError('amountMinor must be positive');
  if (!REMITTANCE_METHODS.includes(params.method)) throw new AgentLedgerError(`method must be one of: ${REMITTANCE_METHODS.join(', ')}`);
  return prisma.$transaction(async (tx) => {
    const ledger = await tx.agentDepositLedger.findUniqueOrThrow({ where: { id: params.ledgerId } });
    await assertSameBranch(tx, ledger.agentId, params.payerBranchId);
    const due = -ledgerBalance(ledger);
    if (due <= 0) throw new AgentLedgerError('Nothing is owed to the agent on this entry');
    if (params.amountMinor > due) throw new AgentLedgerError(`At most GHS ${(due / 100).toFixed(2)} is owed to the agent on this entry`);

    const payout = await tx.agentCommissionPayout.create({
      data: {
        ledgerId: ledger.id, agentId: ledger.agentId, amountMinor: params.amountMinor, method: params.method,
        reference: params.reference?.trim() || null, paidById: params.paidById,
      },
    });
    await tx.agentDepositLedger.update({ where: { id: ledger.id }, data: { commissionPaidMinor: { increment: params.amountMinor } } });
    await syncAgentLedger(tx, ledger.contractId);
    return payout;
  });
}

export { AGENT_CASH_HOLD_ALERT_DAYS };

/**
 * Since when an agent has been holding cash they still owe on one entry:
 * collections are counted oldest first against what they have remitted, and
 * the first one not yet fully covered is when the oldest unremitted cash
 * came into their hand. Null when they hold none.
 */
export async function cashHeldSince(db: Db, entry: { contractId: string; agentId: string; amountRemittedMinor: number; amountOwedMinor: number; commissionPaidMinor: number }): Promise<Date | null> {
  if (ledgerBalance(entry) <= 0) return null;
  const collections = (await effectivePayments(db, entry.contractId))
    .filter((p) => p.channel === 'CASH' && p.collectedByAgentId === entry.agentId && p.entryType !== 'WITHDRAWAL')
    .map((p) => ({ amount: p.amountMinor, at: p.receivedAt ?? p.createdAt }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  // What the agent keeps (their commission) and has paid in both cover the oldest cash first.
  let covered = entry.amountRemittedMinor + (collections.reduce((s, c) => s + c.amount, 0) - entry.amountOwedMinor) - entry.commissionPaidMinor;
  for (const c of collections) {
    if (covered >= c.amount) { covered -= c.amount; continue; }
    return c.at;
  }
  return null;
}

/** Ledger entries with what is owed either way and how long cash has been held — for the agent's and the approver's screens. */
export async function ledgerEntriesWithBalances<T extends { contractId: string; agentId: string; amountRemittedMinor: number; amountOwedMinor: number; commissionPaidMinor: number }>(entries: T[]) {
  return Promise.all(entries.map(async (e) => {
    const balance = ledgerBalance(e);
    const heldSince = await cashHeldSince(prisma, e);
    return {
      ...e,
      balanceMinor: balance,
      agentOwesMinor: Math.max(0, balance),
      owedToAgentMinor: Math.max(0, -balance),
      cashHeldSince: heldSince,
      daysHeld: heldSince ? Math.floor((Date.now() - heldSince.getTime()) / 86_400_000) : null,
    };
  }));
}

/**
 * Raises an alert for every agent holding cash longer than
 * AGENT_CASH_HOLD_ALERT_DAYS — one per agent, however many contracts.
 * Run daily.
 */
export async function alertLongHeldAgentCash(): Promise<number> {
  const { raiseAlert } = await import('./alertService');
  const owing = await prisma.agentDepositLedger.findMany({
    where: { status: 'OWED' },
    include: { agent: { select: { id: true, firstName: true, lastName: true } } },
  });
  const byAgent = new Map<string, { name: string; heldMinor: number; oldest: Date }>();
  for (const e of owing) {
    const since = await cashHeldSince(prisma, e);
    if (!since || Date.now() - since.getTime() < AGENT_CASH_HOLD_ALERT_DAYS * 86_400_000) continue;
    const entry = byAgent.get(e.agentId) ?? { name: `${e.agent.firstName} ${e.agent.lastName}`, heldMinor: 0, oldest: since };
    entry.heldMinor += ledgerBalance(e);
    if (since < entry.oldest) entry.oldest = since;
    byAgent.set(e.agentId, entry);
  }
  for (const [agentId, a] of byAgent) {
    const days = Math.floor((Date.now() - a.oldest.getTime()) / 86_400_000);
    await raiseAlert({
      kind: 'AGENT_CASH_HELD',
      message: `Agent ${a.name} has held GHS ${(a.heldMinor / 100).toFixed(2)} of customers' cash for up to ${days} days without paying it in. See Agent Ledger.`,
      dedupeKey: `agent-cash-held:${agentId}`,
    });
  }
  return byAgent.size;
}

/** What an agent still owes the office, and the office them, across every entry — checked before deactivating them. */
export async function agentOutstanding(agentId: string): Promise<{ agentOwesMinor: number; owedToAgentMinor: number }> {
  const entries = await prisma.agentDepositLedger.findMany({ where: { agentId, status: { not: 'SETTLED' } } });
  return entries.reduce((acc, e) => {
    const b = ledgerBalance(e);
    return { agentOwesMinor: acc.agentOwesMinor + Math.max(0, b), owedToAgentMinor: acc.owedToAgentMinor + Math.max(0, -b) };
  }, { agentOwesMinor: 0, owedToAgentMinor: 0 });
}

/**
 * Who took a cash payment being recorded now, for the agent ledger:
 *  - an AGENT recording it themselves collected it (and may only record on
 *    their own contracts — checked by the route);
 *  - anyone else records it as taken at the counter, unless they say the
 *    agent who brought the contract in collected it and is handing it over.
 */
export async function cashCollectorFor(params: { contractCreatedById: string; recorder: { id: string; roleName: string }; collectedByAgent?: unknown }): Promise<string | undefined> {
  if (params.recorder.roleName === 'AGENT') return params.recorder.id;
  if (params.collectedByAgent !== true) return undefined;
  const creator = await prisma.user.findUnique({ where: { id: params.contractCreatedById }, select: { role: { select: { name: true } } } });
  if (creator?.role.name !== 'AGENT') throw new AgentLedgerError('Only a contract an agent brought in can have its cash collected by the agent');
  return params.contractCreatedById;
}
