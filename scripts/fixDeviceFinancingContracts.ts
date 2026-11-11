/**
 * One-off, after phones stopped having a grace period (decide.ts locks an
 * unpaid phone at 23:59 on its due day). Device Financing contracts made
 * before keep a grace period on their record, and their phones may still
 * hold a lock date worked out the old way. This sets every open Device
 * Financing contract's grace period to 0, and sends each linked phone its
 * lock date under the new rule.
 *
 * Dry run by default: lists what would change. With --apply, changes it.
 *
 * Usage (inside the app container on the server):
 *   npx tsx scripts/fixDeviceFinancingContracts.ts           # dry run
 *   npx tsx scripts/fixDeviceFinancingContracts.ts --apply   # correct them
 */
import { prisma } from '../src/lib/db/prisma';
import { reconcileContract } from '../src/lib/paytrigger/reconcile';

const apply = process.argv.includes('--apply');
const OPEN = ['PENDING_APPROVAL', 'REVISION_REQUESTED', 'PENDING_DEPOSIT', 'ACTIVE', 'DEFAULTED'];

async function main() {
  const contracts = await prisma.contract.findMany({
    where: { contractType: 'DEVICE_FINANCING', status: { in: OPEN } },
    select: { id: true, contractNumber: true, status: true, gracePeriodDays: true, penaltyRateBps: true },
    orderBy: { createdAt: 'asc' },
  });
  const devices = await prisma.payTriggerDevice.findMany({ where: { contractId: { in: contracts.map((c) => c.id) } }, select: { contractId: true, imei: true, providerExpiresAt: true } });
  const withGrace = contracts.filter((c) => c.gracePeriodDays !== 0);
  console.log(`${contracts.length} open Device Financing contract(s); ${withGrace.length} with a grace period; ${devices.length} with a phone.${apply ? '' : ' (dry run: nothing is changed)'}`);

  for (const c of withGrace) {
    const fees = c.penaltyRateBps > 0 ? ` (late fee ${c.penaltyRateBps / 100}%: now charged the day after a missed payment)` : '';
    console.log(`  ${c.contractNumber} ${c.status}: grace ${c.gracePeriodDays} day(s) -> 0${fees}`);
  }
  if (apply && withGrace.length > 0) {
    await prisma.contract.updateMany({ where: { id: { in: withGrace.map((c) => c.id) } }, data: { gracePeriodDays: 0 } });
  }

  for (const d of devices) {
    const contract = contracts.find((c) => c.id === d.contractId)!;
    if (!apply) {
      console.log(`  ${contract.contractNumber} phone ${d.imei}: lock date now ${d.providerExpiresAt?.toISOString() ?? 'none'}, to be re-sent`);
      continue;
    }
    const outcome = await reconcileContract(contract.id, { reasons: ['ADMIN'], force: true });
    console.log(`  ${contract.contractNumber} phone ${d.imei}: ${outcome.action ?? '-'} ${outcome.outcome}: ${outcome.reason}`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
