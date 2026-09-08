import { NextRequest, NextResponse } from 'next/server';
import { handleUssdInput } from '@/lib/services/ussdService';
import { recordHubtelSample } from '@/lib/services/hubtelSampleLogService';

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
    isTimeout: type === 'Timeout',
  });

  // Field names/casing and the Label/DataType/FieldType fields follow Hubtel's
  // Programmable Services response contract exactly — Label/DataType/FieldType
  // are Mandatory there, and a missing one (or a wrong-cased Type value) is what
  // produces Hubtel's own "invalid response, Error: UUE" rejection.
  const response = {
    SessionId: sessionId,
    Type: result.continueSession ? 'response' : 'release',
    Message: result.message,
    Label: result.label,
    DataType: result.continueSession ? 'input' : 'display',
    FieldType: result.fieldType ?? 'text',
  };
  // A genuine dial-in captured for Settings > Hubtel Diagnostics's
  // sample-payloads panel — recordHubtelSample swallows its own errors, so
  // this can never fail the actual USSD response the gateway is waiting on.
  await recordHubtelSample('USSD', body, response);
  return NextResponse.json(response);
}
