import { NextRequest, NextResponse } from 'next/server';
import { isWebhookToken, logRejectedWebhook } from '@/lib/auth/webhookSecurity';
import { handleServiceFulfilment } from '../handler';

/**
 * The Service Fulfilment URL with the shared secret in its path instead of
 * its query string — the same form as the USSD interaction URL, for when
 * Hubtel's side drops `?token=`. Anything else gets a plain 404.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  if (!isWebhookToken((await params).token)) {
    logRejectedWebhook(req, 'wrong token in the address', '/api/payments/hubtel/service-fulfilment/<token>');
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  return handleServiceFulfilment(req);
}
