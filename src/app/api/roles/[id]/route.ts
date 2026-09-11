import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { updateRole, deleteRole, RoleError } from '@/lib/services/roleService';
import { logAudit } from '@/lib/services/auditService';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'role.manage');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const body = (await req.json()) as Record<string, unknown>;

  try {
    const role = await updateRole(id, {
      name: body.name as string | undefined,
      description: body.description as string | undefined,
      permissions: body.permissions,
    });
    await logAudit({ userId: auth.user.id, action: 'ROLE_UPDATE', entityType: 'Role', entityId: role.id, newValues: role });
    return NextResponse.json({ role: { ...role, permissions: role.permissions.map((p) => p.name) } });
  } catch (e) {
    if (e instanceof RoleError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'role.manage');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  try {
    await deleteRole(id);
    await logAudit({ userId: auth.user.id, action: 'ROLE_DELETE', entityType: 'Role', entityId: id });
    return NextResponse.json({ success: true });
  } catch (e) {
    if (e instanceof RoleError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
