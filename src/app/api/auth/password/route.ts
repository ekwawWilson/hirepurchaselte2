import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/rbac';
import { signToken } from '@/lib/auth/jwt';
import { changeOwnPassword, AuthError } from '@/lib/services/authService';
import { logAudit } from '@/lib/services/auditService';

/**
 * A member of staff changing their own password. Every other session on the
 * account is signed out by the change; this one gets a fresh token back.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const { currentPassword, newPassword } = (await req.json().catch(() => ({}))) as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword) {
    return NextResponse.json({ error: 'Both your current and new password are required' }, { status: 400 });
  }

  try {
    await changeOwnPassword({ userId: auth.user.id, currentPassword, newPassword });
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  await logAudit({ userId: auth.user.id, action: 'USER_PASSWORD_CHANGE', entityType: 'User', entityId: auth.user.id });
  return NextResponse.json({ token: signToken(auth.user.id) });
}
