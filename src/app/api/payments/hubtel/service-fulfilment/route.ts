import { NextRequest, NextResponse } from 'next/server';
import { validateWebhookRequest } from '@/lib/auth/webhookSecurity';
import { logAudit } from '@/lib/services/auditService';

const SERVICE_FULFILLMENT_CALLBACK_URL = 'https://gs-callback.hubtel.com:9055/callback';

interface ServiceFulfilmentPayload {
  SessionId?: string;
  OrderId?: string;
}

/**
 * Hubtel Programmable Services requires a Service Fulfilment URL to register a
 * service at all, but this app's USSD flow never uses the AddToCart handoff
 * that would actually trigger it — the USSD Service Flow Interaction URL
 * (/api/ussd) collects payment itself via the existing Receive-Money flow
 * (see hubtelPaymentService.ts) and simply releases the session, exactly as
 * it already does for the mock simulator. So in normal operation this route
 * is never called; it exists purely to satisfy Hubtel's signup requirement
 * and to fail safely (not silently 404, not leave Hubtel retrying forever)
 * on the off chance it ever is.
 *
 * Per Hubtel's docs, a Service Fulfillment Callback confirming receipt is
 * required within 1 hour — sent synchronously here since there's no
 * queue/retry infrastructure built for this deliberately-unused path.
 */
export async function POST(req: NextRequest) {
  const check = validateWebhookRequest(req);
  if (!check.valid) {
    return NextResponse.json({ error: 'Unauthorized webhook request' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as ServiceFulfilmentPayload | null;
  console.warn('[hubtel] Unexpected Service Fulfilment call — this integration self-collects via Receive-Money, not AddToCart:', JSON.stringify(body));
  await logAudit({
    userId: null,
    action: 'HUBTEL_SERVICE_FULFILMENT_UNEXPECTED',
    entityType: 'HubtelServiceFulfilment',
    entityId: body?.OrderId,
    newValues: body,
  });

  if (body?.SessionId && body?.OrderId) {
    try {
      await fetch(SERVICE_FULFILLMENT_CALLBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ SessionId: body.SessionId, OrderId: body.OrderId, ServiceStatus: 'success', MetaData: null }),
      });
    } catch (e) {
      console.error('[hubtel] Failed to send Service Fulfillment Callback:', e);
    }
  }

  return NextResponse.json({ received: true });
}
