import { NextRequest, NextResponse } from 'next/server';
import { validateWebhookRequest } from '@/lib/auth/webhookSecurity';
import { processPreapprovalCallback, PreapprovalError } from '@/lib/services/hubtelPreapprovalService';

/**
 * Live-mode Hubtel direct-debit preapproval callback — fires once the
 * customer completes the USSD/OTP prompt Hubtel sent them, flipping a
 * PENDING mandate to APPROVED (or CANCELLED/FAILED). Not used by the mock
 * flow (mock mode resolves synchronously inside initiatePreapproval).
 */
export async function POST(req: NextRequest) {
  const check = validateWebhookRequest(req);
  if (!check.valid) {
    return NextResponse.json({ error: 'Unauthorized webhook request' }, { status: 401 });
  }

  const body = await req.json();

  try {
    await processPreapprovalCallback(body);
    return NextResponse.json({ received: true });
  } catch (e) {
    if (e instanceof PreapprovalError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
