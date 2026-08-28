import { prisma } from '../db/prisma';
import { chargeDirectDebit } from './hubtelPreapprovalService';

/**
 * Proactively charges the direct-debit mandate for every ACTIVE contract that
 * has one attached and an instalment due (today or overdue) that isn't fully
 * paid — one contract, its single oldest outstanding due instalment, per run.
 * Naturally idempotent: a successful charge marks that instalment PAID via the
 * normal payment pipeline, so a second run the same day simply finds nothing
 * left to charge for that contract.
 *
 * This is the piece the legacy hirepurchase app never actually wired up in
 * production (its own auto-retry only re-attempts charges that already failed —
 * see docs/01-plan.md) — without a proactive run, a mandate is just something
 * nobody ever uses to collect.
 */
export async function runDirectDebitCollections() {
  const contracts = await prisma.contract.findMany({
    where: {
      status: 'ACTIVE',
      hubtelPreapprovalId: { not: null },
      hubtelPreapproval: { status: 'APPROVED' },
    },
    include: {
      instalments: {
        where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lte: new Date() } },
        orderBy: { instalmentNo: 'asc' },
        take: 1,
      },
    },
  });

  let charged = 0;
  for (const contract of contracts) {
    const due = contract.instalments[0];
    if (!due) continue;
    const outstanding = due.amountDueMinor - due.amountPaidMinor;
    if (outstanding <= 0) continue;
    try {
      await chargeDirectDebit({ contractId: contract.id, amountMinor: Math.min(outstanding, contract.balanceMinor) });
      charged += 1;
    } catch (e) {
      console.error(`[collections] direct debit charge failed for contract ${contract.id}:`, e);
    }
  }
  return charged;
}
