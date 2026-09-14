import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { fileRemittance, AgentLedgerError, REMITTANCE_METHODS, type RemittanceMethod } from '@/lib/services/agentLedgerService';
import { logAudit } from '@/lib/services/auditService';

/** The agent files a claim of money paid toward one ledger entry — see agentLedgerService.fileRemittance. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'agent.ledger.remit');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { amountMinor, method, reference } = (await req.json().catch(() => ({}))) as {
    amountMinor?: number; method?: string; reference?: string;
  };
  if (typeof amountMinor !== 'number') return NextResponse.json({ error: 'amountMinor is required' }, { status: 400 });
  if (!method || !(REMITTANCE_METHODS as readonly string[]).includes(method)) {
    return NextResponse.json({ error: `method must be one of: ${REMITTANCE_METHODS.join(', ')}` }, { status: 400 });
  }

  try {
    const remittance = await fileRemittance({
      ledgerId: id, agentId: auth.user.id, amountMinor, method: method as RemittanceMethod, reference,
    });
    await logAudit({ userId: auth.user.id, action: 'AGENT_REMITTANCE_FILED', entityType: 'AgentRemittance', entityId: remittance.id, newValues: remittance });
    return NextResponse.json({ remittance }, { status: 201 });
  } catch (e) {
    if (e instanceof AgentLedgerError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
