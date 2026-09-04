import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { DIRECT_DEBIT_NETWORKS } from '@/lib/constants/contracts';
import { testPreapprovalInitiateRaw, HubtelApiError } from '@/lib/services/hubtelClient';
import { preapprovalCallbackUrl } from '@/lib/services/hubtelPreapprovalService';

/**
 * POST /api/settings/hubtel-diagnostics/test-preapproval
 *
 * Fires a real Hubtel preapproval-initiate call (the exact same one
 * initiatePreapproval makes) and returns Hubtel's untouched response —
 * request URL/payload, HTTP status, response body — instead of the
 * generic, non-blocking failure the actual contract-creation flow
 * swallows silently on error. That silent-failure behavior is correct for
 * a live contract creation (a Hubtel hiccup must never block or confuse
 * staff creating a contract), but it means "the customer never got the
 * prompt" is otherwise undiagnosable without this: an un-whitelisted IP,
 * bad credentials, and a malformed number all look identical from the
 * contract wizard — a 403/401/400 with Hubtel's own message is what
 * actually tells them apart.
 *
 * This is a REAL call — if Hubtel accepts it, whatever number is given
 * really is prompted, same as production. No HubtelPreapproval row is
 * written; this is deliberately not tied to a customer or contract.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  const { msisdn, network } = (await req.json()) as { msisdn?: string; network?: string };
  if (!msisdn || !network) {
    return NextResponse.json({ error: 'msisdn and network are required' }, { status: 400 });
  }
  if (!(DIRECT_DEBIT_NETWORKS as readonly string[]).includes(network)) {
    return NextResponse.json({ error: `network must be one of: ${DIRECT_DEBIT_NETWORKS.join(', ')}` }, { status: 400 });
  }

  try {
    const result = await testPreapprovalInitiateRaw({ msisdn, network, callbackUrl: preapprovalCallbackUrl() });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof HubtelApiError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
