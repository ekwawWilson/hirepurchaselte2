/**
 * Seeds the baseline reference data HP-Lite needs to log in and enforce RBAC:
 * one branch, the full permission catalog, the seven roles from docs/01-plan.md §7,
 * and one demo user per role. Idempotent — safe to re-run (upserts throughout).
 *
 * Business demo data (products, price chart, customers, contracts) lives in
 * demoSeed.ts instead, since it depends on modules built after this one.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { PERMISSIONS, ROLE_PERMISSIONS, DEMO_USERS, SEED_PASSWORD, BRANCH_SCOPED_ROLES } from '../src/lib/constants/rbac';

const prisma = new PrismaClient();

async function main() {
  const branch = await prisma.branch.upsert({
    where: { code: 'MAIN' },
    update: {},
    create: { name: 'Main Branch', code: 'MAIN', address: 'Head Office' },
  });

  for (const name of PERMISSIONS) {
    await prisma.permission.upsert({ where: { name }, update: {}, create: { name } });
  }

  for (const [roleName, perms] of Object.entries(ROLE_PERMISSIONS)) {
    await prisma.role.upsert({
      where: { name: roleName },
      update: { permissions: { set: perms.map((name) => ({ name })) } },
      create: {
        name: roleName,
        permissions: { connect: perms.map((name) => ({ name })) },
      },
    });
  }

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
        'Outstanding balance: {{currency}} {{outstandingBalance}}. Next due: {{currency}} {{nextDueAmount}} on {{nextDueDate}}.',
    },
    {
      key: 'contract.activated',
      name: 'Contract activated / welcome',
      bodyTemplate:
        'Hi {{customerName}}, your contract {{contractNumber}} is now active. ' +
        'Outstanding balance: {{currency}} {{outstandingBalance}}. Next payment of {{currency}} {{nextDueAmount}} is due {{nextDueDate}}.',
    },
  ];
  for (const t of smsTemplates) {
    await prisma.smsTemplate.upsert({ where: { key: t.key }, update: {}, create: t });
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
