/**
 * One-off, after the fix to the agent ledger on cancelled sales
 * (agentLedgerService.syncAgentLedger): cash an agent took on a sale later
 * cancelled used to drop out of their ledger, so a part-deposit they had
 * paid in showed as owed to them, and one they still held as nothing owed.
 * A ledger is only recalculated when its money changes; this recalculates
 * the ledgers of agents' cancelled sales now.
 *
 * Dry run by default: lists each ledger whose balance would change. With
 * --apply, saves the corrected figures.
 *
 * Usage (inside the app container on the server):
 *   npx tsx scripts/resyncAgentLedgers.ts           # dry run
 *   npx tsx scripts/resyncAgentLedgers.ts --apply   # correct the ledgers
 */
import { prisma } from '../src/lib/db/prisma';
import { syncAgentLedger, ledgerBalance } from '../src/lib/services/agentLedgerService';

const apply = process.argv.includes('--apply');
const cedis = (minor: number) => `GHS ${(minor / 100).toFixed(2)}`;
const describe = (balance: number) => (balance > 0 ? `agent owes ${cedis(balance)}` : balance < 0 ? `owed to agent ${cedis(-balance)}` : 'settled');

async function main() {
  const ledgers = await prisma.agentDepositLedger.findMany({
    where: { contract: { status: 'CANCELLED' } },
    include: { contract: { select: { contractNumber: true } }, agent: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'asc' },
  });
  console.log(`${ledgers.length} agent ledger(s) on cancelled sales.${apply ? '' : ' (dry run: nothing is changed)'}`);

  let changed = 0;
  for (const before of ledgers) {
    // Worked out in a transaction that is rolled back unless --apply.
    const after = await prisma.$transaction(async (tx) => {
      await syncAgentLedger(tx, before.contractId);
      const updated = await tx.agentDepositLedger.findUniqueOrThrow({ where: { id: before.id } });
      if (!apply) throw Object.assign(new Error('dry run'), { result: updated });
      return updated;
    }).catch((e: { result?: typeof before }) => {
      if (e.result) return e.result;
      throw e;
    });
    if (ledgerBalance(after) === ledgerBalance(before)) continue;
    changed += 1;
    console.log(`${before.contract.contractNumber} (${before.agent.firstName} ${before.agent.lastName}): ${describe(ledgerBalance(before))} -> ${describe(ledgerBalance(after))}`);
  }
  console.log(`${changed} ledger(s) ${apply ? 'corrected' : 'would be corrected'}.`);
}

main().finally(() => prisma.$disconnect());
