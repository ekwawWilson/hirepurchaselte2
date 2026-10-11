import { NextRequest, NextResponse } from 'next/server';
import { handleUssdInput } from './ussdService';
import { recordHubtelSample } from './hubtelSampleLogService';

/**
 * Answers one step of a USSD session in Hubtel's Programmable Services
 * contract (SessionId/Mobile/Message/Type/Operator in; SessionId/Type/
 * Message/Label/DataType/FieldType out). The caller has already established
 * who is asking — see the two routes under /api/ussd.
 */
export async function answerUssdRequest(req: NextRequest): Promise<NextResponse> {
  const body = (await req.json().catch(() => null)) as {
    SessionId?: string; Mobile?: string; Message?: string; Type?: string; Operator?: string;
  } | null;
  if (!body) return NextResponse.json({ error: 'Request body must be valid JSON' }, { status: 400 });
  const { SessionId: sessionId, Mobile: mobile, Message: message, Type: type, Operator: operator } = body;

  if (!sessionId || !mobile) {
    return NextResponse.json({ error: 'SessionId and Mobile are required' }, { status: 400 });
  }

  const result = await handleUssdInput({
    sessionId,
    msisdn: mobile,
    operator,
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
