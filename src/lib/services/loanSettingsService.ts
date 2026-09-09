import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';

/**
 * Always exactly one row — the global DEVICE_LOAN terms every new loan
 * snapshots onto itself at creation (contractService.ts). See
 * schema.prisma's LoanSettings comment.
 */
const SINGLETON_ID = 'singleton';

export interface LoanSettingsData {
  dailyInterestRateBps: number;
  interestGraceDays: number;
}

const DEFAULTS: LoanSettingsData = {
  dailyInterestRateBps: 100, // 1%/day
  interestGraceDays: 0,
};

type Db = Prisma.TransactionClient | typeof prisma;

/** Never throws, never returns null — falls back to DEFAULTS before any row has ever been saved. */
export async function getLoanSettings(db: Db = prisma): Promise<LoanSettingsData> {
  const row = await db.loanSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return DEFAULTS;
  return { dailyInterestRateBps: row.dailyInterestRateBps, interestGraceDays: row.interestGraceDays };
}

export async function updateLoanSettings(params: LoanSettingsData & { updatedById: string }) {
  return prisma.loanSettings.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...params },
    update: { ...params },
  });
}

export function validateLoanSettingsBody(body: Record<string, unknown>): string | null {
  const { dailyInterestRateBps, interestGraceDays } = body;
  if (typeof dailyInterestRateBps !== 'number' || !Number.isInteger(dailyInterestRateBps) || dailyInterestRateBps <= 0) {
    return 'dailyInterestRateBps must be a positive integer (100 = 1%/day)';
  }
  if (typeof interestGraceDays !== 'number' || !Number.isInteger(interestGraceDays) || interestGraceDays < 0) {
    return 'interestGraceDays must be a non-negative integer';
  }
  return null;
}
