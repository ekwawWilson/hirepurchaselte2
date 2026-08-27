import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { signToken } from '@/lib/auth/jwt';
import type { Permission, RoleName } from '@/lib/constants/rbac';

function toUserResponse(user: {
  id: string; email: string; firstName: string; lastName: string;
  branchId: string | null; role: { name: string; permissions: { name: string }[] };
}) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    branchId: user.branchId,
    role: user.role.name as RoleName,
    permissions: user.role.permissions.map((p) => p.name) as Permission[],
  };
}

export async function POST(req: NextRequest) {
  const { email, password } = (await req.json()) as { email?: string; password?: string };
  if (!email || !password) {
    return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
  }

  const user = await prisma.user.findUnique({
    where: { email: email.toLowerCase().trim() },
    include: { role: { include: { permissions: true } } },
  });

  // Constant-shape response whether the account exists or not, to avoid user enumeration.
  if (!user || !user.isActive) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  const token = signToken(user.id);
  return NextResponse.json({ token, user: toUserResponse(user) });
}
