import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
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
  return NextResponse.json({ products });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.receive');
  if (!perm.authorized) return perm.error;

  // Just the base price (cashPriceMinor) — no per-contract-type pricing tiers
  // at creation time. DEPOSIT_INSTALMENT's total/deposit/term and DEVICE_LOAN's
  // loan amount are entered directly at contract creation now, not looked up
  // from a price chart (contractService.ts).
  const { sku: skuInput, name, description, categoryId, brand, model, cashPriceMinor, imageUrl } =
    (await req.json()) as Record<string, unknown>;
  if (!name || typeof cashPriceMinor !== 'number' || cashPriceMinor <= 0) {
    return NextResponse.json({ error: 'name and a positive cashPriceMinor are required' }, { status: 400 });
  }

  const skuValue = typeof skuInput === 'string' && skuInput.trim() ? skuInput.trim() : null;
  if (skuValue) {
    const existing = await prisma.product.findUnique({ where: { sku: skuValue } });
    if (existing) return NextResponse.json({ error: 'A product with this SKU already exists' }, { status: 409 });
  }

  const sku = skuValue ?? (await generateProductSku());
  const product = await prisma.product.create({
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

  return NextResponse.json({ product }, { status: 201 });
}
