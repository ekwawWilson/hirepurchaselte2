import { prisma } from '../db/prisma';

export class CustomerError extends Error {}

interface PhoneInput {
  phone?: string | null;
  phone2?: string | null;
  phone3?: string | null;
}

/** At least one of the three phone slots must carry a non-empty value. */
export function validateAtLeastOnePhone(input: PhoneInput): string | null {
  const provided = [input.phone, input.phone2, input.phone3].filter((p) => p && p.trim().length > 0);
  if (provided.length === 0) return 'At least one phone number is required';
  return null;
}

/**
 * Rejects any of the three provided numbers if it's already registered to a
 * DIFFERENT customer, in any of THEIR three slots. The schema's per-column
 * @unique constraints only catch same-slot collisions (two customers' phone2
 * both being "0244..."); this catches cross-slot ones (my phone2 matching
 * someone else's phone1) that the DB can't express on its own.
 */
export async function assertPhonesNotTaken(input: PhoneInput, excludeCustomerId?: string): Promise<string | null> {
  const numbers = [input.phone, input.phone2, input.phone3].filter((p): p is string => !!p && p.trim().length > 0);
  if (numbers.length === 0) return null;

  const clash = await prisma.customer.findFirst({
    where: {
      ...(excludeCustomerId && { id: { not: excludeCustomerId } }),
      OR: numbers.flatMap((n) => [{ phone: n }, { phone2: n }, { phone3: n }]),
    },
    select: { id: true },
  });
  return clash ? 'One of these phone numbers is already registered to another customer' : null;
}

/**
 * "The" phone number for anything that needs one canonical contact (SMS
 * recipient, direct-debit target, display) — whichever slot the customer
 * actually has a number in, preferring the main one. Never assume
 * `customer.phone` directly is non-null; only one of the three is guaranteed.
 */
export function primaryPhone(customer: PhoneInput): string | null {
  return customer.phone || customer.phone2 || customer.phone3 || null;
}

/** Every registered number for a customer, in priority order, deduplicated. */
export function allPhones(customer: PhoneInput): string[] {
  return [...new Set([customer.phone, customer.phone2, customer.phone3].filter((p): p is string => !!p))];
}
