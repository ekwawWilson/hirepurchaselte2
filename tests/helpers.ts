import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';

/**
 * Save to Own and Device Loan are off until activated (Settings > Contract
 * types). Call in beforeAll of any test file that creates them.
 */
export async function enableOptionalContractTypes() {
  await prisma.contractTypeSettings.upsert({
    where: { id: 'singleton' },
    create: { id: 'singleton', saveToOwnEnabled: true, deviceLoanEnabled: true },
    update: { saveToOwnEnabled: true, deviceLoanEnabled: true },
  });
}

const BASE = 'http://localhost:3000';

/** Builds a NextRequest for calling a Route Handler function directly, no running server needed. */
export function makeRequest(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): NextRequest {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (opts.token) headers.set('Authorization', `Bearer ${opts.token}`);
  return new NextRequest(new URL(BASE + path), {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
}

/** Dynamic route params are a Promise in Next.js 15+ route handlers. */
export function makeParams<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

/**
 * A minimal JPEG (just the SOI marker and a few bytes) — enough for
 * validateCustomerPhoto, which checks the file signature and size, not that
 * the picture decodes.
 */
export const TEST_PHOTO_DATA_URL = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]).toString('base64')}`;

/** Everything customer registration requires besides a name and phone number. */
export function registrationFields() {
  return {
    address: '12 Test Street, Accra',
    occupation: 'Trader',
    workAddress: 'Makola Market, Accra',
    photoUrl: TEST_PHOTO_DATA_URL,
  };
}

export type HubtelCall = { url: string; method: string; body: Record<string, unknown> | null };

/** For `withLiveHubtel`'s `respond`: answer with this HTTP status instead of 200. */
export function hubtelHttp(status: number, body: unknown) {
  return { __httpStatus: status, body };
}

/**
 * Runs `fn` in live mode with Hubtel replaced by `respond`, which answers each
 * outbound call from its URL and body (JSON, 200 unless wrapped in
 * `hubtelHttp`). Returns every call made, in order. Swaps `globalThis.fetch`
 * directly and restores whatever was there, so tests/setup.ts's real-network
 * guard is back in place afterwards.
 */
export async function withLiveHubtel(respond: (call: HubtelCall) => unknown, fn: () => Promise<void>): Promise<HubtelCall[]> {
  const saved = {
    mode: process.env.HUBTEL_PAYMENTS_MODE, salesId: process.env.HUBTEL_POS_SALES_ID,
    key: process.env.HUBTEL_API_KEY, secret: process.env.HUBTEL_API_SECRET,
  };
  process.env.HUBTEL_PAYMENTS_MODE = 'live';
  process.env.HUBTEL_POS_SALES_ID = '11684';
  process.env.HUBTEL_API_KEY = 'test-key';
  process.env.HUBTEL_API_SECRET = 'test-secret';

  const calls: HubtelCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(init.body as string) : null };
    calls.push(call);
    const answer = respond(call) as { __httpStatus?: number; body?: unknown } | null;
    return answer && typeof answer === 'object' && '__httpStatus' in answer
      ? new Response(JSON.stringify(answer.body), { status: answer.__httpStatus })
      : new Response(JSON.stringify(answer), { status: 200 });
  }) as unknown as typeof fetch;

  try {
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    process.env.HUBTEL_PAYMENTS_MODE = saved.mode;
    process.env.HUBTEL_POS_SALES_ID = saved.salesId;
    process.env.HUBTEL_API_KEY = saved.key;
    process.env.HUBTEL_API_SECRET = saved.secret;
  }
  return calls;
}
