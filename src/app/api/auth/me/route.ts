import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth } from '@/lib/auth/rbac';
import type { Permission, RoleName } from '@/lib/constants/rbac';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: auth.user.id },
    include: { role: { include: { permissions: true } } },
  });

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      branchId: user.branchId,
      role: user.role.name as RoleName,
      permissions: user.role.permissions.map((p) => p.name) as Permission[],
    },
  });
}
