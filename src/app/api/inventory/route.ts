import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { receiveInventoryItem } from '@/lib/services/inventoryService';
import { inventorySearchWhere } from '@/lib/utils/search';

/**
 * Stock, to whoever may view inventory. Someone who can only create contracts
 * sees the units available to sell and nothing else: picking one is a step of
 * creating a Deposit + Instalment contract (POST /api/contracts already lets
 * them reserve it), which is no reason to show them what is issued, returned
 * or written off.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.view', 'contract.create');
  if (!perm.authorized) return perm.error;
  const user = auth.user;
  const sellableOnly = !requirePermission(user, 'inventory.view').authorized;

  const { searchParams } = req.nextUrl;
  const productId = searchParams.get('productId') ?? undefined;
  const status = searchParams.get('status') ?? undefined;
  const branchIdParam = searchParams.get('branchId') ?? undefined;

  const where: Record<string, unknown> = { ...branchScopeWhere(user) };
  if (!user.branchId && branchIdParam) where.branchId = branchIdParam;
  if (productId) where.productId = productId;
  if (status) where.status = status;
  if (sellableOnly) where.status = 'AVAILABLE';
  const q = searchParams.get('q');
  if (q) where.AND = inventorySearchWhere(q);

  const items = await prisma.inventoryItem.findMany({
    where, include: { product: { include: { category: true } } }, orderBy: { createdAt: 'desc' }, take: 200,
  });
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.receive');
  if (!perm.authorized) return perm.error;
  const user = auth.user;

  const { productId, serialNumber, branchId: branchIdInput, description, reason } = (await req.json()) as Record<string, string | undefined>;
  if (!productId || !serialNumber) {
    return NextResponse.json({ error: 'productId and serialNumber are required' }, { status: 400 });
  }
  const branchId = user.branchId ?? branchIdInput;
  if (!branchId) return NextResponse.json({ error: 'branchId is required for an all-branch user' }, { status: 400 });

  const existing = await prisma.inventoryItem.findUnique({ where: { serialNumber } });
  if (existing) return NextResponse.json({ error: 'An inventory item with this serial number already exists' }, { status: 409 });

  const item = await receiveInventoryItem({ productId, branchId, serialNumber, description, createdById: user.id, reason });
  return NextResponse.json({ item }, { status: 201 });
}
