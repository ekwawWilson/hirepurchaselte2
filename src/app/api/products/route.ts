import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { CONTRACT_TYPES, createPriceChartEntryInTx, validateEntryBody } from '@/lib/services/priceChartService';
import { PRICE_CHART_TERM_MONTHS } from '@/lib/constants/contracts';
import { generateProductSku } from '@/lib/utils/idGenerators';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const { searchParams } = req.nextUrl;
  const q = searchParams.get('q') ?? undefined;
  const categoryId = searchParams.get('categoryId') ?? undefined;
  const isActiveParam = searchParams.get('isActive');

  const where: Record<string, unknown> = {};
  if (q) where.OR = [{ name: { contains: q } }, { sku: { contains: q } }, { brand: { contains: q } }, { model: { contains: q } }];
  if (categoryId) where.categoryId = categoryId;
  if (isActiveParam !== null) where.isActive = isActiveParam === 'true';

  const products = await prisma.product.findMany({ where, include: { category: true }, orderBy: { name: 'asc' } });

  // Every product's price chart should cover all three contract types (docs/01-plan.md
  // §14) — flag which ones don't yet, in one query rather than N+1 per product.
  const pricedRows = await prisma.priceChartEntry.findMany({
    where: { productId: { in: products.map((p) => p.id) }, effectiveTo: null },
    select: { productId: true, contractType: true },
    distinct: ['productId', 'contractType'],
  });
  const pricedByProduct = new Map<string, Set<string>>();
  for (const row of pricedRows) {
    if (!pricedByProduct.has(row.productId)) pricedByProduct.set(row.productId, new Set());
    pricedByProduct.get(row.productId)!.add(row.contractType);
  }
  const productsWithCoverage = products.map((p) => ({
    ...p,
    missingContractTypes: CONTRACT_TYPES.filter((t) => !pricedByProduct.get(p.id)?.has(t)),
  }));

  return NextResponse.json({ products: productsWithCoverage });
}

interface TermPricingInput {
  totalPayableMinor?: number;
  depositAmountMinor?: number;
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.receive');
  if (!perm.authorized) return perm.error;

  const { sku: skuInput, name, description, categoryId, brand, model, cashPriceMinor, imageUrl, termPricing } =
    (await req.json()) as Record<string, unknown>;
  if (!name || typeof cashPriceMinor !== 'number' || cashPriceMinor <= 0) {
    return NextResponse.json({ error: 'name and a positive cashPriceMinor are required' }, { status: 400 });
  }

  const skuValue = typeof skuInput === 'string' && skuInput.trim() ? skuInput.trim() : null;
  if (skuValue) {
    const existing = await prisma.product.findUnique({ where: { sku: skuValue } });
    if (existing) return NextResponse.json({ error: 'A product with this SKU already exists' }, { status: 409 });
  }

  // Optional "price this product for Deposit + Instalment across the 3/4/6-month
  // terms in one step" bundle — mirrors the legacy admin's product-creation screen
  // (docs/01-plan.md §14). A blank period is skipped, not defaulted; every non-blank
  // period is validated in full BEFORE anything is created, so a bad figure on one
  // period never leaves a half-priced product behind. Doesn't touch Save-to-Own or
  // Device Loan pricing — those still go through the Price Chart page.
  const termEntries: Array<{ termMonths: number; totalPayableMinor: number; depositAmountMinor: number }> = [];
  if (termPricing && typeof termPricing === 'object' && !Array.isArray(termPricing)) {
    const byTerm = termPricing as Record<string, TermPricingInput | undefined>;
    for (const term of PRICE_CHART_TERM_MONTHS) {
      const raw = byTerm[String(term)];
      if (!raw || raw.totalPayableMinor === undefined || raw.totalPayableMinor === null) continue;

      const totalPayableMinor = raw.totalPayableMinor;
      const depositAmountMinor = raw.depositAmountMinor ?? 0;
      const error = validateEntryBody({
        productId: 'pending', contractType: 'DEPOSIT_INSTALMENT', termMonths: term,
        paymentFrequency: 'MONTHLY', totalPayableMinor, depositAmountMinor,
      });
      if (error) return NextResponse.json({ error: `${term}-month pricing: ${error}` }, { status: 400 });
      termEntries.push({ termMonths: term, totalPayableMinor, depositAmountMinor });
    }
  }

  const sku = skuValue ?? (await generateProductSku());
  const product = await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: {
        sku,
        name: name as string,
        description: (description as string) || null,
        categoryId: (categoryId as string) || null,
        brand: (brand as string) || null,
        model: (model as string) || null,
        cashPriceMinor,
        imageUrl: (imageUrl as string) || null,
      },
    });
    for (const entry of termEntries) {
      await createPriceChartEntryInTx(tx, {
        productId: created.id, contractType: 'DEPOSIT_INSTALMENT', termMonths: entry.termMonths,
        paymentFrequency: 'MONTHLY', totalPayableMinor: entry.totalPayableMinor,
        depositAmountMinor: entry.depositAmountMinor, createdById: auth.user.id,
      });
    }
    return created;
  });

  return NextResponse.json({ product }, { status: 201 });
}
