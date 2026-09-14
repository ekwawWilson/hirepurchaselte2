import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { getCommissionSettings } from './commissionSettingsService';

export class AgentLedgerError extends Error {}

type Tx = Prisma.TransactionClient;

/**
 * Called from inside postPayment's own transaction, the moment a DEPOSIT
 * payment posts in CASH (see that file's comment for why this exact moment
 * is the right one). A no-op for everything else — a different entry type, a
 * non-cash channel (the money went straight to the company, never through an
 * agent's hand), or a contract someone other than an AGENT created: none of
 * those raise a cash-custody question to track.
 *
 * commissionAmountMinor is clamped to the deposit itself so amountOwedMinor
 * can never go negative — an agent can keep at most what they actually
 * collected, whatever CommissionSettings currently says.
 */
export async function recordAgentDepositIfApplicable(
  tx: Tx,
  params: { contractId: string; agentId: string; depositAmountMinor: number },
): Promise<void> {
  const agent = await tx.user.findUnique({ where: { id: params.agentId }, include: { role: true } });
  if (agent?.role.name !== 'AGENT') return;

  const { fixedCommissionMinor } = await getCommissionSettings(tx);
  const commissionAmountMinor = Math.min(fixedCommissionMinor, params.depositAmountMinor);
  const amountOwedMinor = Math.max(0, params.depositAmountMinor - commissionAmountMinor);

  await tx.agentDepositLedger.create({
    data: {
      contractId: params.contractId,
      agentId: params.agentId,
      depositAmountMinor: params.depositAmountMinor,
      commissionAmountMinor,
      amountOwedMinor,
      status: amountOwedMinor === 0 ? 'SETTLED' : 'OWED',
    },
  });
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
  if (params.amountMinor <= 0) throw new AgentLedgerError('amountMinor must be positive');
  if (!REMITTANCE_METHODS.includes(params.method)) {
    throw new AgentLedgerError(`method must be one of: ${REMITTANCE_METHODS.join(', ')}`);
  }

  const ledger = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { id: params.ledgerId } });
  if (ledger.agentId !== params.agentId) throw new AgentLedgerError('This ledger entry does not belong to you');
  if (ledger.status === 'SETTLED') throw new AgentLedgerError('This ledger entry is already settled');

  // Confirmed + still-pending claims both count against what remains owed, so
  // an agent can't file two overlapping claims that together overshoot it.
  const alreadyClaimed = await prisma.agentRemittance.aggregate({
    where: { ledgerId: ledger.id, status: { in: ['PENDING', 'CONFIRMED'] } },
    _sum: { amountMinor: true },
  });
  const remaining = ledger.amountOwedMinor - (alreadyClaimed._sum.amountMinor ?? 0);
  if (params.amountMinor > remaining) {
    throw new AgentLedgerError(`You owe at most ${remaining} (minor units) more on this entry, once any pending claims are counted`);
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

/**
 * An approver (agent.ledger.manage) checks a filed remittance against what
 * actually arrived (cash counted, or the mobile money/bank statement) and
 * confirms or rejects it. Only confirming moves the ledger's own totals — a
 * rejected claim leaves it untouched, exactly as if it had never been filed.
 */
export async function confirmRemittance(params: { remittanceId: string; confirmedById: string }) {
  return prisma.$transaction(async (tx) => {
    const remittance = await tx.agentRemittance.findUniqueOrThrow({ where: { id: params.remittanceId } });
    if (remittance.status !== 'PENDING') throw new AgentLedgerError(`This remittance was already ${remittance.status.toLowerCase()}`);

    const ledger = await tx.agentDepositLedger.findUniqueOrThrow({ where: { id: remittance.ledgerId } });
    const amountRemittedMinor = ledger.amountRemittedMinor + remittance.amountMinor;

    await tx.agentDepositLedger.update({
      where: { id: ledger.id },
      data: { amountRemittedMinor, status: amountRemittedMinor >= ledger.amountOwedMinor ? 'SETTLED' : 'OWED' },
    });

    return tx.agentRemittance.update({
      where: { id: remittance.id },
      data: { status: 'CONFIRMED', confirmedById: params.confirmedById, confirmedAt: new Date() },
    });
  });
}

export async function rejectRemittance(params: { remittanceId: string; confirmedById: string; reason: string }) {
  const remittance = await prisma.agentRemittance.findUniqueOrThrow({ where: { id: params.remittanceId } });
  if (remittance.status !== 'PENDING') throw new AgentLedgerError(`This remittance was already ${remittance.status.toLowerCase()}`);
  if (!params.reason.trim()) throw new AgentLedgerError('A reason is required');

  return prisma.agentRemittance.update({
    where: { id: remittance.id },
    data: { status: 'REJECTED', rejectionReason: params.reason.trim(), confirmedById: params.confirmedById, confirmedAt: new Date() },
  });
}
