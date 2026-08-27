import crypto from 'node:crypto';
import { NextRequest } from 'next/server';

/**
 * Shared-secret verification for the Hubtel callback. Unlike the legacy app
 * (docs/00-legacy-study.md §8), this FAILS CLOSED if WEBHOOK_SHARED_TOKEN
 * isn't configured — a missing secret rejects every callback rather than
 * silently accepting them.
 */
export function validateWebhookRequest(req: NextRequest): { valid: boolean; reason?: string } {
  const secret = process.env.WEBHOOK_SHARED_TOKEN;
  if (!secret) return { valid: false, reason: 'WEBHOOK_SHARED_TOKEN is not configured' };

  const provided =
    req.headers.get('x-webhook-token') ??
    req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ??
    req.nextUrl.searchParams.get('token');

  if (!provided) return { valid: false, reason: 'No webhook token provided' };

  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'Invalid webhook token' };
  }
  return { valid: true };
}
