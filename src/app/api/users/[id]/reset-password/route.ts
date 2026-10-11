import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { resetUserPassword } from '@/lib/services/authService';
import { clearLoginFailures } from '@/lib/auth/loginThrottle';
import { logAudit } from '@/lib/services/auditService';

/**
 * Resets another member of staff's password to a random one, shown to the
 * administrator once and replaced by its owner at their next sign-in. Also
 * signs that person out everywhere and lifts any sign-in lockout.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'user.manage');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  if (id === auth.user.id) {
    return NextResponse.json({ error: 'Change your own password from your account menu instead' }, { status: 400 });
  }
  const target = await prisma.user.findUnique({ where: { id }, include: { role: true } });
  if (!target) return NextResponse.json({ error: 'User not found' }, { status: 404 });
  // Otherwise a custom role holding user.manage could take over a super admin.
  if (target.role.name === 'SUPER_ADMIN' && auth.user.roleName !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: "Only a super admin can reset a super admin's password" }, { status: 403 });
  }

  const temporaryPassword = await resetUserPassword(id);
  await clearLoginFailures(`staff:${target.email}`);
  await logAudit({ userId: auth.user.id, action: 'USER_PASSWORD_RESET', entityType: 'User', entityId: id });
  return NextResponse.json({ temporaryPassword });
}
