/**
 * Creates the first branch and one staff account per system role on a fresh
 * production database — the production-safe counterpart to prisma/seed.ts,
 * which creates demo users with a publicly documented password and must never
 * run against a real deployment.
 *
 * Each account gets a random password. Passwords are printed ONCE, to stdout,
 * as tab-separated `email<TAB>role<TAB>password` lines: redirect them into a
 * file only the server's root user can read, hand them out, then delete it.
 *
 *   umask 077
 *   docker compose exec -T -e EMAIL_DOMAIN=example.com \
 *     app npx tsx prisma/createStaffUsers.ts > initial-passwords.txt
 *
 * Safe to re-run: an account whose email already exists is left untouched,
 * and the existing branch is reused. Requires the roles to exist already
 * (prisma/runSyncRbac.ts).
 */
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { ROLES, BRANCH_SCOPED_ROLES, type RoleName } from '../src/lib/constants/rbac';

const prisma = new PrismaClient();

/** Local part of each role's email, and the name shown in the app. */
const STAFF: Record<RoleName, { local: string; firstName: string; lastName: string }> = {
  SUPER_ADMIN: { local: 'superadmin', firstName: 'Super', lastName: 'Admin' },
  ADMIN: { local: 'admin', firstName: 'System', lastName: 'Admin' },
  BRANCH_MANAGER: { local: 'manager', firstName: 'Branch', lastName: 'Manager' },
  CASHIER: { local: 'cashier', firstName: 'Front', lastName: 'Cashier' },
  SALES: { local: 'sales', firstName: 'Sales', lastName: 'Rep' },
  AGENT: { local: 'agent', firstName: 'Field', lastName: 'Agent' },
  STORE_KEEPER: { local: 'storekeeper', firstName: 'Store', lastName: 'Keeper' },
  AUDITOR: { local: 'auditor', firstName: 'System', lastName: 'Auditor' },
};

/** 24 characters of base64url — no ambiguity about escaping in a shell or a chat message. */
function randomPassword(): string {
  return randomBytes(18).toString('base64url');
}

async function main() {
  const domain = (process.env.EMAIL_DOMAIN ?? '').trim().toLowerCase().replace(/^@/, '');
  if (!domain.includes('.')) throw new Error('EMAIL_DOMAIN is required, e.g. EMAIL_DOMAIN=example.com');
  const branchName = (process.env.BRANCH_NAME ?? 'Main Branch').trim();
  const branchCode = (process.env.BRANCH_CODE ?? 'MAIN').trim().toUpperCase();
  const rounds = Number(process.env.BCRYPT_ROUNDS ?? 10);

  const branch = (await prisma.branch.findFirst()) ??
    (await prisma.branch.create({ data: { name: branchName, code: branchCode } }));

  for (const roleName of ROLES) {
    const role = await prisma.role.findUnique({ where: { name: roleName } });
    if (!role) throw new Error(`Role ${roleName} not found — run prisma/runSyncRbac.ts first`);

    const { local, firstName, lastName } = STAFF[roleName];
    const email = `${local}@${domain}`;
    if (await prisma.user.findUnique({ where: { email } })) {
      console.log(`${email}\t${roleName}\t(already existed — password unchanged)`);
      continue;
    }

    const password = randomPassword();
    await prisma.user.create({
      data: {
        email,
        firstName,
        lastName,
        passwordHash: await bcrypt.hash(password, rounds),
        roleId: role.id,
        // Branch-scoped roles see only their own branch; the rest see all of them.
        branchId: BRANCH_SCOPED_ROLES.includes(roleName) ? branch.id : null,
        isActive: true,
      },
    });
    console.log(`${email}\t${roleName}\t${password}`);
  }

  console.error(`Branch: ${branch.name} (${branch.code})`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
