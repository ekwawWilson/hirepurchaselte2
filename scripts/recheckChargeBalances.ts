/**
 * One-off, after the fix to how late charges are counted (paymentService.ts):
 * money paid to a late charge used to be taken off the price too, so a
 * contract with charges showed a balance too low, and could complete with
 * instalments unpaid. Payments made from now on are counted correctly; this
 * rechecks the contracts that already have charge payments.
 *
 * Dry run by default: lists each affected contract, its balance as stored and
 * as it should be. With --apply, corrects the totals and instalment states.
 * A contract that was completed too early is listed but never reopened here
 * (that releases nothing back, and takes a person's decision): reopen it from
 * the contract page, or leave it, as the business decides.
 *
 * Usage (inside the app container on the server):
 *   npx tsx scripts/recheckChargeBalances.ts           # dry run
 *   npx tsx scripts/recheckChargeBalances.ts --apply   # correct the totals
 */
import { prisma } from '../src/lib/db/prisma';
import { resettleContract } from '../src/lib/services/paymentService';

const apply = process.argv.includes('--apply');
const cedis = (minor: number | null) => (minor === null ? '-' : `GHS ${(minor / 100).toFixed(2)}`);

async function main() {
  const contracts = await prisma.contract.findMany({
    where: { totalPayableMinor: { not: null }, payments: { some: { allocations: { some: { targetType: 'PENALTY' } } } } },
    select: { id: true, contractNumber: true, status: true, totalPayableMinor: true, totalPaidMinor: true, balanceMinor: true },
    orderBy: { contractNumber: 'asc' },
  });
  console.log(`${contracts.length} contract(s) have payments that went to late charges.${apply ? '' : ' (dry run: nothing is changed)'}`);

  let changed = 0;
  const completedEarly: string[] = [];
  for (const c of contracts) {
    // Worked out in a transaction that is rolled back unless --apply.
    const after = await prisma.$transaction(async (tx) => {
      await resettleContract(tx, c.id);
      const updated = await tx.contract.findUniqueOrThrow({ where: { id: c.id }, select: { totalPaidMinor: true, balanceMinor: true, status: true } });
      if (!apply) throw Object.assign(new Error('dry run'), { result: updated });
      return updated;
    }).catch((e: { result?: { totalPaidMinor: number; balanceMinor: number | null; status: string } }) => {
      if (e.result) return e.result;
      throw e;
    });
    if (after.totalPaidMinor === c.totalPaidMinor && after.balanceMinor === c.balanceMinor) continue;
    changed += 1;
    console.log(`${c.contractNumber} (${c.status}): paid towards the price ${cedis(c.totalPaidMinor)} -> ${cedis(after.totalPaidMinor)}, balance ${cedis(c.balanceMinor)} -> ${cedis(after.balanceMinor)}`);
    if (c.status === 'COMPLETED' && (after.balanceMinor ?? 0) > 0) completedEarly.push(`${c.contractNumber}: ${cedis(after.balanceMinor)} of the price still unpaid`);
  }
  console.log(`${changed} contract(s) ${apply ? 'corrected' : 'would be corrected'}.`);
  if (completedEarly.length > 0) {
    console.log('\nCompleted too early (left as they are, for a person to decide):');
    for (const line of completedEarly) console.log(`  ${line}`);
  }
}

main().finally(() => prisma.$disconnect());
