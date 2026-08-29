import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { PAYMENT_FREQUENCIES, PRICE_CHART_TERM_MONTHS, numberOfInstalmentsForTerm, type PaymentFrequencyName } from '../constants/contracts';

export const CONTRACT_TYPES = ['SAVE_TO_OWN', 'DEPOSIT_INSTALMENT', 'DEVICE_LOAN'] as const;
export type ContractTypeName = (typeof CONTRACT_TYPES)[number];

export class PriceChartError extends Error {}

export type Tx = Prisma.TransactionClient;

/** The entry currently in force for a product/type/term/frequency combo (effectiveTo null or in the future), as of `at`. */
export async function getActivePriceChartEntry(
  productId: string,
  contractType: string,
  termMonths: number,
  paymentFrequency: string,
  at: Date = new Date(),
) {
  return prisma.priceChartEntry.findFirst({
    where: {
      productId,
      contractType,
      termMonths,
      paymentFrequency,
      effectiveFrom: { lte: at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
    },
    orderBy: { effectiveFrom: 'desc' },
  });
}

export interface EntryInput {
  productId: string;
  contractType: ContractTypeName;
  termMonths: number;
  paymentFrequency: PaymentFrequencyName;
  depositAmountMinor: number;
  totalPayableMinor: number;
  instalmentAmountMinor?: number;
  interestRateBps?: number | null;
  effectiveFrom?: Date;
  createdById: string;
}

/**
 * Creates one price chart entry and versions out whatever entry was
 * previously active for the same (product, contractType, termMonths,
 * paymentFrequency) combo — its effectiveTo is set to the new entry's
 * effectiveFrom, never deleted, so contracts that already snapshotted it are
 * unaffected. See docs/01-plan.md §6. tx-scoped core, reused by both the
 * single-entry and all-types-at-once creation paths below.
 */
export async function createPriceChartEntryInTx(tx: Tx, params: EntryInput) {
  const effectiveFrom = params.effectiveFrom ?? new Date();
  const instalmentCount = numberOfInstalmentsForTerm(params.termMonths, params.paymentFrequency);
  // The financed amount (what's actually amortized across instalments) excludes
  // the deposit — matches how contractService.ts computes the real schedule.
  const financeAmountMinor = params.totalPayableMinor - params.depositAmountMinor;
  const instalmentAmountMinor = params.instalmentAmountMinor ?? Math.ceil(financeAmountMinor / instalmentCount);

  const previous = await tx.priceChartEntry.findFirst({
    where: {
      productId: params.productId,
      contractType: params.contractType,
      termMonths: params.termMonths,
      paymentFrequency: params.paymentFrequency,
      effectiveTo: null,
    },
  });
  if (previous) {
    await tx.priceChartEntry.update({ where: { id: previous.id }, data: { effectiveTo: effectiveFrom } });
  }

  return tx.priceChartEntry.create({
    data: {
      productId: params.productId,
      contractType: params.contractType,
      termMonths: params.termMonths,
      paymentFrequency: params.paymentFrequency,
      depositAmountMinor: params.depositAmountMinor,
      totalPayableMinor: params.totalPayableMinor,
      instalmentAmountMinor,
      interestRateBps: params.interestRateBps ?? null,
      effectiveFrom,
      createdById: params.createdById,
    },
  });
}

export async function createPriceChartEntry(params: EntryInput) {
  return prisma.$transaction((tx) => createPriceChartEntryInTx(tx, params));
}

/**
 * Prices a product for a term across every contract type it's missing —
 * "a product's price chart must satisfy all three contract types" (docs/01-plan.md
 * §14): a customer choosing between Save-to-Own, Deposit+Instalment, or Device
 * Loan for a given product+term must find pricing for whichever one they pick,
 * not just whichever type an admin happened to enter first. Types that already
 * have an active entry for this exact (product, term, frequency) are skipped —
 * re-pricing an existing type is still a single-entry edit via createPriceChartEntry,
 * not this bulk "fill the gaps" path — so this never redundantly supersedes
 * something already priced correctly.
 */
export async function createPriceChartEntriesForTerm(params: {
  productId: string;
  termMonths: number;
  paymentFrequency: PaymentFrequencyName;
  createdById: string;
  entries: Partial<Record<ContractTypeName, { totalPayableMinor: number; depositAmountMinor?: number; interestRateBps?: number | null }>>;
}) {
  const productId = await prisma.product.findUnique({ where: { id: params.productId }, select: { id: true } });
  if (!productId) throw new PriceChartError('Unknown productId');

  const existing = await prisma.priceChartEntry.findMany({
    where: { productId: params.productId, termMonths: params.termMonths, paymentFrequency: params.paymentFrequency, effectiveTo: null },
    select: { contractType: true },
  });
  const alreadyPriced = new Set(existing.map((e) => e.contractType));

  const toCreate = (Object.keys(params.entries) as ContractTypeName[]).filter((type) => !alreadyPriced.has(type));
  if (toCreate.length === 0) {
    throw new PriceChartError('Every submitted contract type already has active pricing for this product/term/frequency — nothing to add');
  }

  return prisma.$transaction(async (tx) => {
    const created: Record<string, Awaited<ReturnType<typeof createPriceChartEntryInTx>>> = {};
    for (const contractType of toCreate) {
      const input = params.entries[contractType];
      if (!input) continue;
      const body: Record<string, unknown> = {
        productId: params.productId, contractType, termMonths: params.termMonths, paymentFrequency: params.paymentFrequency,
        totalPayableMinor: input.totalPayableMinor, depositAmountMinor: input.depositAmountMinor ?? 0, interestRateBps: input.interestRateBps ?? null,
      };
      const error = validateEntryBody(body);
      if (error) throw new PriceChartError(`${contractType}: ${error}`);

      created[contractType] = await createPriceChartEntryInTx(tx, {
        productId: params.productId, contractType, termMonths: params.termMonths, paymentFrequency: params.paymentFrequency,
        totalPayableMinor: input.totalPayableMinor, depositAmountMinor: input.depositAmountMinor ?? 0,
        interestRateBps: input.interestRateBps ?? null, createdById: params.createdById,
      });
    }
    return created;
  });
}

/**
 * Which of the three contract types a product has NO active pricing for at
 * all (any term, any frequency) — used to flag incomplete products in the UI.
 */
export async function missingContractTypesForProduct(productId: string): Promise<ContractTypeName[]> {
  const active = await prisma.priceChartEntry.findMany({
    where: { productId, effectiveTo: null },
    select: { contractType: true },
    distinct: ['contractType'],
  });
  const priced = new Set(active.map((e) => e.contractType));
  return CONTRACT_TYPES.filter((t) => !priced.has(t));
}

export function validateEntryBody(body: Record<string, unknown>): string | null {
  const { productId, contractType, termMonths, paymentFrequency, depositAmountMinor, totalPayableMinor, interestRateBps } = body;
  if (!productId) return 'productId is required';
  if (!(CONTRACT_TYPES as readonly string[]).includes(contractType as string)) {
    return `contractType must be one of: ${CONTRACT_TYPES.join(', ')}`;
  }
  if (typeof termMonths !== 'number' || !(PRICE_CHART_TERM_MONTHS as readonly number[]).includes(termMonths)) {
    return `termMonths must be one of: ${PRICE_CHART_TERM_MONTHS.join(', ')}`;
  }
  if (paymentFrequency !== undefined && !(PAYMENT_FREQUENCIES as readonly string[]).includes(paymentFrequency as string)) {
    return `paymentFrequency must be one of: ${PAYMENT_FREQUENCIES.join(', ')}`;
  }
  if (typeof totalPayableMinor !== 'number' || totalPayableMinor <= 0) return 'totalPayableMinor must be a positive integer';
  if (typeof depositAmountMinor !== 'number' || !Number.isInteger(depositAmountMinor) || depositAmountMinor < 0) {
    return 'depositAmountMinor must be a non-negative integer';
  }
  if (depositAmountMinor >= totalPayableMinor) {
    return 'depositAmountMinor must be less than totalPayableMinor — there has to be something left to finance';
  }
  if (contractType === 'DEVICE_LOAN' && (typeof interestRateBps !== 'number' || interestRateBps < 0)) {
    return 'interestRateBps is required for DEVICE_LOAN entries';
  }
  // SAVE_TO_OWN has no deposit (pays from zero); DEVICE_LOAN's optional down payment is
  // deferred (docs/02-loan-maths.md §1) — both must be 0 until that's implemented.
  if ((contractType === 'SAVE_TO_OWN' || contractType === 'DEVICE_LOAN') && depositAmountMinor !== 0) {
    return `depositAmountMinor must be 0 for ${contractType}`;
  }
  return null;
}

/** Minimal CSV parser: header row + comma-separated values, no quoting/escaping support (admin-authored data only). */
export function parsePriceChartCsv(csv: string): Array<Record<string, string>> {
  const lines = csv.trim().split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',').map((c) => c.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}
