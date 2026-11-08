import { prisma } from '../db/prisma';
import { cleanMobileNumber } from './customerService';
import { phoneVariants } from './hubtelClient';

/**
 * A staff member's mobile number as typed on the Users page: blank clears it.
 * An agent's short code receipts are texted to it, so it must be a real mobile
 * number and no one else's on the staff list.
 */
export async function cleanStaffPhone(input: string, excludeUserId?: string): Promise<{ phone: string | null } | { error: string }> {
  if (!input.trim()) return { phone: null };
  const cleaned = cleanMobileNumber(input, 'The mobile number');
  if ('error' in cleaned) return cleaned;
  const taken = await prisma.user.findFirst({
    where: { phone: { in: phoneVariants(cleaned.phone) }, ...(excludeUserId && { id: { not: excludeUserId } }) },
    select: { firstName: true, lastName: true },
  });
  return taken ? { error: `${taken.firstName} ${taken.lastName} already has this mobile number` } : cleaned;
}
