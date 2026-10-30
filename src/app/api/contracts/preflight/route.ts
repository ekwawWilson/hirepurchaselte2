import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { evaluateSaleChecks } from '@/lib/services/saleChecksService';

/**
 * The checks a sale will meet, before it is submitted: what would refuse it,
 * and what the approver will be shown. Takes the same body as POST
 * /api/contracts and changes nothing.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.create');
  if (!perm.authorized) return perm.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const inventoryItemId = str(body.inventoryItemId);
  const item = inventoryItemId ? await prisma.inventoryItem.findUnique({ where: { id: inventoryItemId }, select: { productId: true } }) : null;
  const startDate = str(body.startDate) ? new Date(body.startDate as string) : undefined;
  return NextResponse.json({
    checks: await evaluateSaleChecks({
      createdById: auth.user.id, creatorRole: auth.user.roleName, contractType: str(body.contractType), customerId: str(body.customerId),
      productId: item?.productId ?? null, totalPayableMinor: num(body.totalPayableMinor), depositAmountMinor: num(body.depositAmountMinor),
      termWeeks: num(body.termWeeks), paymentMethod: str(body.paymentMethod), directDebitMsisdn: str(body.directDebitMsisdn),
      startDate: startDate && !Number.isNaN(startDate.getTime()) ? startDate : undefined,
    }),
  });
}
