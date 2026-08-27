import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { CONTRACT_TYPES, PAYMENT_FREQUENCIES, type PaymentFrequencyName } from '@/lib/constants/contracts';
import { createContract, ContractError } from '@/lib/services/contractService';
import { logAudit } from '@/lib/services/auditService';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.view');
  if (!perm.authorized) return perm.error;
  const user = auth.user;

  const { searchParams } = req.nextUrl;
  const customerId = searchParams.get('customerId') ?? undefined;
  const status = searchParams.get('status') ?? undefined;
  const contractType = searchParams.get('contractType') ?? undefined;
  const branchIdParam = searchParams.get('branchId') ?? undefined;

  const where: Record<string, unknown> = { ...branchScopeWhere(user) };
  if (!user.branchId && branchIdParam) where.branchId = branchIdParam;
  if (customerId) where.customerId = customerId;
  if (status) where.status = status;
  if (contractType) where.contractType = contractType;

  const contracts = await prisma.contract.findMany({
    where,
    include: { customer: true, product: true, inventoryItem: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  return NextResponse.json({ contracts });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.create');
  if (!perm.authorized) return perm.error;
  const user = auth.user;

  const body = (await req.json()) as Record<string, unknown>;
  const { contractType, customerId, inventoryItemId, termMonths, paymentFrequency, startDate } = body;

  if (!(CONTRACT_TYPES as readonly string[]).includes(contractType as string)) {
    return NextResponse.json({ error: `contractType must be one of: ${CONTRACT_TYPES.join(', ')}` }, { status: 400 });
  }
  if (!customerId || !inventoryItemId || typeof termMonths !== 'number' || termMonths < 1) {
    return NextResponse.json({ error: 'customerId, inventoryItemId, and a positive termMonths are required' }, { status: 400 });
  }
  if (paymentFrequency !== undefined && !(PAYMENT_FREQUENCIES as readonly string[]).includes(paymentFrequency as string)) {
    return NextResponse.json({ error: `paymentFrequency must be one of: ${PAYMENT_FREQUENCIES.join(', ')}` }, { status: 400 });
  }

  const branchId = user.branchId ?? (body.branchId as string);
  if (!branchId) return NextResponse.json({ error: 'branchId is required for an all-branch user' }, { status: 400 });

  try {
    const contract = await createContract({
      contractType: contractType as never,
      customerId: customerId as string,
      inventoryItemId: inventoryItemId as string,
      termMonths,
      paymentFrequency: paymentFrequency as PaymentFrequencyName | undefined,
      startDate: startDate ? new Date(startDate as string) : undefined,
      branchId,
      createdById: user.id,
    });
    await logAudit({ userId: user.id, action: 'CONTRACT_CREATE', entityType: 'Contract', entityId: contract.id, newValues: contract });
    return NextResponse.json({ contract }, { status: 201 });
  } catch (e) {
    if (e instanceof ContractError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
