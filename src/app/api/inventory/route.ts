import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { receiveInventoryItem } from '@/lib/services/inventoryService';
import { inventorySearchWhere } from '@/lib/utils/search';
import { saleTypeInventoryWhere } from '@/lib/paytrigger/saleGuard';

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
  // An agent sees only the stock assigned to them: what they can sell, and what they sold.
  if (user.roleName === 'AGENT') where.assignedAgentId = user.id;
  const agentFilter = searchParams.get('agentId');
  if (agentFilter && user.roleName !== 'AGENT') where.assignedAgentId = agentFilter === 'none' ? null : agentFilter;
  const q = searchParams.get('q');
  // ?saleType=: only what that instalment sale may sell (PayTrigger phones
  // go on Device Financing alone) — the new-contract wizard's unit picker.
  const saleWhere = await saleTypeInventoryWhere(searchParams.get('saleType'));
  where.AND = [...(q ? inventorySearchWhere(q) : []), ...(saleWhere ? [saleWhere] : [])];

  const items = await prisma.inventoryItem.findMany({
    where,
    include: { product: { include: { category: true } }, branch: { select: { name: true } }, assignedAgent: { select: { id: true, firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  return NextResponse.json({ items });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.receive');
  if (!perm.authorized) return perm.error;
  const user = auth.user;

  const { productId, serialNumber: serialInput, branchId: branchIdInput, name, description, reason } = (await req.json()) as Record<string, string | undefined>;
  const serialNumber = serialInput?.trim();
  if (!productId || !serialNumber) {
    return NextResponse.json({ error: 'productId and serialNumber are required' }, { status: 400 });
  }
  if (!(await prisma.product.findUnique({ where: { id: productId }, select: { id: true } }))) {
    return NextResponse.json({ error: 'Product not found' }, { status: 400 });
  }
  const branchId = user.branchId ?? branchIdInput;
  if (!branchId) return NextResponse.json({ error: 'branchId is required for an all-branch user' }, { status: 400 });

  const existing = await prisma.inventoryItem.findUnique({ where: { serialNumber } });
  if (existing) return NextResponse.json({ error: 'An inventory item with this serial number already exists' }, { status: 409 });

  const item = await receiveInventoryItem({ productId, branchId, serialNumber, name, description, createdById: user.id, reason });
  return NextResponse.json({ item }, { status: 201 });
}
