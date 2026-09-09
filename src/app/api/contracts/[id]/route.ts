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
      hubtelPreapproval: true,
    },
  });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  // SAVE_TO_OWN has no target to overpay against — credit only applies to
  // contracts with a real totalPayableMinor (contractService.ts).
  const creditMinor = contract.totalPayableMinor === null ? 0 : Math.max(0, contract.totalPaidMinor - contract.totalPayableMinor);
  return NextResponse.json({ contract: { ...contract, creditMinor } });
}
