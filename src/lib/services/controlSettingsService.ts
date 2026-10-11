import { prisma } from '../db/prisma';
import { networkForPhone } from '../constants/customers';

export interface ControlSettingsData {
  requireSecondApproval: boolean;
  ownerPhone: string | null;
  dailySummaryEnabled: boolean;
  directDebitNoticeEnabled: boolean;
  partialDirectDebitEnabled: boolean;
}

const DEFAULTS: ControlSettingsData = {
  requireSecondApproval: true,
  ownerPhone: null,
  dailySummaryEnabled: true,
  directDebitNoticeEnabled: true,
  partialDirectDebitEnabled: true,
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
  };
}

export function validateControlSettings(body: Record<string, unknown>): string | null {
  for (const key of ['requireSecondApproval', 'dailySummaryEnabled', 'directDebitNoticeEnabled', 'partialDirectDebitEnabled'] as const) {
    if (typeof body[key] !== 'boolean') return `${key} must be true or false`;
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
