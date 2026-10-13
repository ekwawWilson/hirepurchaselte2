import { NextRequest, NextResponse } from 'next/server';
import { handleUssdInput } from './ussdService';
import { recordHubtelSample } from './hubtelSampleLogService';

// Letters Ghanaian names use that have no accent to strip.
const PLAIN_LETTERS: Record<string, string> = { 'ɛ': 'e', 'Ɛ': 'E', 'ɔ': 'o', 'Ɔ': 'O', 'ŋ': 'n', 'Ŋ': 'N', 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O' };

/**
 * Hubtel rejects a response whose text holds a special character ("Do not
 * include special characters in the Message parameter") — and a rejected
 * screen is a dead session for the customer. Most of what the menu says is
 * fixed wording, but a customer's or the company's name is typed by a
 * person: Esi's "É" or Kɔfi's "ɔ" would do it. Accents are dropped, letters
 * with no plain form mapped, typographic punctuation straightened, and
 * anything still outside plain text removed. Line breaks are kept.
 */
export function ussdSafeText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[ɛƐɔƆŋŊßæÆøØ]/g, (c) => PLAIN_LETTERS[c])
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/(GH)?₵/g, 'GHS')
    .replace(/[^\x20-\x7E\n]/g, '');
}

/**
 * Answers one step of a USSD session in Hubtel's Programmable Services
 * contract (SessionId/Mobile/Message/Type/Operator in; SessionId/Type/
 * Message/Label/DataType/FieldType — and Item, when the answer is
 * AddToCart — out). The caller has already established
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
  //
  // A session that ends by handing the customer to Hubtel's checkout answers
  // AddToCart with the Item to be paid for (Price in cedis); for every other
  // type Hubtel requires Item to be absent.
  const response = {
    SessionId: sessionId,
    Type: result.checkout ? 'AddToCart' : result.continueSession ? 'response' : 'release',
    Message: ussdSafeText(result.message),
    ...(result.checkout && {
      Item: { ItemName: ussdSafeText(result.checkout.itemName), Qty: 1, Price: result.checkout.amountMinor / 100 },
    }),
    Label: ussdSafeText(result.label),
    DataType: result.continueSession ? 'input' : 'display',
    FieldType: result.fieldType ?? 'text',
  };
  // A genuine dial-in captured for Settings > Hubtel Diagnostics's
  // sample-payloads panel — recordHubtelSample swallows its own errors, so
  // this can never fail the actual USSD response the gateway is waiting on.
  await recordHubtelSample('USSD', body, response);
  return NextResponse.json(response);
}
