import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { DEFAULT_WORKING_DAYS, isWorkingDay, type WorkingDays } from '../workingDays';

/**
 * Always exactly one row — which weekend days the business operates on. See
 * schema.prisma's OperatingSettings comment for why this is read live rather
 * than snapshotted per contract the way pricing terms are.
 */
const SINGLETON_ID = 'singleton';

export interface OperatingSettingsData {
  worksSaturday: boolean;
  worksSunday: boolean;
  acceptsPaymentsOnClosedDays: boolean;
}

const DEFAULTS: OperatingSettingsData = {
  worksSaturday: DEFAULT_WORKING_DAYS.saturday,
  worksSunday: DEFAULT_WORKING_DAYS.sunday,
  acceptsPaymentsOnClosedDays: true,
};

/** Thrown when a payment is initiated on a closed day and that's been turned off. */
export class PaymentsClosedError extends Error {}

type Db = Prisma.TransactionClient | typeof prisma;

/** Never throws, never returns null — falls back to DEFAULTS before any row has ever been saved. */
export async function getOperatingSettings(db: Db = prisma): Promise<OperatingSettingsData> {
  const row = await db.operatingSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return DEFAULTS;
  return {
    worksSaturday: row.worksSaturday,
    worksSunday: row.worksSunday,
    acceptsPaymentsOnClosedDays: row.acceptsPaymentsOnClosedDays,
  };
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
  if (typeof body.acceptsPaymentsOnClosedDays !== 'boolean') return 'acceptsPaymentsOnClosedDays must be a boolean';
  return null;
}

/**
 * Pure decision behind assertPaymentsAcceptedToday — a payment may start
 * unless the business is closed today AND closed-day payments are off.
 */
export function arePaymentsAccepted(settings: OperatingSettingsData, now: Date): boolean {
  if (settings.acceptsPaymentsOnClosedDays) return true;
  return isWorkingDay(now, { saturday: settings.worksSaturday, sunday: settings.worksSunday });
}

/**
 * Guard for the points where a NEW payment is started: the cash/device-loan
 * routes and the USSD confirm step. Deliberately not inside postPayment /
 * postDeviceLoanPayment — those are also the sink for Hubtel callbacks, and a
 * callback arrives only after Hubtel has already taken the customer's money.
 * Refusing there would mark the transaction collected and never record the
 * payment, which is strictly worse than accepting it on a closed day.
 */
export async function assertPaymentsAcceptedToday(now: Date = new Date()): Promise<void> {
  if (arePaymentsAccepted(await getOperatingSettings(), now)) return;
  throw new PaymentsClosedError(
    'The business is closed today and payments on closed days are turned off (Settings > Working days)',
  );
}
