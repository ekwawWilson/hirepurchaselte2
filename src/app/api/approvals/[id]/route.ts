import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { decideApproval, ApprovalError, APPROVAL_PERMISSIONS } from '@/lib/services/approvalService';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, ...APPROVAL_PERMISSIONS);
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const { decision, note } = (await req.json().catch(() => ({}))) as { decision?: string; note?: string };
  if (decision !== 'APPROVE' && decision !== 'REJECT') {
    return NextResponse.json({ error: 'decision must be APPROVE or REJECT' }, { status: 400 });
  }

  try {
    return NextResponse.json({ approval: await decideApproval({ id, decision, note, user: auth.user }) });
  } catch (e) {
    if (e instanceof ApprovalError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
