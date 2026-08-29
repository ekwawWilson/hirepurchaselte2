/**
 * CLI entry for syncRbac.ts — the one part of seeding that's safe to run
 * against production (see that file's comment for why). Run directly:
 *
 *   DATABASE_URL=... DIRECT_URL=... npx tsx prisma/runSyncRbac.ts
 *
 * Wired into the production `migrate` job in .github/workflows/ci.yml,
 * right after `prisma migrate deploy`, so every deploy keeps the DB's
 * role→permission mappings in sync with src/lib/constants/rbac.ts
 * automatically. Never runs demo-user creation — that stays in seed.ts,
 * dev/CI only.
 */
import { PrismaClient } from '@prisma/client';
import { syncRbac } from './syncRbac';

const prisma = new PrismaClient();

syncRbac(prisma)
  .then(() => console.log('RBAC synced: permission catalog + role→permission mappings.'))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
