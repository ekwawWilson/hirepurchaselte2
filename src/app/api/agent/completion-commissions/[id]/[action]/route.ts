import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { markCompletionCommissionPaid, undoCompletionCommissionPaid, CompletionCommissionError } from '@/lib/services/completionCommissionService';

/** paid { reference }: finance has paid it. undo: it was marked paid in error. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'agent.ledger.manage');
  if (!perm.authorized) return perm.error;
  // An auditor sees the ledger; paying out is for those who also handle money (as for Pay commission).
  const pay = requirePermission(auth.user, 'payment.cash.record');
  if (!pay.authorized) return pay.error;
  const { id, action } = await params;
  try {
    if (action === 'paid') {
      const body = (await req.json().catch(() => ({}))) as { reference?: unknown };
      await markCompletionCommissionPaid(id, typeof body.reference === 'string' ? body.reference : '', auth.user.id);
    } else if (action === 'undo') {
      await undoCompletionCommissionPaid(id, auth.user.id);
    } else {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    if (e instanceof CompletionCommissionError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
