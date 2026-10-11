import { NextRequest, NextResponse } from 'next/server';
import { validateWebhookRequest } from '@/lib/auth/webhookSecurity';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { isHubtelLiveMode } from '@/lib/services/hubtelClient';
import { answerUssdRequest } from '@/lib/services/ussdGatewayService';

/**
 * The USSD menu, for the staff simulator page and for a gateway that sends
 * the shared secret as a header or `?token=`. (Hubtel's own gateway is given
 * /api/ussd/{token} instead — see that route.)
 *
 * Never open: a USSD session greets a phone number's owner by name, shows
 * what they owe, and — once payments are live — sends a payment prompt to
 * that phone. Unguarded, anyone could do all three for any customer's number.
 * A signed-in staff member may use it as a simulator; once payments are live
 * that is limited to those who manage settings, since confirming a payment
 * here then sends a real prompt.
 */
export async function POST(req: NextRequest) {
  if (!validateWebhookRequest(req).valid) {
    const auth = await requireAuth(req);
    if ('error' in auth) return auth.error;
    if (isHubtelLiveMode()) {
      const perm = requirePermission(auth.user, 'settings.manage');
      if (!perm.authorized) {
        return NextResponse.json({ error: 'The simulator sends real payment prompts while Hubtel payments are live — only an administrator can use it' }, { status: 403 });
      }
    }
  }
  return answerUssdRequest(req);
}
