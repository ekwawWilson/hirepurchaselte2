import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'payment.view');
  if (!perm.authorized) return perm.error;

  const contractId = req.nextUrl.searchParams.get('contractId');
  if (!contractId) return NextResponse.json({ error: 'contractId is required' }, { status: 400 });

  const contract = await prisma.contract.findUnique({ where: { id: contractId } });
  if (!contract) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, contract.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const payments = await prisma.payment.findMany({
    where: { contractId }, include: { allocations: true }, orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ payments });
}
