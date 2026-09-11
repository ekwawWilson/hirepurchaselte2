import { prisma } from '../db/prisma';
import { ROLES, PERMISSIONS, type Permission } from '../constants/rbac';

export class RoleError extends Error {}

const RESERVED_NAMES = new Set<string>(ROLES);
const VALID_PERMISSIONS = new Set<string>(PERMISSIONS);

/**
 * Custom-role names follow the same UPPER_SNAKE_CASE convention as the 7
 * system roles (they're rendered as a raw Badge string right next to them —
 * see users/page.tsx) — typed input is normalized into it rather than
 * rejected, so "Regional Manager" becomes "REGIONAL_MANAGER" instead of
 * bouncing the admin back to retype it.
 */
function normalizeRoleName(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

function validatePermissions(permissions: unknown): Permission[] {
  if (!Array.isArray(permissions) || permissions.some((p) => typeof p !== 'string')) {
    throw new RoleError('permissions must be an array of permission names');
  }
  const unknown = permissions.filter((p) => !VALID_PERMISSIONS.has(p));
  if (unknown.length > 0) throw new RoleError(`Unknown permission(s): ${unknown.join(', ')}`);
  return [...new Set(permissions)] as Permission[];
}

export async function listRoles() {
  const roles = await prisma.role.findMany({
    include: { permissions: true, _count: { select: { users: true } } },
    orderBy: { name: 'asc' },
  });
  return roles.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    isSystemRole: RESERVED_NAMES.has(r.name),
    permissions: r.permissions.map((p) => p.name),
    userCount: r._count.users,
  }));
}

export async function createRole(params: { name: string; description?: string | null; permissions?: unknown }) {
  const name = normalizeRoleName(params.name);
  if (!name) throw new RoleError('name is required');
  if (RESERVED_NAMES.has(name)) {
    throw new RoleError(`"${name}" is a system role name, managed in code — choose a different name for a custom role`);
  }
  const permissions = validatePermissions(params.permissions ?? []);

  const existing = await prisma.role.findUnique({ where: { name } });
  if (existing) throw new RoleError(`A role named "${name}" already exists`);

  return prisma.role.create({
    data: {
      name,
      description: params.description?.trim() || null,
      permissions: { connect: permissions.map((p) => ({ name: p })) },
    },
    include: { permissions: true },
  });
}

async function getRoleOrThrow(id: string) {
  const role = await prisma.role.findUnique({ where: { id } });
  if (!role) throw new RoleError('Role not found');
  return role;
}

export async function updateRole(id: string, params: { name?: string; description?: string | null; permissions?: unknown }) {
  const role = await getRoleOrThrow(id);
  if (RESERVED_NAMES.has(role.name)) {
    throw new RoleError(`${role.name} is a system role, managed in code (src/lib/constants/rbac.ts) — create a custom role instead`);
  }

  const data: { name?: string; description?: string | null; permissions?: { set: { name: string }[] } } = {};

  if (params.name !== undefined) {
    const name = normalizeRoleName(params.name);
    if (!name) throw new RoleError('name is required');
    if (RESERVED_NAMES.has(name)) throw new RoleError(`"${name}" is a system role name, managed in code`);
    if (name !== role.name) {
      const collision = await prisma.role.findUnique({ where: { name } });
      if (collision) throw new RoleError(`A role named "${name}" already exists`);
    }
    data.name = name;
  }
  if (params.description !== undefined) data.description = params.description?.trim() || null;
  if (params.permissions !== undefined) {
    data.permissions = { set: validatePermissions(params.permissions).map((p) => ({ name: p })) };
  }

  return prisma.role.update({ where: { id }, data, include: { permissions: true } });
}

export async function deleteRole(id: string) {
  const role = await getRoleOrThrow(id);
  if (RESERVED_NAMES.has(role.name)) {
    throw new RoleError(`${role.name} is a system role and cannot be deleted`);
  }
  const userCount = await prisma.user.count({ where: { roleId: id } });
  if (userCount > 0) {
    throw new RoleError(`${userCount} user(s) still hold this role — reassign them before deleting it`);
  }
  await prisma.role.delete({ where: { id } });
}
