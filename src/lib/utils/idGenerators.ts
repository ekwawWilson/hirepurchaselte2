import crypto from 'node:crypto';
import { prisma } from '../db/prisma';

/**
 * The letters every generated customer and contract reference starts with:
 * the company's initials, from Settings. Words split on spaces and on
 * capitals inside a word, so "Accra Mobile Finance" gives AMF and "FlezePay"
 * gives FP; a single plain word gives its first two letters. At most three
 * letters, and only A-Z so an ID stays easy to read out and type.
 */
export function referencePrefix(companyName: string): string {
  const words = companyName
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z]+/)
    .filter(Boolean);
  if (words.length === 0) return 'HP';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return words.slice(0, 3).map((w) => w[0]).join('').toUpperCase();
}

async function companyPrefix(): Promise<string> {
  // Dynamic import: orgSettingsService pulls in Prisma, and this module is
  // also imported by code that only wants the pure helpers above.
  const { getOrgSettings } = await import('../services/orgSettingsService');
  return referencePrefix((await getOrgSettings()).companyName);
}

/**
 * Membership IDs are generated, never user-typed. Format:
 * <initials>-<branchCode>-<year>-<seq>, e.g. FP-MAIN-2026-000001. The sequence
 * counts within that exact prefix, so IDs issued before a company rename (or
 * before initials were used, as HP-...) are never reused. Retries on the rare
 * collision (concurrent creation) rather than relying on a non-atomic count.
 */
export async function generateMembershipId(branchCode: string): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `${await companyPrefix()}-${branchCode}-${year}-`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await prisma.customer.count({ where: { membershipId: { startsWith: prefix } } });
    const candidate = `${prefix}${String(count + 1 + attempt).padStart(6, '0')}`;
    const existing = await prisma.customer.findUnique({ where: { membershipId: candidate } });
    if (!existing) return candidate;
  }
  throw new Error('Could not generate a unique membership ID, please retry');
}

/** Format: <initials>-CON-<year>-<seq>, e.g. FP-CON-2026-000001. Same approach as membership IDs. */
export async function generateContractNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `${await companyPrefix()}-CON-${year}-`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await prisma.contract.count({ where: { contractNumber: { startsWith: prefix } } });
    const candidate = `${prefix}${String(count + 1 + attempt).padStart(6, '0')}`;
    const existing = await prisma.contract.findUnique({ where: { contractNumber: candidate } });
    if (!existing) return candidate;
  }
  throw new Error('Could not generate a unique contract number, please retry');
}

/** Format: PRD-<year>-<seq>, e.g. PRD-2026-000001. Used when an admin doesn't type their own SKU. Same retry-on-collision approach as membership IDs. */
export async function generateProductSku(): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = `PRD-${year}-`;

  for (let attempt = 0; attempt < 5; attempt++) {
    const count = await prisma.product.count({ where: { sku: { startsWith: prefix } } });
    const candidate = `${prefix}${String(count + 1 + attempt).padStart(6, '0')}`;
    const existing = await prisma.product.findUnique({ where: { sku: candidate } });
    if (!existing) return candidate;
  }
  throw new Error('Could not generate a unique SKU, please retry');
}

/** Idempotency key for payments — random, not sequential, so it never leaks volume information. */
export function generateTransactionRef(): string {
  return `TXN-${crypto.randomUUID()}`;
}

export function generateReceiptNumber(): string {
  return `RCP-${crypto.randomUUID().split('-')[0].toUpperCase()}`;
}
