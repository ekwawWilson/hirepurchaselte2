import { NextRequest, NextResponse } from 'next/server';
import { CUSTOMER_SUMMARY_SELECT } from '@/lib/services/customerService';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import {
  CONTRACT_TYPES, DEPOSIT_INSTALMENT_FREQUENCIES, DIRECT_DEBIT_NETWORKS, DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES, PAYMENT_METHODS,
  type ContractTypeName, type PaymentFrequencyName, type PaymentMethodName,
} from '@/lib/constants/contracts';
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
    include: { customer: { select: CUSTOMER_SUMMARY_SELECT }, product: true, inventoryItem: true },
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
    contractType, customerId, inventoryItemId, startDate,
    gracePeriodDays, penaltyRateBps, paymentMethod, directDebitNetwork, directDebitMsisdn,
    totalPayableMinor, depositAmountMinor, termWeeks, paymentFrequency, loanAmountMinor,
  } = body;

  if (!(CONTRACT_TYPES as readonly string[]).includes(contractType as string)) {
    return NextResponse.json({ error: `contractType must be one of: ${CONTRACT_TYPES.join(', ')}` }, { status: 400 });
  }
  if (!customerId) {
    return NextResponse.json({ error: 'customerId is required' }, { status: 400 });
  }

  if (contractType === 'SAVE_TO_OWN') {
    // Open-ended savings — no product, no price chart entry, no term at all
    // (contractService.ts). Rejected rather than silently ignored: it should
    // never be sent for this type, live-form wizard included.
    if (inventoryItemId) {
      return NextResponse.json({ error: 'SAVE_TO_OWN accounts are not linked to a product' }, { status: 400 });
    }
  } else if (contractType === 'DEVICE_LOAN') {
    // Also not linked to a product — a daily-simple-interest loan, the
    // amount entered directly (contractService.ts/loanService.ts).
    if (inventoryItemId) {
      return NextResponse.json({ error: 'DEVICE_LOAN accounts are not linked to a product' }, { status: 400 });
    }
    if (typeof loanAmountMinor !== 'number' || loanAmountMinor <= 0) {
      return NextResponse.json({ error: 'a positive loanAmountMinor is required for a DEVICE_LOAN contract' }, { status: 400 });
    }
  } else {
    // DEPOSIT_INSTALMENT — still the one type linked to a reserved unit, and
    // every deal term is entered directly here now, never looked up from a
    // price chart.
    if (!inventoryItemId) {
      return NextResponse.json({ error: 'inventoryItemId is required for this contract type' }, { status: 400 });
    }
    if (typeof totalPayableMinor !== 'number' || totalPayableMinor <= 0) {
      return NextResponse.json({ error: 'a positive totalPayableMinor is required for this contract type' }, { status: 400 });
    }
    if (typeof depositAmountMinor !== 'number' || depositAmountMinor < 0) {
      return NextResponse.json({ error: 'a non-negative depositAmountMinor is required for this contract type' }, { status: 400 });
    }
    if (typeof termWeeks !== 'number') {
      return NextResponse.json({ error: 'termWeeks is required for this contract type' }, { status: 400 });
    }
    if (paymentFrequency !== undefined && !(DEPOSIT_INSTALMENT_FREQUENCIES as readonly string[]).includes(paymentFrequency as string)) {
      return NextResponse.json({ error: `paymentFrequency must be one of: ${DEPOSIT_INSTALMENT_FREQUENCIES.join(', ')}` }, { status: 400 });
    }
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
      return NextResponse.json({ error: `${contractType} contracts have no due schedule to auto-charge — direct debit isn't available for them` }, { status: 400 });
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

  try {
    const contract = await createContract({
      contractType: contractType as never,
      customerId: customerId as string,
      inventoryItemId: inventoryItemId as string | undefined,
      totalPayableMinor: totalPayableMinor as number | undefined,
      depositAmountMinor: depositAmountMinor as number | undefined,
      termWeeks: termWeeks as number | undefined,
      paymentFrequency: paymentFrequency as PaymentFrequencyName | undefined,
      loanAmountMinor: loanAmountMinor as number | undefined,
      startDate: startDate ? new Date(startDate as string) : undefined,
      gracePeriodDays: gracePeriodDays as number | undefined,
      penaltyRateBps: penaltyRateBps as number | undefined,
      paymentMethod: paymentMethod as PaymentMethodName | undefined,
      directDebitNetwork: directDebitNetwork as string | undefined,
      directDebitMsisdn: directDebitMsisdn as string | undefined,
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
        newValues: { principalMinor: contract.principalMinor, customerId: contract.customerId },
      });
    }
    return NextResponse.json({ contract }, { status: 201 });
  } catch (e) {
    if (e instanceof ContractError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
