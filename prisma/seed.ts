/**
 * Seeds a dev/CI environment: a demo branch, the RBAC permission catalog +
 * role mappings (via syncRbac.ts), and one demo user per role with a known,
 * publicly-documented password. Idempotent — safe to re-run (upserts
 * throughout) in dev/CI, but the demo-user step means this must NEVER be run
 * against production — use `runSyncRbac.ts` there instead, which does only
 * the RBAC part.
 *
 * Business demo data (products, price chart, customers, contracts) lives in
 * demoSeed.ts instead, since it depends on modules built after this one.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { DEMO_USERS, SEED_PASSWORD, BRANCH_SCOPED_ROLES } from '../src/lib/constants/rbac';
import { syncRbac } from './syncRbac';

const prisma = new PrismaClient();

async function main() {
  const branch = await prisma.branch.upsert({
    where: { code: 'MAIN' },
    update: {},
    create: { name: 'Main Branch', code: 'MAIN', address: 'Head Office' },
  });

  await syncRbac(prisma);

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, 10);

  for (const u of DEMO_USERS) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: u.role } });
    await prisma.user.upsert({
      where: { email: u.email },
      update: {},
      create: {
        email: u.email,
        passwordHash,
        firstName: u.firstName,
        lastName: u.lastName,
        roleId: role.id,
        branchId: BRANCH_SCOPED_ROLES.includes(u.role) ? branch.id : null,
      },
    });
  }

  const smsTemplates = [
    {
      key: 'payment.success',
      name: 'Payment received',
      bodyTemplate:
        'Hi {{customerName}}, we received your payment of {{currency}} {{amountPaid}} for contract {{contractNumber}}. ' +
        'Outstanding balance: {{currency}} {{outstandingBalance}}. {{nextDueLine}}',
    },
    {
      key: 'contract.activated',
      name: 'Contract activated / welcome',
      bodyTemplate:
        'Hi {{customerName}}, your contract {{contractNumber}} is now active. ' +
        'Outstanding balance: {{currency}} {{outstandingBalance}}. {{nextDueLine}}',
    },
  ];
  for (const t of smsTemplates) {
    // update (not just create-if-missing): template wording is only ever changed here,
    // there's no admin UI for it yet, so a code fix should actually take effect on reseed.
    await prisma.smsTemplate.upsert({ where: { key: t.key }, update: { name: t.name, bodyTemplate: t.bodyTemplate }, create: t });
  }

  console.log('\nSeeded roles, permissions, branch, demo users, and SMS templates.');
  console.log(`Demo login password for every seeded user: ${SEED_PASSWORD}\n`);
  for (const u of DEMO_USERS) {
    console.log(`  ${u.role.padEnd(15)} ${u.email}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
