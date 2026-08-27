import { prisma } from '../db/prisma';
import { PAYMENT_FREQUENCIES, numberOfInstalmentsForTerm, type PaymentFrequencyName } from '../constants/contracts';

export const CONTRACT_TYPES = ['SAVE_TO_OWN', 'DEPOSIT_INSTALMENT', 'DEVICE_LOAN'] as const;
export type ContractTypeName = (typeof CONTRACT_TYPES)[number];

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

/**
 * Creates a new price chart entry and versions out whatever entry was
 * previously active for the same (product, contractType, termMonths) combo —
 * its effectiveTo is set to the new entry's effectiveFrom, never deleted, so
 * contracts that already snapshotted it are unaffected. See docs/01-plan.md §6.
 */
export async function createPriceChartEntry(params: {
  productId: string;
  contractType: ContractTypeName;
  termMonths: number;
  paymentFrequency: PaymentFrequencyName;
  depositPercentage: number;
  totalPayableMinor: number;
  instalmentAmountMinor?: number;
  interestRateBps?: number | null;
  effectiveFrom?: Date;
  createdById: string;
}) {
  const effectiveFrom = params.effectiveFrom ?? new Date();
  const instalmentCount = numberOfInstalmentsForTerm(params.termMonths, params.paymentFrequency);
  const instalmentAmountMinor = params.instalmentAmountMinor ?? Math.ceil(params.totalPayableMinor / instalmentCount);

  return prisma.$transaction(async (tx) => {
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
        depositPercentage: params.depositPercentage,
        totalPayableMinor: params.totalPayableMinor,
        instalmentAmountMinor,
        interestRateBps: params.interestRateBps ?? null,
        effectiveFrom,
        createdById: params.createdById,
      },
    });
  });
}

export function validateEntryBody(body: Record<string, unknown>): string | null {
  const { productId, contractType, termMonths, paymentFrequency, depositPercentage, totalPayableMinor, interestRateBps } = body;
  if (!productId) return 'productId is required';
  if (!(CONTRACT_TYPES as readonly string[]).includes(contractType as string)) {
    return `contractType must be one of: ${CONTRACT_TYPES.join(', ')}`;
  }
  if (typeof termMonths !== 'number' || !Number.isInteger(termMonths) || termMonths < 1 || termMonths > 60) {
    return 'termMonths must be a whole number between 1 and 60';
  }
  if (paymentFrequency !== undefined && !(PAYMENT_FREQUENCIES as readonly string[]).includes(paymentFrequency as string)) {
    return `paymentFrequency must be one of: ${PAYMENT_FREQUENCIES.join(', ')}`;
  }
  if (typeof depositPercentage !== 'number' || depositPercentage < 0 || depositPercentage > 100) {
    return 'depositPercentage must be between 0 and 100';
  }
  if (typeof totalPayableMinor !== 'number' || totalPayableMinor <= 0) return 'totalPayableMinor must be a positive integer';
  if (contractType === 'DEVICE_LOAN' && (typeof interestRateBps !== 'number' || interestRateBps < 0)) {
    return 'interestRateBps is required for DEVICE_LOAN entries';
  }
  // SAVE_TO_OWN has no deposit (pays from zero); DEVICE_LOAN's optional down payment is
  // deferred (docs/02-loan-maths.md §1) — both must be 0 until that's implemented.
  if ((contractType === 'SAVE_TO_OWN' || contractType === 'DEVICE_LOAN') && depositPercentage !== 0) {
    return `depositPercentage must be 0 for ${contractType}`;
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
