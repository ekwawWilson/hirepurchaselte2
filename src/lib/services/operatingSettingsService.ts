import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { DEFAULT_WORKING_DAYS, type WorkingDays } from '../workingDays';

/**
 * Always exactly one row — which weekend days the business operates on. See
 * schema.prisma's OperatingSettings comment for why this is read live rather
 * than snapshotted per contract the way pricing terms are.
 */
const SINGLETON_ID = 'singleton';

export interface OperatingSettingsData {
  worksSaturday: boolean;
  worksSunday: boolean;
}

const DEFAULTS: OperatingSettingsData = {
  worksSaturday: DEFAULT_WORKING_DAYS.saturday,
  worksSunday: DEFAULT_WORKING_DAYS.sunday,
};

type Db = Prisma.TransactionClient | typeof prisma;

/** Never throws, never returns null — falls back to DEFAULTS before any row has ever been saved. */
export async function getOperatingSettings(db: Db = prisma): Promise<OperatingSettingsData> {
  const row = await db.operatingSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return DEFAULTS;
  return { worksSaturday: row.worksSaturday, worksSunday: row.worksSunday };
}

/** The same settings in the shape the pure date helpers (workingDays.ts) take. */
export async function getWorkingDays(db: Db = prisma): Promise<WorkingDays> {
  const { worksSaturday, worksSunday } = await getOperatingSettings(db);
  return { saturday: worksSaturday, sunday: worksSunday };
}

export async function updateOperatingSettings(params: OperatingSettingsData & { updatedById: string }) {
  return prisma.operatingSettings.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...params },
    update: { ...params },
  });
}

export function validateOperatingSettingsBody(body: Record<string, unknown>): string | null {
  if (typeof body.worksSaturday !== 'boolean') return 'worksSaturday must be a boolean';
  if (typeof body.worksSunday !== 'boolean') return 'worksSunday must be a boolean';
  return null;
}
