import { NextRequest, NextResponse } from 'next/server';
import { handleUssdInput } from '@/lib/services/ussdService';

/**
 * USSD gateway webhook. Deliberately unauthenticated (a real USSD gateway
 * calls this directly, identified only by the phone session — there's no
 * user login at this layer) and used by both a real Hubtel integration and
 * the mock simulator page. Request/response field names loosely follow
 * Hubtel's own USSD contract (SessionId/Mobile/Message/Type) for realism.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json()) as { SessionId?: string; Mobile?: string; Message?: string; Type?: string };
  const { SessionId: sessionId, Mobile: mobile, Message: message, Type: type } = body;

  if (!sessionId || !mobile) {
    return NextResponse.json({ error: 'SessionId and Mobile are required' }, { status: 400 });
  }

  const result = await handleUssdInput({
    sessionId,
    msisdn: mobile,
    input: message ?? '',
    isNewSession: type === 'Initiation',
  });

  return NextResponse.json({
    SessionId: sessionId,
    Message: result.message,
    Type: result.continueSession ? 'Response' : 'Release',
  });
}
