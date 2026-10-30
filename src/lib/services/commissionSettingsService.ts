import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';

/**
 * What an AGENT keeps out of a cash deposit they collect depends on the kind
 * of product sold: each product category may carry its own amount
 * (ProductCategory.agentCommissionMinor), and the one default amount here
 * covers every category that has none, and any product with no category.
 * Whatever applies is snapshotted onto AgentDepositLedger the moment the
 * deposit is recorded, so a later change never re-prices a deposit already
 * taken — see schema.prisma's CommissionSettings comment.
 */
const SINGLETON_ID = 'singleton';

export interface CategoryCommission {
  categoryId: string;
  name: string;
  /** Null: the default amount applies. */
  commissionMinor: number | null;
}

export interface CommissionSettingsData {
  fixedCommissionMinor: number;
  /** Held back from each agent sale, paid when the customer completes (completionCommissionService). */
  deferredCommissionMinor: number;
  /** Added on top, paid when the customer completes. */
  completionBonusMinor: number;
}

export interface CommissionSettingsView extends CommissionSettingsData {
  categories: CategoryCommission[];
}

const DEFAULTS: CommissionSettingsData = { fixedCommissionMinor: 0, deferredCommissionMinor: 0, completionBonusMinor: 0 };

type Db = Prisma.TransactionClient | typeof prisma;

/** Never throws, never returns null — falls back to DEFAULTS before any row has ever been saved. */
export async function getCommissionSettings(db: Db = prisma): Promise<CommissionSettingsData> {
  const row = await db.commissionSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return DEFAULTS;
  return { fixedCommissionMinor: row.fixedCommissionMinor, deferredCommissionMinor: row.deferredCommissionMinor, completionBonusMinor: row.completionBonusMinor };
}

/** The default amount and every product category's own amount, for the Settings screen. */
export async function getCommissionSettingsView(): Promise<CommissionSettingsView> {
  const [settings, categories] = await Promise.all([
    getCommissionSettings(),
    prisma.productCategory.findMany({ orderBy: { name: 'asc' }, select: { id: true, name: true, agentCommissionMinor: true } }),
  ]);
  return {
    ...settings,
    categories: categories.map((c) => ({ categoryId: c.id, name: c.name, commissionMinor: c.agentCommissionMinor })),
  };
}

/**
 * The commission for a deposit on this contract: its product's category
 * amount if that category has one, else the default.
 */
export async function commissionForContract(db: Db, contractId: string): Promise<{ commissionMinor: number; categoryName: string | null }> {
  const contract = await db.contract.findUnique({
    where: { id: contractId },
    select: { product: { select: { category: { select: { name: true, agentCommissionMinor: true } } } } },
  });
  const category = contract?.product?.category;
  if (category && category.agentCommissionMinor !== null) {
    return { commissionMinor: category.agentCommissionMinor, categoryName: category.name };
  }
  return { commissionMinor: (await getCommissionSettings(db)).fixedCommissionMinor, categoryName: null };
}

export async function updateCommissionSettings(params: Pick<CommissionSettingsData, 'fixedCommissionMinor'> & Partial<CommissionSettingsData> & {
  updatedById: string;
  /** Only the categories listed are changed; null puts one back on the default. */
  categoryRates?: { categoryId: string; commissionMinor: number | null }[];
}) {
  const { categoryRates = [], ...settings } = params;
  return prisma.$transaction(async (tx) => {
    for (const rate of categoryRates) {
      await tx.productCategory.update({ where: { id: rate.categoryId }, data: { agentCommissionMinor: rate.commissionMinor } });
    }
    return tx.commissionSettings.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...settings },
      update: settings,
    });
  });
}

const isAmount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

export async function validateCommissionSettingsBody(body: Record<string, unknown>): Promise<string | null> {
  if (!isAmount(body.fixedCommissionMinor)) return 'fixedCommissionMinor must be a non-negative integer';
  // Optional: a screen that does not show the split leaves it as it is.
  for (const key of ['deferredCommissionMinor', 'completionBonusMinor'] as const) {
    if (body[key] !== undefined && !isAmount(body[key])) return `${key} must be a non-negative integer`;
  }
  if (body.categoryRates === undefined) return null;
  if (!Array.isArray(body.categoryRates)) return 'categoryRates must be a list';
  const ids = new Set<string>();
  for (const rate of body.categoryRates as Record<string, unknown>[]) {
    if (!rate || typeof rate.categoryId !== 'string') return 'Each category rate needs a categoryId';
    if (rate.commissionMinor !== null && !isAmount(rate.commissionMinor)) return 'A category commission must be a non-negative amount, or empty to use the default';
    if (ids.has(rate.categoryId)) return 'A category is listed twice';
    ids.add(rate.categoryId);
  }
  const found = await prisma.productCategory.count({ where: { id: { in: [...ids] } } });
  if (found !== ids.size) return 'One of the product categories no longer exists';
  return null;
}
