import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { payCommission, AgentLedgerError, REMITTANCE_METHODS, type RemittanceMethod } from '@/lib/services/agentLedgerService';
import { logAudit } from '@/lib/services/auditService';

/** An approver records commission the office has paid an agent on one entry — see agentLedgerService.payCommission. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'agent.ledger.manage');
  if (!perm.authorized) return perm.error;
  // Paying money out is for those who handle money, not an auditor reviewing the ledger.
  const handlesMoney = requirePermission(auth.user, 'payment.cash.record');
  if (!handlesMoney.authorized) return handlesMoney.error;

  const { id } = await params;
  const { amountMinor, method, reference } = (await req.json().catch(() => ({}))) as { amountMinor?: number; method?: string; reference?: string };
  if (typeof amountMinor !== 'number') return NextResponse.json({ error: 'amountMinor is required' }, { status: 400 });
  if (!method || !(REMITTANCE_METHODS as readonly string[]).includes(method)) {
    return NextResponse.json({ error: `method must be one of: ${REMITTANCE_METHODS.join(', ')}` }, { status: 400 });
  }

  try {
    const payout = await payCommission({
      ledgerId: id, amountMinor, method: method as RemittanceMethod, reference, paidById: auth.user.id, payerBranchId: auth.user.branchId,
    });
    await logAudit({ userId: auth.user.id, action: 'AGENT_COMMISSION_PAID', entityType: 'AgentCommissionPayout', entityId: payout.id, newValues: payout });
    return NextResponse.json({ payout }, { status: 201 });
  } catch (e) {
    if (e instanceof AgentLedgerError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
