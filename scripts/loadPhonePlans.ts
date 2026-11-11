/**
 * One-off: the price plans the owner gave on 2026-11-08 for the first four
 * Device Financing phones, loaded through the same service as the product
 * page. Total price includes the deposit. Run again safely: it sets the
 * plans to exactly these.
 *
 * Usage (inside the app container on the server):
 *   npx tsx scripts/loadPhonePlans.ts           # dry run
 *   npx tsx scripts/loadPhonePlans.ts --apply   # save them
 */
import { prisma } from '../src/lib/db/prisma';
import { savePlans, plansProblem, type PlanInput } from '../src/lib/services/deviceFinancingPlanService';

const apply = process.argv.includes('--apply');
const ghs = (cedis: number) => Math.round(cedis * 100);
const plan = (months: number, total: number, deposit: number): PlanInput => ({ months, totalPriceMinor: ghs(total), depositMinor: ghs(deposit) });

const THREE_GB = [plan(3, 2285, 325), plan(4, 2455, 350), plan(5, 2650, 400)];
const FOUR_GB = [plan(3, 2330, 350), plan(4, 2560, 400), plan(5, 2700, 450)];
const PHONES: Record<string, PlanInput[]> = {
  'Tecno Pop 20': THREE_GB,
  'Tecno Pop 20C': FOUR_GB,
  'Infinix Smart 20 (4 GB)': FOUR_GB,
  'Infinix Smart 20 (3 GB)': THREE_GB,
};

async function main() {
  const actor = await prisma.user.findFirstOrThrow({ where: { role: { name: 'SUPER_ADMIN' } }, orderBy: { createdAt: 'asc' }, select: { id: true } });
  console.log(apply ? 'APPLYING' : 'DRY RUN: nothing is changed');
  for (const [name, plans] of Object.entries(PHONES)) {
    const product = await prisma.product.findFirst({ where: { name }, select: { id: true } });
    const problem = plansProblem(plans);
    const line = plans.map((p) => `${p.months}m GHS ${p.totalPriceMinor / 100} (deposit ${p.depositMinor / 100})`).join(', ');
    if (!product) { console.log(`NOT FOUND ${name}`); continue; }
    if (problem) { console.log(`REFUSED  ${name}: ${problem}`); continue; }
    if (apply) await savePlans(product.id, plans, actor.id);
    console.log(`${apply ? 'SAVED   ' : 'WOULD SET'} ${name}: ${line}`);
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
