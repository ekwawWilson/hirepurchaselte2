import { NextRequest, NextResponse } from 'next/server';
import { isWebhookToken } from '@/lib/auth/webhookSecurity';
import { answerUssdRequest } from '@/lib/services/ussdGatewayService';

/**
 * The Service Flow Interaction URL registered with Hubtel: the shared secret
 * is part of the path, the one place a gateway that can send no header of
 * ours is certain to carry it. Anything else gets a plain 404, the same as a
 * route that isn't there.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  if (!isWebhookToken((await params).token)) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return answerUssdRequest(req);
}
