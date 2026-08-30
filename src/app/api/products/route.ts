import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { CONTRACT_TYPES, createPriceChartEntryInTx, parseTermPricingBundle } from '@/lib/services/priceChartService';
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

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.receive');
  if (!perm.authorized) return perm.error;

  const { sku: skuInput, name, description, categoryId, brand, model, cashPriceMinor, imageUrl, termPricing, deviceLoanPricing } =
    (await req.json()) as Record<string, unknown>;
  if (!name || typeof cashPriceMinor !== 'number' || cashPriceMinor <= 0) {
    return NextResponse.json({ error: 'name and a positive cashPriceMinor are required' }, { status: 400 });
  }

  const skuValue = typeof skuInput === 'string' && skuInput.trim() ? skuInput.trim() : null;
  if (skuValue) {
    const existing = await prisma.product.findUnique({ where: { sku: skuValue } });
    if (existing) return NextResponse.json({ error: 'A product with this SKU already exists' }, { status: 409 });
  }

  // Optional "price this product across the 3/4/6-month terms in one step" bundles —
  // mirrors the legacy admin's product-creation screen (docs/01-plan.md §14). A blank
  // period is skipped, not defaulted; every non-blank period across BOTH bundles is
  // validated in full BEFORE anything is created, so a bad figure never leaves a
  // half-priced product behind. Save-to-Own pricing still only goes through the
  // Price Chart page's bundle form for now.
  const depositResult = parseTermPricingBundle('DEPOSIT_INSTALMENT', termPricing);
  if ('error' in depositResult) return NextResponse.json({ error: depositResult.error }, { status: 400 });
  const deviceLoanResult = parseTermPricingBundle('DEVICE_LOAN', deviceLoanPricing);
  if ('error' in deviceLoanResult) return NextResponse.json({ error: deviceLoanResult.error }, { status: 400 });

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
    for (const entry of depositResult.entries) {
      await createPriceChartEntryInTx(tx, {
        productId: created.id, contractType: 'DEPOSIT_INSTALMENT', termMonths: entry.termMonths,
        paymentFrequency: 'MONTHLY', totalPayableMinor: entry.totalPayableMinor,
        depositAmountMinor: entry.depositAmountMinor, createdById: auth.user.id,
      });
    }
    for (const entry of deviceLoanResult.entries) {
      await createPriceChartEntryInTx(tx, {
        productId: created.id, contractType: 'DEVICE_LOAN', termMonths: entry.termMonths,
        paymentFrequency: 'MONTHLY', totalPayableMinor: entry.totalPayableMinor,
        depositAmountMinor: 0, interestRateBps: entry.interestRateBps, createdById: auth.user.id,
      });
    }
    return created;
  });

  return NextResponse.json({ product }, { status: 201 });
}
