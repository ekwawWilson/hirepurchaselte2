import { NextRequest, NextResponse } from 'next/server';
import { resetPasswordWithCode } from '@/lib/services/passwordResetService';
import { PortalError } from '@/lib/services/customerPortalService';
import { loginLockout, recordLoginFailure, clearLoginFailures } from '@/lib/auth/loginThrottle';
import { normalizeGhanaPhone } from '@/lib/constants/customers';
import { logAudit } from '@/lib/services/auditService';

/** Sets a new password with the code from /password-reset/request. The customer then signs in with it. */
export async function POST(req: NextRequest) {
  const { phone, code, newPassword } = (await req.json().catch(() => ({}))) as { phone?: string; code?: string; newPassword?: string };
  if (!phone || !code || !newPassword) {
    return NextResponse.json({ error: 'Your phone number, the code and a new password are required' }, { status: 400 });
  }
  // Wrong codes count like wrong passwords, per number and per address.
  const account = `portal:${normalizeGhanaPhone(phone) ?? phone.trim()}`;
  const locked = await loginLockout(req, account);
  if (locked) return locked;
  try {
    await resetPasswordWithCode({ phone, code, newPassword });
  } catch (e) {
    if (!(e instanceof PortalError)) throw e;
    await recordLoginFailure(req, account);
    return NextResponse.json({ error: e.message }, { status: 400 });
  }
  await clearLoginFailures(account);
  await logAudit({ userId: null, action: 'CUSTOMER_PASSWORD_RESET', entityType: 'Customer', newValues: { phone: normalizeGhanaPhone(phone) } });
  return NextResponse.json({ ok: true, message: 'Your password has been changed. Sign in with your new password.' });
}
