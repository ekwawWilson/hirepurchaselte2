import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/rbac';
import { issueAgentPaymentPin } from '@/lib/services/agentPaymentPinService';

/** The signed-in agent's own PIN for paying in deposits on the short code, for their dashboard. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  if (auth.user.roleName !== 'AGENT') return NextResponse.json({ error: 'Only agents have a payment PIN' }, { status: 403 });

  return NextResponse.json({ pin: await issueAgentPaymentPin(auth.user.id) });
}
