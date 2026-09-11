import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { listRoles, createRole, RoleError } from '@/lib/services/roleService';
import { logAudit } from '@/lib/services/auditService';

// user.manage (not role.manage) also grants GET — the Users page's own
// role dropdown needs this list to assign a role to a user, which is a
// lesser ask than actually managing roles/permissions themselves.
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'user.manage', 'role.manage');
  if (!perm.authorized) return perm.error;

  const roles = await listRoles();
  return NextResponse.json({ roles });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'role.manage');
  if (!perm.authorized) return perm.error;

  const body = (await req.json()) as Record<string, unknown>;
  if (typeof body.name !== 'string') {
    return NextResponse.json({ error: 'name is required' }, { status: 400 });
  }

  try {
    const role = await createRole({
      name: body.name,
      description: body.description as string | undefined,
      permissions: body.permissions,
    });
    await logAudit({ userId: auth.user.id, action: 'ROLE_CREATE', entityType: 'Role', entityId: role.id, newValues: role });
    return NextResponse.json({ role: { ...role, permissions: role.permissions.map((p) => p.name) } }, { status: 201 });
  } catch (e) {
    if (e instanceof RoleError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
