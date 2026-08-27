import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.view');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const contract = await prisma.contract.findUnique({
    where: { id },
    include: {
      customer: true,
      product: true,
      inventoryItem: true,
      instalments: { orderBy: { instalmentNo: 'asc' } },
      penalties: true,
      payments: { orderBy: { createdAt: 'desc' }, include: { allocations: true } },
    },
  });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const creditMinor = Math.max(0, contract.totalPaidMinor - contract.totalPayableMinor);
  return NextResponse.json({ contract: { ...contract, creditMinor } });
}
