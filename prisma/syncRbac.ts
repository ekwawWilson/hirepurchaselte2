import { PrismaClient } from '@prisma/client';
import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/lib/constants/rbac';

/**
 * Syncs the permission catalog and each role's permission set from
 * src/lib/constants/rbac.ts into the DB. Pure reference data — no user
 * accounts, no passwords, no branch/demo data — so this is the only part of
 * the old prisma/seed.ts that is safe to run against a live production
 * database (see runSyncRbac.ts and the CI `migrate` job).
 *
 * Idempotent: upserts every permission, then REPLACES (`set`, not `connect`)
 * each role's permission set to exactly match the current ROLE_PERMISSIONS
 * mapping — so a permission added or removed from a role in code is
 * reflected in the DB the next time this runs, not just additively merged.
 *
 * Without this ever running against production, a new permission (like
 * settings.manage) exists in code and gates UI/routes correctly, but no role
 * actually holds it in the DB — every non-SUPER_ADMIN check for it silently
 * fails, because SUPER_ADMIN is the only role whose checks bypass the DB
 * entirely (see requirePermission/hasPermission).
 */
export async function syncRbac(prisma: PrismaClient) {
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
}
