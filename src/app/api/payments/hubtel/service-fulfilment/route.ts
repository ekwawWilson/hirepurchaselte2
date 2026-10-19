import { NextRequest, NextResponse } from 'next/server';
import { validateWebhookRequest, logRejectedWebhook } from '@/lib/auth/webhookSecurity';
import { handleServiceFulfilment } from './handler';

/**
 * The Service Fulfilment URL registered with Hubtel. After the USSD menu
 * answers AddToCart, Hubtel's checkout takes the customer's payment and
 * posts the result here; the payment is applied to the contract and Hubtel
 * is told the outcome (ussdCheckoutService.processServiceFulfilment).
 *
 * Carries the shared webhook token as `?token=`, like every other URL handed
 * to Hubtel. The same handler also answers at
 * /api/payments/hubtel/service-fulfilment/<token>, for a gateway that drops
 * the query string.
 */
export async function POST(req: NextRequest) {
  const check = validateWebhookRequest(req);
  if (!check.valid) {
    logRejectedWebhook(req, check.reason);
    return NextResponse.json({ error: 'Unauthorized webhook request' }, { status: 401 });
  }
  return handleServiceFulfilment(req);
}
