import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';
import { checksForContract, type Priority } from '@/lib/services/saleChecksService';

const RANK: Record<Priority, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Agent sales waiting for a decision, each with its checks worked out again
 * now (saleChecksService): priority, what to weigh, and whether it has waited
 * past its suggested time. Most urgent first, then longest waiting.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.approve');
  if (!perm.authorized) return perm.error;
  const pending = await prisma.contract.findMany({
    where: { status: 'PENDING_APPROVAL', ...branchScopeWhere(auth.user) },
    include: {
      customer: { select: { firstName: true, lastName: true, membershipId: true } },
      product: { select: { name: true } },
      createdBy: { select: { id: true, firstName: true, lastName: true } },
    },
    take: 200,
  });
  const now = Date.now();
  const rows = await Promise.all(pending.map(async (c) => {
    const checks = await checksForContract(c.id);
    const waitingHours = (now - (c.submittedForApprovalAt ?? c.createdAt).getTime()) / 3_600_000;
    return {
      ...c, checks, waitingHours: Math.round(waitingHours * 10) / 10,
      overdue: waitingHours > checks.suggestedSlaHours,
      ownSale: c.createdById === auth.user.id,
    };
  }));
  rows.sort((a, b) => RANK[a.checks.priority] - RANK[b.checks.priority] || b.waitingHours - a.waitingHours);
  return NextResponse.json({ contracts: rows });
}
