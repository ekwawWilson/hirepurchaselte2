import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { CONTRACT_TYPES } from '@/lib/services/priceChartService';

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

  const { sku, name, description, categoryId, brand, model, cashPriceMinor, imageUrl } = (await req.json()) as Record<string, unknown>;
  if (!sku || !name || typeof cashPriceMinor !== 'number' || cashPriceMinor <= 0) {
    return NextResponse.json({ error: 'sku, name, and a positive cashPriceMinor are required' }, { status: 400 });
  }

  const existing = await prisma.product.findUnique({ where: { sku: sku as string } });
  if (existing) return NextResponse.json({ error: 'A product with this SKU already exists' }, { status: 409 });

  const product = await prisma.product.create({
    data: {
      sku: sku as string,
      name: name as string,
      description: (description as string) || null,
      categoryId: (categoryId as string) || null,
      brand: (brand as string) || null,
      model: (model as string) || null,
      cashPriceMinor,
      imageUrl: (imageUrl as string) || null,
    },
  });
  return NextResponse.json({ product }, { status: 201 });
}
