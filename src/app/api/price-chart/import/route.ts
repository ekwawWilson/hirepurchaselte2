import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { createPriceChartEntry, parsePriceChartCsv, validateEntryBody, ContractTypeName } from '@/lib/services/priceChartService';
import type { PaymentFrequencyName } from '@/lib/constants/contracts';

export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'pricechart.edit');
  if (!perm.authorized) return perm.error;

  const { csv } = (await req.json()) as { csv?: string };
  if (!csv) return NextResponse.json({ error: 'csv (text) is required' }, { status: 400 });

  const rows = parsePriceChartCsv(csv);
  const results: Array<{ row: number; ok: boolean; error?: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const product = await prisma.product.findUnique({ where: { sku: r.productSku } });
      if (!product) throw new Error(`Unknown productSku: ${r.productSku}`);
      const body = {
        productId: product.id,
        contractType: r.contractType,
        termMonths: Number(r.termMonths),
        paymentFrequency: r.paymentFrequency || 'MONTHLY',
        depositPercentage: Number(r.depositPercentage),
        totalPayableMinor: Number(r.totalPayableMinor),
        interestRateBps: r.interestRateBps ? Number(r.interestRateBps) : undefined,
      };
      const err = validateEntryBody(body);
      if (err) throw new Error(err);
      await createPriceChartEntry({
        ...body,
        contractType: body.contractType as ContractTypeName,
        paymentFrequency: body.paymentFrequency as PaymentFrequencyName,
        createdById: auth.user.id,
      });
      results.push({ row: i + 2, ok: true });
    } catch (e) {
      results.push({ row: i + 2, ok: false, error: (e as Error).message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  return NextResponse.json(
    { imported: results.length - failed.length, failed: failed.length, results },
    { status: failed.length ? 207 : 201 },
  );
}
