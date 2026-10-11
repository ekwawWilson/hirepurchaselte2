import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess } from '@/lib/auth/rbac';
import { rescheduleContract } from '@/lib/services/rescheduleService';
import { ContractError } from '@/lib/services/contractService';
import { logAudit } from '@/lib/services/auditService';
import type { PaymentFrequencyName } from '@/lib/constants/contracts';

/** Spreads what is still owed on a deposit and instalment contract over a new term (rescheduleService.ts). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.reschedule');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { termWeeks, paymentFrequency, startDate, reason } = (await req.json().catch(() => ({}))) as {
    termWeeks?: number; paymentFrequency?: string; startDate?: string; reason?: string;
  };
  if (!reason?.trim()) return NextResponse.json({ error: 'reason is required' }, { status: 400 });
  if (typeof termWeeks !== 'number' || !paymentFrequency) {
    return NextResponse.json({ error: 'termWeeks and paymentFrequency are required' }, { status: 400 });
  }

  const existing = await prisma.contract.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: 'Contract not found' }, { status: 404 });
  if (!assertBranchAccess(auth.user, existing.branchId)) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  try {
    const result = await rescheduleContract({
      contractId: id, termWeeks, paymentFrequency: paymentFrequency as PaymentFrequencyName,
      startDate: startDate ? new Date(startDate) : undefined, reason: reason.trim(), userId: auth.user.id,
    });
    await logAudit({
      userId: auth.user.id, action: 'CONTRACT_RESCHEDULE', entityType: 'Contract', entityId: id,
      oldValues: { status: existing.status, paymentFrequency: existing.paymentFrequency, unpaidInstalments: result.before },
      newValues: { reason: reason.trim(), termWeeks, paymentFrequency, outstandingMinor: result.outstandingMinor, schedule: result.schedule },
    });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ContractError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
