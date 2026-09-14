import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess, assertOwnRecordAccess } from '@/lib/auth/rbac';
import { resubmitContract, ContractError } from '@/lib/services/contractService';
import { DEPOSIT_INSTALMENT_FREQUENCIES, type PaymentFrequencyName } from '@/lib/constants/contracts';
import { logAudit } from '@/lib/services/auditService';

/**
 * The Agent module: the agent who created a REVISION_REQUESTED contract
 * edits its terms and sends it back. assertOwnRecordAccess here is doing
 * real work (unlike approve/request-revision, which an approver calls on
 * someone else's contract on purpose) — only the original creator may
 * resubmit their own submission.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.create');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const existing = await prisma.contract.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, existing.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  if (!assertOwnRecordAccess(auth.user, existing.createdById)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { paymentFrequency } = body;
  if (paymentFrequency !== undefined && !(DEPOSIT_INSTALMENT_FREQUENCIES as readonly string[]).includes(paymentFrequency as string)) {
    return NextResponse.json({ error: `paymentFrequency must be one of: ${DEPOSIT_INSTALMENT_FREQUENCIES.join(', ')}` }, { status: 400 });
  }

  try {
    const contract = await resubmitContract({
      contractId: id,
      updates: {
        totalPayableMinor: body.totalPayableMinor as number | undefined,
        depositAmountMinor: body.depositAmountMinor as number | undefined,
        termWeeks: body.termWeeks as number | undefined,
        paymentFrequency: paymentFrequency as PaymentFrequencyName | undefined,
        gracePeriodDays: body.gracePeriodDays as number | undefined,
        penaltyRateBps: body.penaltyRateBps as number | undefined,
        startDate: body.startDate ? new Date(body.startDate as string) : undefined,
        loanAmountMinor: body.loanAmountMinor as number | undefined,
      },
    });
    await logAudit({ userId: auth.user.id, action: 'CONTRACT_RESUBMIT', entityType: 'Contract', entityId: id, newValues: contract });
    return NextResponse.json({ contract });
  } catch (e) {
    if (e instanceof ContractError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
