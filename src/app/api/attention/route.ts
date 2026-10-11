import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth/rbac';
import { needsAttention } from '@/lib/services/attentionService';

/** What is waiting on the signed-in user — each item only if they can act on it (attentionService.ts). */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  return NextResponse.json(await needsAttention(auth.user));
}
