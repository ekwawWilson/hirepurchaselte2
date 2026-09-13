import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import type { ContractTypeName } from '../constants/contracts';

/**
 * Always exactly one row — which optional contract types the business
 * offers. See schema.prisma's ContractTypeSettings comment for why this gates
 * only new contracts, never ones already created.
 */
const SINGLETON_ID = 'singleton';

export interface ContractTypeSettingsData {
  saveToOwnEnabled: boolean;
  deviceLoanEnabled: boolean;
}

// Off until an admin activates them.
const DEFAULTS: ContractTypeSettingsData = { saveToOwnEnabled: false, deviceLoanEnabled: false };

type Db = Prisma.TransactionClient | typeof prisma;

/** Never throws, never returns null — falls back to DEFAULTS before any row has ever been saved. */
export async function getContractTypeSettings(db: Db = prisma): Promise<ContractTypeSettingsData> {
  const row = await db.contractTypeSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return DEFAULTS;
  return { saveToOwnEnabled: row.saveToOwnEnabled, deviceLoanEnabled: row.deviceLoanEnabled };
}

export async function updateContractTypeSettings(params: ContractTypeSettingsData & { updatedById: string }) {
  return prisma.contractTypeSettings.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...params },
    update: { ...params },
  });
}

export function validateContractTypeSettingsBody(body: Record<string, unknown>): string | null {
  if (typeof body.saveToOwnEnabled !== 'boolean') return 'saveToOwnEnabled must be a boolean';
  if (typeof body.deviceLoanEnabled !== 'boolean') return 'deviceLoanEnabled must be a boolean';
  return null;
}

/** DEPOSIT_INSTALMENT is always offered; the other two only once activated. */
export function isContractTypeEnabled(settings: ContractTypeSettingsData, contractType: ContractTypeName): boolean {
  if (contractType === 'SAVE_TO_OWN') return settings.saveToOwnEnabled;
  if (contractType === 'DEVICE_LOAN') return settings.deviceLoanEnabled;
  return true;
}
