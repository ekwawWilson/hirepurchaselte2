import { NextRequest, NextResponse } from 'next/server';
import { validateWebhookRequest } from '@/lib/auth/webhookSecurity';
import { processHubtelCallback, normalizeHubtelPaymentCallback, HubtelError } from '@/lib/services/hubtelPaymentService';

/**
 * Live-mode Hubtel payment callback — the same Receive-Money callback shape
 * (`{ResponseCode, Message, Data: {ClientReference, Status, ...}}`) the
 * legacy hirepurchase app's own callback route parses for this product. Not
 * used by the mock flow (mock mode resolves synchronously inside
 * initiateHubtelPayment).
 */
export async function POST(req: NextRequest) {
  const check = validateWebhookRequest(req);
  if (!check.valid) {
    return NextResponse.json({ error: 'Unauthorized webhook request' }, { status: 401 });
  }

  const raw = await req.text();
  const body = JSON.parse(raw) as unknown;
  const { clientReference, status } = normalizeHubtelPaymentCallback(body);

  if (!clientReference) {
    return NextResponse.json({ error: 'ClientReference is required' }, { status: 400 });
  }

  if (status === 'PENDING') {
    // Hubtel's real callbacks are always terminal — an unrecognized status
    // here means we couldn't parse it, not that the payment is genuinely
    // still pending. Acknowledge (so Hubtel doesn't retry indefinitely) and
    // let the reconcile sweep's status check settle it instead of guessing.
    return NextResponse.json({ received: true, status: 'unrecognized' });
  }

  try {
    const txn = await processHubtelCallback({ clientReference, status, rawPayload: raw });
    return NextResponse.json({ received: true, status: txn.status });
  } catch (e) {
    if (e instanceof HubtelError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
