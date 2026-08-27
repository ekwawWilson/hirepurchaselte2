import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.view');
  if (!perm.authorized) return perm.error;
  const user = auth.user;

  const { searchParams } = req.nextUrl;
  const productId = searchParams.get('productId') ?? undefined;
  const inventoryItemId = searchParams.get('inventoryItemId') ?? undefined;
  const branchIdParam = searchParams.get('branchId') ?? undefined;

  const where: Record<string, unknown> = { ...branchScopeWhere(user) };
  if (!user.branchId && branchIdParam) where.branchId = branchIdParam;
  if (productId) where.productId = productId;
  if (inventoryItemId) where.inventoryItemId = inventoryItemId;

  const movements = await prisma.stockMovement.findMany({
    where,
    include: { inventoryItem: true, createdBy: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return NextResponse.json({ movements });
}
