import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission, assertBranchAccess, assertOwnRecordAccess } from '@/lib/auth/rbac';
import { addCollectionNote, listCollectionNotes, FollowUpError } from '@/lib/services/arrearsFollowUpService';
import type { AuthenticatedUser } from '@/lib/auth/types';

async function reachableContract(user: AuthenticatedUser, id: string): Promise<{ contract: { id: string } } | { error: NextResponse }> {
  const contract = await prisma.contract.findUnique({ where: { id }, select: { id: true, branchId: true, createdById: true } });
  if (!contract) return { error: NextResponse.json({ error: 'Contract not found' }, { status: 404 }) };
  if (!assertBranchAccess(user, contract.branchId) || !assertOwnRecordAccess(user, contract.createdById)) {
    return { error: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) };
  }
  return { contract };
}

/** The history of calls, visits and promises on one contract, newest first. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'contract.view');
  if (!perm.authorized) return perm.error;

  const found = await reachableContract(auth.user, (await params).id);
  if ('error' in found) return found.error;
  return NextResponse.json({ notes: await listCollectionNotes(found.contract.id) });
}

/**
 * Logs one contact with a customer. Open to anyone who deals with customers
 * (registers them or takes their payments) — not to a read-only role.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'customer.create', 'payment.cash.record');
  if (!perm.authorized) return perm.error;

  const found = await reachableContract(auth.user, (await params).id);
  if ('error' in found) return found.error;

  const body = (await req.json().catch(() => ({}))) as {
    outcome?: string; note?: string; promisedAmountMinor?: number | null; promisedDate?: string | null; followUpAt?: string | null;
  };
  try {
    const note = await addCollectionNote({ contractId: found.contract.id, userId: auth.user.id, outcome: body.outcome ?? '', ...body });
    return NextResponse.json({ note }, { status: 201 });
  } catch (e) {
    if (e instanceof FollowUpError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
