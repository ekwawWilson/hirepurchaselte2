import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { CONTRACT_TYPES, PAYMENT_FREQUENCIES, DIRECT_DEBIT_NETWORKS, DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES, PAYMENT_METHODS, type ContractTypeName, type PaymentFrequencyName, type PaymentMethodName } from '@/lib/constants/contracts';
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
  const {
    contractType, customerId, inventoryItemId, productId, termMonths, paymentFrequency, startDate,
    gracePeriodDays, penaltyRateBps, paymentMethod, directDebitNetwork, directDebitMsisdn,
    totalPayableMinorOverride, depositAmountMinorOverride, termMonthsOverride, instalmentCountOverride,
  } = body;

  if (!(CONTRACT_TYPES as readonly string[]).includes(contractType as string)) {
    return NextResponse.json({ error: `contractType must be one of: ${CONTRACT_TYPES.join(', ')}` }, { status: 400 });
  }
  if (!customerId) {
    return NextResponse.json({ error: 'customerId is required' }, { status: 400 });
  }
  if (contractType === 'SAVE_TO_OWN') {
    // Open-ended savings — no product, no price chart entry, no term at all
    // (contractService.ts). Rejected rather than silently ignored: neither
    // should ever be sent for this type, live-form wizard included.
    if (inventoryItemId || productId) {
      return NextResponse.json({ error: 'SAVE_TO_OWN accounts are not linked to a product' }, { status: 400 });
    }
  } else {
    if (typeof termMonths !== 'number' || termMonths < 1) {
      return NextResponse.json({ error: 'a positive termMonths is required for this contract type' }, { status: 400 });
    }
    // DEVICE_LOAN disburses cash for the customer to buy a device outside the store —
    // no specific stock unit is ever reserved for it, so it's priced against a Product
    // directly rather than an available InventoryItem (docs/01-plan.md §20).
    if (contractType === 'DEVICE_LOAN') {
      if (!productId) return NextResponse.json({ error: 'productId is required for a DEVICE_LOAN contract' }, { status: 400 });
    } else if (!inventoryItemId) {
      return NextResponse.json({ error: 'inventoryItemId is required for this contract type' }, { status: 400 });
    }
  }
  if (paymentFrequency !== undefined && !(PAYMENT_FREQUENCIES as readonly string[]).includes(paymentFrequency as string)) {
    return NextResponse.json({ error: `paymentFrequency must be one of: ${PAYMENT_FREQUENCIES.join(', ')}` }, { status: 400 });
  }
  if (gracePeriodDays !== undefined && (typeof gracePeriodDays !== 'number' || gracePeriodDays < 0)) {
    return NextResponse.json({ error: 'gracePeriodDays must be a non-negative integer' }, { status: 400 });
  }
  if (penaltyRateBps !== undefined && (typeof penaltyRateBps !== 'number' || penaltyRateBps < 0)) {
    return NextResponse.json({ error: 'penaltyRateBps must be a non-negative integer' }, { status: 400 });
  }
  if (paymentMethod !== undefined && !(PAYMENT_METHODS as readonly string[]).includes(paymentMethod as string)) {
    return NextResponse.json({ error: `paymentMethod must be one of: ${PAYMENT_METHODS.join(', ')}` }, { status: 400 });
  }
  const wantsDirectDebit = paymentMethod === 'DIRECT_DEBIT' || paymentMethod === 'BOTH';
  if (wantsDirectDebit) {
    if (!DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES.includes(contractType as ContractTypeName)) {
      return NextResponse.json({ error: `${contractType} contracts have no due schedule — direct debit isn't available for them` }, { status: 400 });
    }
    if (!directDebitNetwork || !directDebitMsisdn) {
      return NextResponse.json({ error: 'directDebitNetwork and directDebitMsisdn are required for DIRECT_DEBIT/BOTH' }, { status: 400 });
    }
    if (!(DIRECT_DEBIT_NETWORKS as readonly string[]).includes(directDebitNetwork as string)) {
      return NextResponse.json({ error: `directDebitNetwork must be one of: ${DIRECT_DEBIT_NETWORKS.join(', ')}` }, { status: 400 });
    }
  }

  const branchId = user.branchId ?? (body.branchId as string);
  if (!branchId) return NextResponse.json({ error: 'branchId is required for an all-branch user' }, { status: 400 });

  if (totalPayableMinorOverride !== undefined && typeof totalPayableMinorOverride !== 'number') {
    return NextResponse.json({ error: 'totalPayableMinorOverride must be a number' }, { status: 400 });
  }
  if (depositAmountMinorOverride !== undefined && typeof depositAmountMinorOverride !== 'number') {
    return NextResponse.json({ error: 'depositAmountMinorOverride must be a number' }, { status: 400 });
  }
  if (termMonthsOverride !== undefined && typeof termMonthsOverride !== 'number') {
    return NextResponse.json({ error: 'termMonthsOverride must be a number' }, { status: 400 });
  }
  if (instalmentCountOverride !== undefined && typeof instalmentCountOverride !== 'number') {
    return NextResponse.json({ error: 'instalmentCountOverride must be a number' }, { status: 400 });
  }
  // A negotiated price differing from the standard price chart tier — reserved
  // for the two most-trusted roles. Silently ignored (not rejected) for anyone
  // else: the UI never shows these fields as editable outside those roles in
  // the first place, so a non-admin sending them is either a stale form state
  // or a direct API call, neither of which should be able to move the price.
  const canOverridePricing = user.roleName === 'SUPER_ADMIN' || user.roleName === 'ADMIN';

  try {
    const contract = await createContract({
      contractType: contractType as never,
      customerId: customerId as string,
      inventoryItemId: inventoryItemId as string | undefined,
      productId: productId as string | undefined,
      termMonths: termMonths as number | undefined,
      paymentFrequency: paymentFrequency as PaymentFrequencyName | undefined,
      startDate: startDate ? new Date(startDate as string) : undefined,
      gracePeriodDays: gracePeriodDays as number | undefined,
      penaltyRateBps: penaltyRateBps as number | undefined,
      paymentMethod: paymentMethod as PaymentMethodName | undefined,
      directDebitNetwork: directDebitNetwork as string | undefined,
      directDebitMsisdn: directDebitMsisdn as string | undefined,
      totalPayableMinorOverride: canOverridePricing ? (totalPayableMinorOverride as number | undefined) : undefined,
      depositAmountMinorOverride: canOverridePricing ? (depositAmountMinorOverride as number | undefined) : undefined,
      termMonthsOverride: canOverridePricing ? (termMonthsOverride as number | undefined) : undefined,
      instalmentCountOverride: canOverridePricing ? (instalmentCountOverride as number | undefined) : undefined,
      branchId,
      createdById: user.id,
    });
    await logAudit({ userId: user.id, action: 'CONTRACT_CREATE', entityType: 'Contract', entityId: contract.id, newValues: contract });
    // A separate, explicitly-named audit entry for the cash leaving the till — unlike
    // every other contract type, DEVICE_LOAN disburses money rather than collecting it,
    // so it needs its own auditable record distinct from ordinary contract creation.
    if (contractType === 'DEVICE_LOAN') {
      await logAudit({
        userId: user.id, action: 'DEVICE_LOAN_DISBURSEMENT', entityType: 'Contract', entityId: contract.id,
        newValues: { principalMinor: contract.principalMinor, customerId: contract.customerId, productId: contract.productId },
      });
    }
    return NextResponse.json({ contract }, { status: 201 });
  } catch (e) {
    if (e instanceof ContractError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
