import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const { id } = await params;
  const product = await prisma.product.findUnique({ where: { id }, include: { category: true, priceChartEntries: true } });
  if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });
  return NextResponse.json({ product });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.receive');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

  const { name, description, categoryId, brand, model, cashPriceMinor, imageUrl, isActive } = (await req.json()) as Record<string, unknown>;

  const product = await prisma.product.update({
    where: { id: existing.id },
    data: {
      ...(name !== undefined && { name: name as string }),
      ...(description !== undefined && { description: (description as string) || null }),
      ...(categoryId !== undefined && { categoryId: (categoryId as string) || null }),
      ...(brand !== undefined && { brand: (brand as string) || null }),
      ...(model !== undefined && { model: (model as string) || null }),
      ...(cashPriceMinor !== undefined && { cashPriceMinor: cashPriceMinor as number }),
      ...(imageUrl !== undefined && { imageUrl: (imageUrl as string) || null }),
      ...(isActive !== undefined && { isActive: isActive as boolean }),
    },
  });
  return NextResponse.json({ product });
}
