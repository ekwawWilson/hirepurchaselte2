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
