/**
 * Creates the first branch and SUPER_ADMIN of a fresh production database —
 * the part of setup prisma/seed.ts must never do there, since that script
 * creates demo users with a publicly documented password.
 *
 * Credentials come from the environment so the password is never written into
 * a file or this repository:
 *
 *   docker compose exec \
 *     -e ADMIN_EMAIL=you@company.com -e ADMIN_PASSWORD='a long passphrase' \
 *     -e ADMIN_FIRST_NAME=Wilson -e ADMIN_LAST_NAME=Junior \
 *     app npx tsx prisma/createAdmin.ts
 *
 * Safe to re-run: it refuses if the email already exists, and reuses the
 * existing branch rather than creating a second one. Requires the roles to
 * exist already (prisma/runSyncRbac.ts).
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

const MIN_PASSWORD_LENGTH = 12;

async function main() {
  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? '';
  const firstName = (process.env.ADMIN_FIRST_NAME ?? 'Super').trim();
  const lastName = (process.env.ADMIN_LAST_NAME ?? 'Admin').trim();
  const branchName = (process.env.BRANCH_NAME ?? 'Main Branch').trim();
  const branchCode = (process.env.BRANCH_CODE ?? 'MAIN').trim().toUpperCase();

  if (!email.includes('@')) throw new Error('ADMIN_EMAIL must be a valid email address');
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw new Error(`A user with ${email} already exists — nothing was changed`);

  const role = await prisma.role.findUnique({ where: { name: 'SUPER_ADMIN' } });
  if (!role) throw new Error('SUPER_ADMIN role not found — run prisma/runSyncRbac.ts first');

  // A SUPER_ADMIN sees every branch (branchId null), but the business still
  // needs one branch to register customers and stock against.
  const branch = (await prisma.branch.findFirst()) ??
    (await prisma.branch.create({ data: { name: branchName, code: branchCode } }));

  const user = await prisma.user.create({
    data: {
      email,
      firstName,
      lastName,
      passwordHash: await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS ?? 10)),
      roleId: role.id,
      branchId: null,
      isActive: true,
    },
  });

  console.log(`Created SUPER_ADMIN ${user.email}`);
  console.log(`Branch: ${branch.name} (${branch.code})`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
