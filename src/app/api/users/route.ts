import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { ROLES } from '@/lib/constants/rbac';

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

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'user.manage');
  if (!perm.authorized) return perm.error;

  const users = await prisma.user.findMany({ include: { role: true }, orderBy: { createdAt: 'asc' } });
  return NextResponse.json({ users: users.map(toUserResponse) });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'user.manage');
  if (!perm.authorized) return perm.error;

  const { email, password, firstName, lastName, role, branchId } = (await req.json()) as {
    email?: string; password?: string; firstName?: string; lastName?: string; role?: string; branchId?: string | null;
  };

  if (!email || !password || !firstName || !lastName || !role) {
    return NextResponse.json({ error: 'email, password, firstName, lastName, role are required' }, { status: 400 });
  }
  if (!(ROLES as readonly string[]).includes(role)) {
    return NextResponse.json({ error: `role must be one of: ${ROLES.join(', ')}` }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase().trim() } });
  if (existing) return NextResponse.json({ error: 'A user with this email already exists' }, { status: 409 });

  const roleRow = await prisma.role.findUniqueOrThrow({ where: { name: role } });
  const passwordHash = await bcrypt.hash(password, Number(process.env.BCRYPT_ROUNDS) || 10);

  const user = await prisma.user.create({
    data: {
      email: email.toLowerCase().trim(),
      passwordHash,
      firstName,
      lastName,
      roleId: roleRow.id,
      branchId: branchId ?? null,
    },
    include: { role: true },
  });

  return NextResponse.json({ user: toUserResponse(user) }, { status: 201 });
}
