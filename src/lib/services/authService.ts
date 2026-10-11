import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma';

export class AuthError extends Error {}

export const MIN_STAFF_PASSWORD_LENGTH = 8;

const rounds = () => Number(process.env.BCRYPT_ROUNDS) || 10;
export const hashPassword = (password: string) => bcrypt.hash(password, rounds());

/** Null if `password` will do for a staff account, else why not. */
export function staffPasswordProblem(password: string, email?: string): string | null {
  if (password.length < MIN_STAFF_PASSWORD_LENGTH) return `The password must be at least ${MIN_STAFF_PASSWORD_LENGTH} characters`;
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return 'The password must contain at least one letter and one number';
  if (email && password.toLowerCase() === email.toLowerCase()) return 'The password cannot be the email address';
  return null;
}

/**
 * A uniform random integer in [0, max) from the platform's secure generator.
 * Web Crypto rather than Node's `crypto` module, because this file is also
 * bundled for the Edge runtime (through instrumentation.ts's imports).
 */
function randomInt(max: number): number {
  const limit = Math.floor(0x1_0000_0000 / max) * max; // reject the uneven tail, so every value is equally likely
  const buffer = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(buffer); } while (buffer[0] >= limit);
  return buffer[0] % max;
}

// No 0/O, 1/l/I: a temporary password is read off a screen and typed by hand.
const READABLE = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A one-time staff password — random, and always satisfying staffPasswordProblem. */
export function generateTemporaryPassword(length = 10): string {
  for (;;) {
    const candidate = Array.from({ length }, () => READABLE[randomInt(READABLE.length)]).join('');
    if (!staffPasswordProblem(candidate)) return candidate;
  }
}

/** A one-time portal password: six digits, easy to read out to a customer. */
export function generatePortalPassword(): string {
  return String(randomInt(1_000_000)).padStart(6, '0');
}

/**
 * A member of staff choosing their own password. Stamps passwordChangedAt, so
 * every token issued before now stops working (rbac.ts) — the caller signs a
 * fresh one for the session that made the change.
 */
export async function changeOwnPassword(params: { userId: string; currentPassword: string; newPassword: string }) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: params.userId } });
  if (!(await bcrypt.compare(params.currentPassword, user.passwordHash))) throw new AuthError('Your current password is not correct');
  const problem = staffPasswordProblem(params.newPassword, user.email);
  if (problem) throw new AuthError(problem);
  if (await bcrypt.compare(params.newPassword, user.passwordHash)) throw new AuthError('Choose a password different from your current one');

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await hashPassword(params.newPassword), mustChangePassword: false, passwordChangedAt: new Date() },
  });
}

/**
 * An administrator resetting someone else's password. The new one is random,
 * returned once for the administrator to pass on, and must be replaced at the
 * next sign-in — so the administrator never ends up knowing a working password.
 */
export async function resetUserPassword(userId: string): Promise<string> {
  const temporaryPassword = generateTemporaryPassword();
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(temporaryPassword), mustChangePassword: true, passwordChangedAt: new Date() },
  });
  return temporaryPassword;
}

/** Whether a token issued at `iat` (seconds) predates the holder's last password change. */
export function issuedBeforePasswordChange(iat: number | undefined, passwordChangedAt: Date | null): boolean {
  if (!passwordChangedAt || iat === undefined) return false;
  return iat < Math.floor(passwordChangedAt.getTime() / 1000);
}
