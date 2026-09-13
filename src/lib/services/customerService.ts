import { prisma } from '../db/prisma';
import { parseImageDataUrl } from '../imageData';
import { MAX_CUSTOMER_PHOTO_BYTES } from '../constants/customers';
import type { AuthenticatedUser } from '../auth/types';

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

/**
 * Every customer column staff screens may see. Never the portal password
 * hash, and never the photo — at ~20 KB each, photos would bloat every list
 * that shows customers. Use CUSTOMER_DETAIL_SELECT where one photo is wanted.
 */
export const CUSTOMER_SUMMARY_SELECT = {
  id: true, membershipId: true, firstName: true, lastName: true,
  phone: true, phone2: true, phone3: true, email: true,
  address: true, occupation: true, workAddress: true,
  nationalId: true, dateOfBirth: true, guarantorName: true, guarantorPhone: true,
  branchId: true, isActivated: true, mustChangePassword: true, portalLastLoginAt: true,
  createdById: true, updatedById: true, createdAt: true, updatedAt: true,
} as const;

export const CUSTOMER_DETAIL_SELECT = { ...CUSTOMER_SUMMARY_SELECT, photoUrl: true } as const;

/** Null if the photo is an acceptable passport JPEG, else why not. */
export function validateCustomerPhoto(photoUrl: string): string | null {
  const photo = parseImageDataUrl(photoUrl, ['image/jpeg']);
  if (!photo) return 'The customer photo must be a JPEG image taken or uploaded from the form';
  if (photo.bytes.length > MAX_CUSTOMER_PHOTO_BYTES) {
    return `The customer photo must be ${Math.round(MAX_CUSTOMER_PHOTO_BYTES / 1024)} KB or smaller`;
  }
  return null;
}

/** What registration requires, in the order the form asks for it. */
const REQUIRED_REGISTRATION_FIELDS: [string, string][] = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['phone', 'Phone number'],
  ['address', 'Residential address'],
  ['occupation', 'Occupation'],
  ['workAddress', 'Work address'],
  ['photoUrl', 'Customer photo'],
];

export function validateRegistration(body: Record<string, string | undefined>): string | null {
  const missing = REQUIRED_REGISTRATION_FIELDS.filter(([key]) => !body[key]?.trim()).map(([, label]) => label);
  if (missing.length) return `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} required`;
  return validateCustomerPhoto(body.photoUrl!);
}

/**
 * The branch a new customer belongs to: always the registering user's own.
 * A user who covers every branch has none of their own, so they register
 * into the business's only branch — and, once there is more than one, must
 * be assigned a branch first rather than guess which it should be.
 */
export async function registrationBranch(user: AuthenticatedUser) {
  if (user.branchId) return prisma.branch.findUnique({ where: { id: user.branchId } });
  const branches = await prisma.branch.findMany({ where: { isActive: true }, take: 2 });
  return branches.length === 1 ? branches[0] : null;
}
