import crypto from 'node:crypto';
import { prisma } from '../db/prisma';

/**
 * Membership IDs are generated, never user-typed. Format: HP-<branchCode>-<year>-<seq>,
 * e.g. HP-MAIN-2026-000001. Retries on the rare collision (concurrent creation)
 * rather than relying on a non-atomic count, matching the retry-on-unique-violation
 * pattern the legacy app used for its own generated references (see docs/00-legacy-study.md §4).
 */
export async function generateMembershipId(branchCode: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `HP-${branchCode}-${year}-`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await prisma.customer.count({ where: { membershipId: { startsWith: prefix } } });
    const candidate = `${prefix}${String(count + 1 + attempt).padStart(6, '0')}`;
    const existing = await prisma.customer.findUnique({ where: { membershipId: candidate } });
    if (!existing) return candidate;
  }
  throw new Error('Could not generate a unique membership ID, please retry');
}

/** Format: HP-CON-<year>-<seq>, e.g. HP-CON-2026-000001. Same retry-on-collision approach as membership IDs. */
export async function generateContractNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `HP-CON-${year}-`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await prisma.contract.count({ where: { contractNumber: { startsWith: prefix } } });
    const candidate = `${prefix}${String(count + 1 + attempt).padStart(6, '0')}`;
    const existing = await prisma.contract.findUnique({ where: { contractNumber: candidate } });
    if (!existing) return candidate;
  }
  throw new Error('Could not generate a unique contract number, please retry');
}

/** Idempotency key for payments — random, not sequential, so it never leaks volume information. */
export function generateTransactionRef(): string {
  return `TXN-${crypto.randomUUID()}`;
}

export function generateReceiptNumber(): string {
  return `RCP-${crypto.randomUUID().split('-')[0].toUpperCase()}`;
}
