import { prisma } from '../db/prisma';
import { networkForPhone } from '../constants/customers';

export interface ControlSettingsData {
  requireSecondApproval: boolean;
  ownerPhone: string | null;
  dailySummaryEnabled: boolean;
  directDebitNoticeEnabled: boolean;
  partialDirectDebitEnabled: boolean;
  blockSalesWhileDepositsUnremitted: boolean;
  parBlockEnabled: boolean;
  parBlockThresholdPercent: number;
  parBlockMinContracts: number;
}

const DEFAULTS: ControlSettingsData = {
  requireSecondApproval: true,
  ownerPhone: null,
  dailySummaryEnabled: true,
  directDebitNoticeEnabled: true,
  partialDirectDebitEnabled: true,
  blockSalesWhileDepositsUnremitted: true,
  parBlockEnabled: false,
  parBlockThresholdPercent: 20,
  parBlockMinContracts: 10,
};

/** The owner's controls and notification switches; defaults until first saved. */
export async function getControlSettings(): Promise<ControlSettingsData> {
  const row = await prisma.controlSettings.findUnique({ where: { id: 'singleton' } });
  if (!row) return DEFAULTS;
  return {
    requireSecondApproval: row.requireSecondApproval,
    ownerPhone: row.ownerPhone,
    dailySummaryEnabled: row.dailySummaryEnabled,
    directDebitNoticeEnabled: row.directDebitNoticeEnabled,
    partialDirectDebitEnabled: row.partialDirectDebitEnabled,
    blockSalesWhileDepositsUnremitted: row.blockSalesWhileDepositsUnremitted,
    parBlockEnabled: row.parBlockEnabled,
    parBlockThresholdPercent: row.parBlockThresholdPercent,
    parBlockMinContracts: row.parBlockMinContracts,
  };
}

export function validateControlSettings(body: Record<string, unknown>): string | null {
  for (const key of ['requireSecondApproval', 'dailySummaryEnabled', 'directDebitNoticeEnabled', 'partialDirectDebitEnabled'] as const) {
    if (typeof body[key] !== 'boolean') return `${key} must be true or false`;
  }
  // The sales rules are optional in a request: a screen that does not show them leaves them as they are.
  for (const key of ['blockSalesWhileDepositsUnremitted', 'parBlockEnabled'] as const) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') return `${key} must be true or false`;
  }
  if (body.parBlockThresholdPercent !== undefined && (!Number.isInteger(body.parBlockThresholdPercent) || (body.parBlockThresholdPercent as number) < 1 || (body.parBlockThresholdPercent as number) > 100)) {
    return 'The PAR limit must be a whole percentage from 1 to 100';
  }
  if (body.parBlockMinContracts !== undefined && (!Number.isInteger(body.parBlockMinContracts) || (body.parBlockMinContracts as number) < 0 || (body.parBlockMinContracts as number) > 1000)) {
    return 'The minimum book size must be a whole number from 0 to 1000';
  }
  const phone = body.ownerPhone;
  if (phone !== null && phone !== '' && (typeof phone !== 'string' || !networkForPhone(phone))) {
    return 'Owner phone must be a Ghana mobile number, e.g. 0241234567';
  }
  return null;
}

export async function updateControlSettings(data: ControlSettingsData & { updatedById: string }) {
  const { updatedById, ...values } = data;
  const fields = { ...values, ownerPhone: values.ownerPhone?.trim() || null, updatedById };
  return prisma.controlSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...fields }, update: fields });
}
