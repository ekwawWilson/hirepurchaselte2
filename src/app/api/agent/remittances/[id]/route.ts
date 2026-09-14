import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { confirmRemittance, rejectRemittance, AgentLedgerError } from '@/lib/services/agentLedgerService';
import { logAudit } from '@/lib/services/auditService';

/**
 * An approver (agent.ledger.manage) confirms or rejects a filed remittance —
 * see agentLedgerService.ts. `{ action: 'confirm' }` applies it to the
 * ledger; `{ action: 'reject', reason }` leaves the ledger untouched.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'agent.ledger.manage');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { action, reason } = (await req.json().catch(() => ({}))) as { action?: string; reason?: string };

  try {
    if (action === 'confirm') {
      const remittance = await confirmRemittance({ remittanceId: id, confirmedById: auth.user.id });
      await logAudit({ userId: auth.user.id, action: 'AGENT_REMITTANCE_CONFIRM', entityType: 'AgentRemittance', entityId: id, newValues: remittance });
      return NextResponse.json({ remittance });
    }
    if (action === 'reject') {
      if (!reason?.trim()) return NextResponse.json({ error: 'reason is required to reject a remittance' }, { status: 400 });
      const remittance = await rejectRemittance({ remittanceId: id, confirmedById: auth.user.id, reason });
      await logAudit({ userId: auth.user.id, action: 'AGENT_REMITTANCE_REJECT', entityType: 'AgentRemittance', entityId: id, newValues: remittance });
      return NextResponse.json({ remittance });
    }
    return NextResponse.json({ error: "action must be 'confirm' or 'reject'" }, { status: 400 });
  } catch (e) {
    if (e instanceof AgentLedgerError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
