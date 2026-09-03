import { prisma } from '../db/prisma';
import { chargeDirectDebit } from './hubtelPreapprovalService';

/**
 * Charges the direct-debit mandate for every ACTIVE contract that has one
 * attached and an instalment outstanding — one contract, its single oldest
 * outstanding instalment, per run. Naturally idempotent: a successful charge
 * marks that instalment PAID via the normal payment pipeline, so a second run
 * the same day simply finds nothing left to charge for that contract.
 *
 * Two collection modes, chosen per contract (Contract.paymentMethod):
 *  - DIRECT_DEBIT: proactive — charges the instant an instalment is due
 *    (today or overdue), the same behavior this always had.
 *  - BOTH: the customer gets first crack at paying it themselves (cash/USSD)
 *    — direct debit only steps in once the instalment is actually OVERDUE,
 *    i.e. the customer defaulted on paying it themselves. Same daily cron,
 *    just a narrower instalment-status filter.
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
      paymentMethod: { in: ['DIRECT_DEBIT', 'BOTH'] },
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
    // BOTH mode leaves an instalment that's due-today-but-not-yet-overdue for
    // the customer to pay themselves — only an already-OVERDUE one (the
    // customer defaulted on it) triggers direct debit.
    if (contract.paymentMethod === 'BOTH' && due.status !== 'OVERDUE') continue;
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
