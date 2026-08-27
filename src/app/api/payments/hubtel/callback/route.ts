import { NextRequest, NextResponse } from 'next/server';
import { validateWebhookRequest } from '@/lib/auth/webhookSecurity';
import { processHubtelCallback, HubtelError } from '@/lib/services/hubtelPaymentService';

/**
 * Live-mode Hubtel payment callback. Not used by the mock flow (mock mode
 * resolves synchronously inside initiateHubtelPayment) — this exists for
 * when HUBTEL_PAYMENTS_MODE=live is wired to a real Hubtel account.
 */
export async function POST(req: NextRequest) {
  const check = validateWebhookRequest(req);
  if (!check.valid) {
    return NextResponse.json({ error: 'Unauthorized webhook request' }, { status: 401 });
  }

  const raw = await req.text();
  const body = JSON.parse(raw) as { ClientReference?: string; Status?: string };
  const { ClientReference: clientReference, Status: status } = body;

  if (!clientReference || !status) {
    return NextResponse.json({ error: 'ClientReference and Status are required' }, { status: 400 });
  }

  try {
    const txn = await processHubtelCallback({
      clientReference,
      status: status.toUpperCase() === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
      rawPayload: raw,
    });
    return NextResponse.json({ received: true, status: txn.status });
  } catch (e) {
    if (e instanceof HubtelError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
