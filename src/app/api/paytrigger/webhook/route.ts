import { NextRequest, NextResponse } from 'next/server';
import { spoolCallback, processCallbackEvent } from '@/lib/paytrigger/webhook';
import { runInBackground } from '@/lib/paytrigger/notify';

/**
 * The callback URL given to Transsion for PayTrigger: phone activated,
 * locked, unlocked or released. No user session: PayTrigger signs each
 * callback with the API key, checked before anything is acted on
 * (src/lib/paytrigger/webhook.ts). Always answered `{ code: 200 }`, since
 * PayTrigger keeps re-sending anything else, and processed after answering.
 */
export async function POST(req: NextRequest) {
  const ok = NextResponse.json({ code: 200, message: 'Success' });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') return ok;
  try {
    const eventId = await spoolCallback(body, req.headers.get('sign'));
    if (eventId) runInBackground(() => processCallbackEvent(eventId));
  } catch (e) {
    console.error('[paytrigger] could not keep a callback:', e instanceof Error ? e.message : e);
  }
  return ok;
}
