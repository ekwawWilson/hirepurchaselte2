import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db/prisma';
import { signToken } from '@/lib/auth/jwt';
import { loginLockout, recordLoginFailure, clearLoginFailures } from '@/lib/auth/loginThrottle';
import { logAudit } from '@/lib/services/auditService';
import type { Permission, RoleName } from '@/lib/constants/rbac';

function toUserResponse(user: {
  id: string; email: string; firstName: string; lastName: string; mustChangePassword: boolean;
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
    mustChangePassword: user.mustChangePassword,
  };
}

export async function POST(req: NextRequest) {
  const { email, password } = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  if (!email || !password) {
    return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
  }

  // Counted per email whether or not the account exists, so the limit says
  // nothing about which addresses are registered.
  const normalizedEmail = email.toLowerCase().trim();
  const account = `staff:${normalizedEmail}`;
  const locked = await loginLockout(req, account);
  if (locked) return locked;

  const user = await prisma.user.findUnique({
    where: { email: normalizedEmail },
    include: { role: { include: { permissions: true } } },
  });

  // Constant-shape response whether the account exists or not, to avoid user enumeration.
  if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) {
    await recordLoginFailure(req, account);
    if (user) await logAudit({ userId: user.id, action: 'LOGIN_FAILED', entityType: 'User', entityId: user.id });
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 });
  }

  await clearLoginFailures(account);
  const token = signToken(user.id);
  return NextResponse.json({ token, user: toUserResponse(user) });
}
