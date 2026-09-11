import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';

function toUserResponse(user: {
  id: string; email: string; firstName: string; lastName: string; isActive: boolean;
  branchId: string | null; role: { name: string };
}) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    isActive: user.isActive,
    branchId: user.branchId,
    role: user.role.name,
  };
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'user.manage');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { firstName, lastName, role, branchId, isActive } = (await req.json()) as {
    firstName?: string; lastName?: string; role?: string; branchId?: string | null; isActive?: boolean;
  };

  const existing = await prisma.user.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'User not found' }, { status: 404 });

  let roleId: string | undefined;
  if (role !== undefined) {
    // Looked up rather than checked against a fixed list — see the matching
    // comment in POST /api/users.
    const roleRow = await prisma.role.findUnique({ where: { name: role } });
    if (!roleRow) return NextResponse.json({ error: `Unknown role: ${role}` }, { status: 400 });
    roleId = roleRow.id;
  }

  const user = await prisma.user.update({
    where: { id },
    data: {
      ...(firstName !== undefined && { firstName }),
      ...(lastName !== undefined && { lastName }),
      ...(roleId !== undefined && { roleId }),
      ...(branchId !== undefined && { branchId }),
      ...(isActive !== undefined && { isActive }),
    },
    include: { role: true },
  });

  return NextResponse.json({ user: toUserResponse(user) });
}
