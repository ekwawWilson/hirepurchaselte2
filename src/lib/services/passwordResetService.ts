import { createHash, randomInt, timingSafeEqual } from 'crypto';
import { prisma } from '../db/prisma';
import { deliverQueuedSms } from './smsService';
import { hashPassword } from './authService';
import { findCustomerByPhone, newPasswordProblem, PortalError } from './customerPortalService';
import { normalizeGhanaPhone } from '../constants/customers';
import { getOrgSettings } from './orgSettingsService';

/**
 * A customer resetting a forgotten password themselves (the mobile app and
 * the portal), by a 6-digit code texted to the registered number they type.
 * Holding that phone is the proof: the same proof staff rely on when they
 * hand over a temporary password.
 *
 * Asking for a code never says whether the number is registered, so the
 * form cannot be used to find out who is a customer. A code lasts ten
 * minutes, allows five tries and is used once; at most three are sent to a
 * customer an hour. Only a hash of the code is kept, and the SMS kept in the
 * message history has the code blanked out once sent, so staff can never
 * read one.
 */

const CODE_TTL_MS = 10 * 60_000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 3;
export const RESET_REQUESTED_MESSAGE = 'If this number is registered with us, a reset code has been sent to it by SMS.';
const WRONG_CODE = 'That code is not correct or has expired. Ask for a new one.';

const hashCode = (customerId: string, code: string) => createHash('sha256').update(`${customerId}:${code}`).digest('hex');

/** Sends a reset code if the number belongs to a customer. Always resolves the same way either way. */
export async function requestPasswordReset(phone: string): Promise<void> {
  const number = normalizeGhanaPhone(phone);
  if (!number) return;
  const customer = await findCustomerByPhone(number);
  if (!customer) return;

  const recent = await prisma.customerPasswordReset.count({ where: { customerId: customer.id, createdAt: { gte: new Date(Date.now() - 60 * 60_000) } } });
  if (recent >= MAX_CODES_PER_HOUR) return;

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  // A new code replaces any earlier one still waiting.
  await prisma.customerPasswordReset.updateMany({ where: { customerId: customer.id, usedAt: null }, data: { usedAt: new Date() } });
  await prisma.customerPasswordReset.create({ data: { customerId: customer.id, codeHash: hashCode(customer.id, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) } });

  const { companyName } = await getOrgSettings();
  const body = (c: string) => `${c} is your ${companyName} password reset code. It expires in 10 minutes. Do not share it with anyone, including our staff.`;
  const sms = await prisma.smsMessage.create({ data: { recipient: number, templateKey: 'customer.password_reset', body: body(code), relatedCustomerId: customer.id, status: 'QUEUED' } });
  try {
    await deliverQueuedSms(sms.id);
  } finally {
    await prisma.smsMessage.update({ where: { id: sms.id }, data: { body: body('******') } });
  }
}

/** Sets a new password with a code from requestPasswordReset. Signs out every earlier session. */
export async function resetPasswordWithCode(params: { phone: string; code: string; newPassword: string }): Promise<void> {
  const number = normalizeGhanaPhone(params.phone);
  const customer = number ? await findCustomerByPhone(number) : null;
  const code = params.code.trim();
  if (!customer || !/^\d{6}$/.test(code)) throw new PortalError(WRONG_CODE);

  const reset = await prisma.customerPasswordReset.findFirst({
    where: { customerId: customer.id, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!reset || reset.attempts >= MAX_ATTEMPTS) throw new PortalError(WRONG_CODE);

  const given = Buffer.from(hashCode(customer.id, code));
  if (!timingSafeEqual(given, Buffer.from(reset.codeHash))) {
    await prisma.customerPasswordReset.update({ where: { id: reset.id }, data: { attempts: { increment: 1 } } });
    throw new PortalError(WRONG_CODE);
  }
  // Checked only once the code is right, so a wrong code never reveals the rules were met.
  const problem = newPasswordProblem(customer, params.newPassword);
  if (problem) throw new PortalError(problem);

  await prisma.$transaction([
    prisma.customerPasswordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
    prisma.customer.update({
      where: { id: customer.id },
      data: { passwordHash: await hashPassword(params.newPassword), mustChangePassword: false, passwordChangedAt: new Date(), isActivated: true },
    }),
  ]);
}
