import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';

/**
 * Always exactly one row — the fixed amount an AGENT keeps out of every cash
 * deposit they collect. Snapshotted onto AgentDepositLedger.commissionAmountMinor
 * the moment a deposit is recorded (paymentService.postPayment), so a later
 * change here never re-prices a deal already settled — see schema.prisma's
 * CommissionSettings comment.
 */
const SINGLETON_ID = 'singleton';

export interface CommissionSettingsData {
  fixedCommissionMinor: number;
}

const DEFAULTS: CommissionSettingsData = {
  fixedCommissionMinor: 0,
};

type Db = Prisma.TransactionClient | typeof prisma;

/** Never throws, never returns null — falls back to DEFAULTS before any row has ever been saved. */
export async function getCommissionSettings(db: Db = prisma): Promise<CommissionSettingsData> {
  const row = await db.commissionSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return DEFAULTS;
  return { fixedCommissionMinor: row.fixedCommissionMinor };
}

export async function updateCommissionSettings(params: CommissionSettingsData & { updatedById: string }) {
  return prisma.commissionSettings.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...params },
    update: { ...params },
  });
}

export function validateCommissionSettingsBody(body: Record<string, unknown>): string | null {
  const { fixedCommissionMinor } = body;
  if (typeof fixedCommissionMinor !== 'number' || !Number.isInteger(fixedCommissionMinor) || fixedCommissionMinor < 0) {
    return 'fixedCommissionMinor must be a non-negative integer';
  }
  return null;
}
