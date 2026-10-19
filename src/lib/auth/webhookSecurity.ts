import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

/**
 * Shared-secret verification for the Hubtel callback. Unlike the legacy app
 * (docs/00-legacy-study.md §8), this FAILS CLOSED if WEBHOOK_SHARED_TOKEN
 * isn't configured — a missing secret rejects every callback rather than
 * silently accepting them.
 */
export function validateWebhookRequest(req: NextRequest): { valid: boolean; reason?: string } {
  if (!process.env.WEBHOOK_SHARED_TOKEN) return { valid: false, reason: 'WEBHOOK_SHARED_TOKEN is not configured' };

  const provided =
    req.headers.get('x-webhook-token') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    req.nextUrl.searchParams.get('token');

  if (!provided) return { valid: false, reason: 'No webhook token provided' };
  return isWebhookToken(provided) ? { valid: true } : { valid: false, reason: 'Invalid webhook token' };
}

/**
 * Notes a Hubtel callback this server turned away. Without it a refused
 * callback leaves no trace anywhere — the web server keeps no access log —
 * and "Hubtel says it paid but nothing arrived" cannot be told apart from
 * "Hubtel never called". The path is logged without its query string, and
 * the token itself never, so the log is safe to read and share.
 */
export function logRejectedWebhook(req: NextRequest, reason: string | undefined, path = req.nextUrl.pathname): void {
  const from = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  console.warn(`[webhook] refused ${req.method} ${path} from ${from}: ${reason ?? 'invalid token'}`);
}

/** Whether `candidate` is the configured shared secret. False, always, when none is configured. */
export function isWebhookToken(candidate: string): boolean {
  const secret = process.env.WEBHOOK_SHARED_TOKEN;
  if (!secret) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The two addresses Hubtel's Programmable Services form asks for, on this
 * deployment's own domain (taken from HUBTEL_CALLBACK_URL). Both carry the
 * shared secret, since Hubtel can add no header of ours to its calls — the
 * interaction URL in its path rather than a query string, so it survives a
 * form or gateway that drops one. Null until the domain and secret are set.
 */
export function programmableServiceUrls(): { interactionUrl: string; fulfilmentUrl: string } | null {
  const secret = process.env.WEBHOOK_SHARED_TOKEN;
  if (!secret || !process.env.HUBTEL_CALLBACK_URL) return null;
  try {
    const { origin } = new URL(process.env.HUBTEL_CALLBACK_URL);
    return {
      interactionUrl: `${origin}/api/ussd/${secret}`,
      fulfilmentUrl: appendWebhookToken(`${origin}/api/payments/hubtel/service-fulfilment`),
    };
  } catch {
    return null;
  }
}

/**
 * Appends WEBHOOK_SHARED_TOKEN as a `?token=` query param to a callback URL
 * before handing it to Hubtel — the counterpart to validateWebhookRequest's
 * own check of that same query param. Without this, a real Hubtel callback
 * would arrive with no token at all and be rejected outright.
 */
export function appendWebhookToken(callbackUrl: string): string {
  const secret = process.env.WEBHOOK_SHARED_TOKEN;
  if (!secret || !callbackUrl) return callbackUrl;
  try {
    const parsed = new URL(callbackUrl);
    parsed.searchParams.set('token', secret);
    return parsed.toString();
  } catch {
    const separator = callbackUrl.includes('?') ? '&' : '?';
    return `${callbackUrl}${separator}token=${encodeURIComponent(secret)}`;
  }
}
