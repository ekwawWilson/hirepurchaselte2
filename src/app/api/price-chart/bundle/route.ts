import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { createPriceChartEntriesForTerm, PriceChartError, ContractTypeName } from '@/lib/services/priceChartService';
import { PAYMENT_FREQUENCIES, PRICE_CHART_TERM_MONTHS } from '@/lib/constants/contracts';
import type { PaymentFrequencyName } from '@/lib/constants/contracts';
import { logAudit } from '@/lib/services/auditService';

/**
 * Prices a product for a term across multiple contract types in one atomic
 * request — the UI's "fill in whichever types are missing" bundle form. See
 * priceChartService.createPriceChartEntriesForTerm and docs/01-plan.md §14.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'pricechart.edit');
  if (!perm.authorized) return perm.error;

  const body = (await req.json()) as Record<string, unknown>;
  const { productId, termMonths, paymentFrequency, entries } = body;

  if (!productId || typeof productId !== 'string') return NextResponse.json({ error: 'productId is required' }, { status: 400 });
  if (typeof termMonths !== 'number' || !(PRICE_CHART_TERM_MONTHS as readonly number[]).includes(termMonths)) {
    return NextResponse.json({ error: `termMonths must be one of: ${PRICE_CHART_TERM_MONTHS.join(', ')}` }, { status: 400 });
  }
  const frequency = ((paymentFrequency as string) ?? 'MONTHLY') as PaymentFrequencyName;
  if (!(PAYMENT_FREQUENCIES as readonly string[]).includes(frequency)) {
    return NextResponse.json({ error: `paymentFrequency must be one of: ${PAYMENT_FREQUENCIES.join(', ')}` }, { status: 400 });
  }
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length === 0) {
    return NextResponse.json({ error: 'entries must be a non-empty map of contractType -> pricing' }, { status: 400 });
  }

  try {
    const created = await createPriceChartEntriesForTerm({
      productId,
      termMonths,
      paymentFrequency: frequency,
      createdById: auth.user.id,
      entries: entries as Partial<Record<ContractTypeName, { totalPayableMinor: number; depositAmountMinor?: number; interestRateBps?: number | null }>>,
    });
    await logAudit({ userId: auth.user.id, action: 'PRICECHART_BUNDLE_CREATE', entityType: 'Product', entityId: productId, newValues: created });
    return NextResponse.json({ entries: created }, { status: 201 });
  } catch (e) {
    if (e instanceof PriceChartError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
