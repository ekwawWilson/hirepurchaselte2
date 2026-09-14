import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, branchScopeWhere } from '@/lib/auth/rbac';

/**
 * Every agent's deposit ledger, for an approver (agent.ledger.manage) to
 * review and confirm/reject remittances against. Branch-scoped the same way
 * as everything else: a BRANCH_MANAGER sees only agents in their own branch
 * (via the agent's own branchId — the ledger entry itself has no branch of
 * its own), ADMIN/SUPER_ADMIN/AUDITOR see all.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'agent.ledger.manage');
  if (!perm.authorized) return perm.error;

  const { searchParams } = req.nextUrl;
  const agentId = searchParams.get('agentId') ?? undefined;
  const status = searchParams.get('status') ?? undefined;
  const branchWhere = branchScopeWhere(auth.user);

  const entries = await prisma.agentDepositLedger.findMany({
    where: {
      ...(agentId && { agentId }),
      ...(status && { status }),
      ...(branchWhere.branchId && { agent: { branchId: branchWhere.branchId } }),
    },
    orderBy: { createdAt: 'desc' },
    include: {
      agent: { select: { id: true, firstName: true, lastName: true, email: true } },
      contract: { select: { id: true, contractNumber: true, customer: { select: { firstName: true, lastName: true, membershipId: true } } } },
      remittances: { orderBy: { createdAt: 'desc' } },
    },
  });

  return NextResponse.json({ entries });
}
