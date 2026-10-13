import { NextRequest, NextResponse } from 'next/server';
import { validateWebhookRequest } from '@/lib/auth/webhookSecurity';
import { processServiceFulfilment } from '@/lib/services/ussdCheckoutService';
import { HubtelError } from '@/lib/services/hubtelPaymentService';
import { recordHubtelSample } from '@/lib/services/hubtelSampleLogService';

/**
 * The Service Fulfilment URL registered with Hubtel. After the USSD menu
 * answers AddToCart, Hubtel's checkout takes the customer's payment and
 * posts the result here; the payment is applied to the contract and Hubtel
 * is told the outcome (ussdCheckoutService.processServiceFulfilment).
 *
 * Carries the shared webhook token in its address, like every other URL
 * handed to Hubtel. Once the request is understood the answer is always
 * 200: what Hubtel needs to know about the order goes in the Service
 * Fulfilment Callback, not in this response.
 */
export async function POST(req: NextRequest) {
  const check = validateWebhookRequest(req);
  if (!check.valid) {
    return NextResponse.json({ error: 'Unauthorized webhook request' }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });

  try {
    const result = await processServiceFulfilment(body);
    await recordHubtelSample('SERVICE_FULFILMENT', body, result);
    return NextResponse.json({ received: true });
  } catch (e) {
    if (e instanceof HubtelError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
