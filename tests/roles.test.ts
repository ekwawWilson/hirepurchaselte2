/**
 * Coverage for custom role management (src/lib/services/roleService.ts):
 *  - Only SUPER_ADMIN holds role.manage (ADMIN is deliberately excluded —
 *    see constants/rbac.ts's ROLE_PERMISSIONS).
 *  - The 7 system roles (ROLES in constants/rbac.ts) are read-only through
 *    this API — syncRbac.ts force-replaces their permissions from code on
 *    every deploy, so editing them here would just be silently undone.
 *  - A custom role is fully self-service: create/edit/delete, with the DB
 *    as the only source of truth (never touched by syncRbac).
 *  - POST /api/users accepts any real role name now, not just the 7 built-in ones.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as rolesGET, POST as rolesPOST } from '@/app/api/roles/route';
import { PATCH as rolePATCH, DELETE as roleDELETE } from '@/app/api/roles/[id]/route';
import { POST as usersPOST, GET as usersGET } from '@/app/api/users/route';
import { PATCH as userPATCH } from '@/app/api/users/[id]/route';

const PASSWORD = 'Passw0rd!123';
const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
function uniqueEmail(label: string) {
  counter += 1;
  return `role-test-${label}-${counter}-${runId}@zple.test`;
}

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  expect(res.status).toBe(200);
  return (await res.json()).token as string;
}

describe('Roles: custom role management', () => {
  let superAdmin: string;
  let admin: string;
  let cashier: string;

  beforeAll(async () => {
    superAdmin = await login('superadmin@zple.test');
    admin = await login('admin@zple.test');
    cashier = await login('cashier@zple.test');
  });

  it('GET /api/roles requires user.manage or role.manage — CASHIER gets 403', async () => {
    const res = await rolesGET(makeRequest('GET', '/api/roles', { token: cashier }));
    expect(res.status).toBe(403);
  });

  it('GET /api/roles lists the 7 system roles, each flagged isSystemRole', async () => {
    const res = await rolesGET(makeRequest('GET', '/api/roles', { token: superAdmin }));
    expect(res.status).toBe(200);
    const { roles } = await res.json();
    const systemNames = roles.filter((r: { isSystemRole: boolean }) => r.isSystemRole).map((r: { name: string }) => r.name).sort();
    expect(systemNames).toEqual(['ADMIN', 'AUDITOR', 'BRANCH_MANAGER', 'CASHIER', 'SALES', 'STORE_KEEPER', 'SUPER_ADMIN'].sort());
  });

  it('POST /api/roles requires role.manage specifically — ADMIN (which lacks it) gets 403', async () => {
    const res = await rolesPOST(makeRequest('POST', '/api/roles', {
      token: admin, body: { name: `Should Not Create ${runId}`, permissions: [] },
    }));
    expect(res.status).toBe(403);
  });

  it('creates a custom role, normalizing the typed name to UPPER_SNAKE_CASE', async () => {
    const res = await rolesPOST(makeRequest('POST', '/api/roles', {
      token: superAdmin,
      body: { name: `Regional Manager ${runId}`, description: 'Oversees a cluster of branches', permissions: ['contract.view', 'payment.view'] },
    }));
    expect(res.status).toBe(201);
    const { role } = await res.json();
    expect(role.name).toBe(`REGIONAL_MANAGER_${runId}`);
    expect(role.description).toBe('Oversees a cluster of branches');
    expect(role.permissions.sort()).toEqual(['contract.view', 'payment.view'].sort());

    const listed = await rolesGET(makeRequest('GET', '/api/roles', { token: superAdmin }));
    const { roles } = await listed.json();
    const found = roles.find((r: { id: string }) => r.id === role.id);
    expect(found.isSystemRole).toBe(false);
    expect(found.userCount).toBe(0);
  });

  it('rejects a role name that collides with a system role, even after normalization', async () => {
    const res = await rolesPOST(makeRequest('POST', '/api/roles', {
      token: superAdmin, body: { name: 'cashier', permissions: [] },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/system role/i);
  });

  it('rejects an unknown permission name', async () => {
    const res = await rolesPOST(makeRequest('POST', '/api/roles', {
      token: superAdmin, body: { name: `Bad Perm ${runId}`, permissions: ['contract.teleport'] },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown permission/i);
  });

  it('rejects a duplicate custom role name', async () => {
    const name = `Dupe Role ${runId}`;
    const first = await rolesPOST(makeRequest('POST', '/api/roles', { token: superAdmin, body: { name, permissions: [] } }));
    expect(first.status).toBe(201);

    const second = await rolesPOST(makeRequest('POST', '/api/roles', { token: superAdmin, body: { name, permissions: [] } }));
    expect(second.status).toBe(400);
    expect((await second.json()).error).toMatch(/already exists/i);
  });

  it('a custom role\'s name, description, and permissions can all be edited', async () => {
    const created = await rolesPOST(makeRequest('POST', '/api/roles', {
      token: superAdmin, body: { name: `Editable ${runId}`, permissions: ['customer.view'] },
    }));
    const role = (await created.json()).role;

    const patched = await rolePATCH(
      makeRequest('PATCH', `/api/roles/${role.id}`, {
        token: superAdmin,
        body: { name: `Renamed ${runId}`, description: 'now with a description', permissions: ['customer.view', 'customer.create'] },
      }),
      makeParams({ id: role.id }),
    );
    expect(patched.status).toBe(200);
    const updated = (await patched.json()).role;
    expect(updated.name).toBe(`RENAMED_${runId}`);
    expect(updated.description).toBe('now with a description');
    expect(updated.permissions.sort()).toEqual(['customer.create', 'customer.view'].sort());
  });

  it('rejects editing or deleting a system role — protected because syncRbac overwrites it on every deploy', async () => {
    const cashierRole = await prisma.role.findUniqueOrThrow({ where: { name: 'CASHIER' } });

    const patched = await rolePATCH(
      makeRequest('PATCH', `/api/roles/${cashierRole.id}`, { token: superAdmin, body: { permissions: [] } }),
      makeParams({ id: cashierRole.id }),
    );
    expect(patched.status).toBe(400);
    expect((await patched.json()).error).toMatch(/system role/i);

    const deleted = await roleDELETE(makeRequest('DELETE', `/api/roles/${cashierRole.id}`, { token: superAdmin }), makeParams({ id: cashierRole.id }));
    expect(deleted.status).toBe(400);
    expect((await deleted.json()).error).toMatch(/system role/i);
  });

  it('rejects deleting a custom role that still has users assigned, then succeeds once they are reassigned', async () => {
    const created = await rolesPOST(makeRequest('POST', '/api/roles', {
      token: superAdmin, body: { name: `Deletable ${runId}`, permissions: ['customer.view'] },
    }));
    const role = (await created.json()).role;

    const userRes = await usersPOST(makeRequest('POST', '/api/users', {
      token: superAdmin,
      body: { firstName: 'Role', lastName: 'Holder', email: uniqueEmail('holder'), password: PASSWORD, role: role.name },
    }));
    expect(userRes.status).toBe(201);
    const user = (await userRes.json()).user;
    expect(user.role).toBe(role.name);

    const blockedDelete = await roleDELETE(makeRequest('DELETE', `/api/roles/${role.id}`, { token: superAdmin }), makeParams({ id: role.id }));
    expect(blockedDelete.status).toBe(400);
    expect((await blockedDelete.json()).error).toMatch(/1 user/i);

    await userPATCH(
      makeRequest('PATCH', `/api/users/${user.id}`, { token: superAdmin, body: { role: 'CASHIER' } }),
      makeParams({ id: user.id }),
    );

    const okDelete = await roleDELETE(makeRequest('DELETE', `/api/roles/${role.id}`, { token: superAdmin }), makeParams({ id: role.id }));
    expect(okDelete.status).toBe(200);

    const stillThere = await prisma.role.findUnique({ where: { id: role.id } });
    expect(stillThere).toBeNull();
  });

  it('POST /api/users accepts a custom role, not just the 7 built-in ones', async () => {
    const roleRes = await rolesPOST(makeRequest('POST', '/api/roles', {
      token: superAdmin, body: { name: `Collections Agent ${runId}`, permissions: ['contract.view', 'payment.cash.record'] },
    }));
    const customRole = (await roleRes.json()).role;

    const userRes = await usersPOST(makeRequest('POST', '/api/users', {
      token: superAdmin,
      body: { firstName: 'Custom', lastName: 'Role', email: uniqueEmail('custom'), password: PASSWORD, role: customRole.name },
    }));
    expect(userRes.status).toBe(201);
    expect((await userRes.json()).user.role).toBe(customRole.name);

    const listRes = await usersGET(makeRequest('GET', '/api/users', { token: superAdmin }));
    const { users } = await listRes.json();
    expect(users.some((u: { role: string }) => u.role === customRole.name)).toBe(true);
  });

  it('POST /api/users rejects a role name that does not exist', async () => {
    const res = await usersPOST(makeRequest('POST', '/api/users', {
      token: superAdmin,
      body: { firstName: 'Ghost', lastName: 'Role', email: uniqueEmail('ghost'), password: PASSWORD, role: `NO_SUCH_ROLE_${runId}` },
    }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Unknown role/i);
  });
});
