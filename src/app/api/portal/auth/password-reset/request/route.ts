import { NextRequest, NextResponse } from 'next/server';
import { requestPasswordReset, RESET_REQUESTED_MESSAGE } from '@/lib/services/passwordResetService';
import { loginLockout, recordLoginFailure } from '@/lib/auth/loginThrottle';
import { normalizeGhanaPhone } from '@/lib/constants/customers';

/**
 * "Forgot password": texts a reset code to the number, if it is a
 * customer's. The answer is the same whether it is or not, so this cannot
 * be used to find out who is a customer. Each request counts like a failed
 * sign-in, per number and per address, so it cannot be used to flood phones
 * with texts either (and passwordResetService sends at most three an hour).
 */
export async function POST(req: NextRequest) {
  const { phone } = (await req.json().catch(() => ({}))) as { phone?: string };
  if (!phone || !phone.trim()) return NextResponse.json({ error: 'Enter your phone number' }, { status: 400 });
  const account = `portal-reset:${normalizeGhanaPhone(phone) ?? phone.trim()}`;
  const locked = await loginLockout(req, account);
  if (locked) return locked;
  await recordLoginFailure(req, account);
  await requestPasswordReset(phone);
  return NextResponse.json({ message: RESET_REQUESTED_MESSAGE });
}
