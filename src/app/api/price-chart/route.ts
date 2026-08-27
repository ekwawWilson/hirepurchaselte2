import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { createPriceChartEntry, validateEntryBody, ContractTypeName } from '@/lib/services/priceChartService';
import type { PaymentFrequencyName } from '@/lib/constants/contracts';
import { logAudit } from '@/lib/services/auditService';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'pricechart.view');
  if (!perm.authorized) return perm.error;

  const { searchParams } = req.nextUrl;
  const productId = searchParams.get('productId') ?? undefined;
  const contractType = searchParams.get('contractType') ?? undefined;
  const activeOnly = searchParams.get('activeOnly');

  const where: Record<string, unknown> = {};
  if (productId) where.productId = productId;
  if (contractType) where.contractType = contractType;
  if (activeOnly === 'true') where.effectiveTo = null;

  const entries = await prisma.priceChartEntry.findMany({
    where,
    include: { product: true },
    orderBy: [{ productId: 'asc' }, { contractType: 'asc' }, { termMonths: 'asc' }, { effectiveFrom: 'desc' }],
  });
  return NextResponse.json({ entries });
}

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'pricechart.edit');
  if (!perm.authorized) return perm.error;

  const body = (await req.json()) as Record<string, unknown>;
  const error = validateEntryBody(body);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const product = await prisma.product.findUnique({ where: { id: body.productId as string } });
  if (!product) return NextResponse.json({ error: 'Unknown productId' }, { status: 400 });

  const entry = await createPriceChartEntry({
    productId: body.productId as string,
    contractType: body.contractType as ContractTypeName,
    termMonths: body.termMonths as number,
    paymentFrequency: ((body.paymentFrequency as string) ?? 'MONTHLY') as PaymentFrequencyName,
    depositPercentage: body.depositPercentage as number,
    totalPayableMinor: body.totalPayableMinor as number,
    instalmentAmountMinor: body.instalmentAmountMinor as number | undefined,
    interestRateBps: (body.interestRateBps as number | undefined) ?? null,
    createdById: auth.user.id,
  });
  await logAudit({ userId: auth.user.id, action: 'PRICECHART_CREATE', entityType: 'PriceChartEntry', entityId: entry.id, newValues: entry });
  return NextResponse.json({ entry }, { status: 201 });
}
