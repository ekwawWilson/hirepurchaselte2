import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { createPriceChartEntryInTx, parseTermPricingBundle } from '@/lib/services/priceChartService';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const { id } = await params;
  const product = await prisma.product.findUnique({ where: { id }, include: { category: true, priceChartEntries: true } });
  if (!product) return NextResponse.json({ error: 'Product not found' }, { status: 404 });
  return NextResponse.json({ product });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'inventory.receive');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const existing = await prisma.product.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Product not found' }, { status: 404 });

  const { name, description, categoryId, brand, model, cashPriceMinor, imageUrl, isActive, deviceLoanPricing } =
    (await req.json()) as Record<string, unknown>;

  // Lets an admin close a "Missing: Device Loan" coverage gap right from the edit
  // screen instead of a separate trip to the Price Chart page — same bundle shape
  // and validation as the Add Product form (priceChartService.parseTermPricingBundle).
  const deviceLoanResult = parseTermPricingBundle('DEVICE_LOAN', deviceLoanPricing);
  if ('error' in deviceLoanResult) return NextResponse.json({ error: deviceLoanResult.error }, { status: 400 });

  const product = await prisma.$transaction(async (tx) => {
    const updated = await tx.product.update({
      where: { id: existing.id },
      data: {
        ...(name !== undefined && { name: name as string }),
        ...(description !== undefined && { description: (description as string) || null }),
        ...(categoryId !== undefined && { categoryId: (categoryId as string) || null }),
        ...(brand !== undefined && { brand: (brand as string) || null }),
        ...(model !== undefined && { model: (model as string) || null }),
        ...(cashPriceMinor !== undefined && { cashPriceMinor: cashPriceMinor as number }),
        ...(imageUrl !== undefined && { imageUrl: (imageUrl as string) || null }),
        ...(isActive !== undefined && { isActive: isActive as boolean }),
      },
    });

    if (deviceLoanResult.entries.length > 0) {
      // Skip (don't silently version-out) any term the form submitted that's
      // actually already priced by the time this request lands — never overwrite
      // existing correct pricing via this "fill the gap" path.
      const alreadyPriced = await tx.priceChartEntry.findMany({
        where: {
          productId: existing.id, contractType: 'DEVICE_LOAN', effectiveTo: null,
          termMonths: { in: deviceLoanResult.entries.map((e) => e.termMonths) },
        },
        select: { termMonths: true },
      });
      const pricedTerms = new Set(alreadyPriced.map((e) => e.termMonths));
      for (const entry of deviceLoanResult.entries) {
        if (pricedTerms.has(entry.termMonths)) continue;
        await createPriceChartEntryInTx(tx, {
          productId: existing.id, contractType: 'DEVICE_LOAN', termMonths: entry.termMonths,
          paymentFrequency: 'MONTHLY', totalPayableMinor: entry.totalPayableMinor,
          depositAmountMinor: 0, interestRateBps: entry.interestRateBps, createdById: auth.user.id,
        });
      }
    }

    return updated;
  });
  return NextResponse.json({ product });
}
