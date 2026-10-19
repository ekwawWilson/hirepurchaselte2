import { NextRequest, NextResponse } from 'next/server';
import { processServiceFulfilment } from '@/lib/services/ussdCheckoutService';
import { HubtelError } from '@/lib/services/hubtelPaymentService';
import { recordHubtelSample } from '@/lib/services/hubtelSampleLogService';

/**
 * What both Service Fulfilment addresses do once the caller is known to be
 * Hubtel. Once the request is understood the answer is always 200: what
 * Hubtel needs to know about the order goes in the Service Fulfilment
 * Callback, not in this response.
 */
export async function handleServiceFulfilment(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    console.warn('[hubtel] service fulfilment arrived without a JSON body');
    return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  }
  const { SessionId, OrderId, OrderInfo } = body as { SessionId?: string; OrderId?: string; OrderInfo?: { Status?: string } };
  console.log(`[hubtel] service fulfilment received: session ${SessionId ?? '?'}, order ${OrderId ?? '?'}, status ${OrderInfo?.Status ?? '?'}`);

  try {
    const result = await processServiceFulfilment(body);
    await recordHubtelSample('SERVICE_FULFILMENT', body, result);
    console.log(`[hubtel] service fulfilment for order ${OrderId ?? '?'}: ${result.matched ? 'matched' : 'no matching session'}, reported ${result.serviceStatus}`);
    return NextResponse.json({ received: true });
  } catch (e) {
    if (e instanceof HubtelError) {
      console.warn(`[hubtel] service fulfilment for order ${OrderId ?? '?'} refused: ${e.message}`);
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    throw e;
  }
}
