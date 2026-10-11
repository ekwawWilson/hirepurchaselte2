import { prisma } from '../db/prisma';
import { recordSuccessfulHubtelCharge, HubtelError } from './hubtelPaymentService';

export const MOBILE_MONEY_PAGE_SIZE = 50;

/** NEEDS_REVIEW is only the open queue; one staff have closed reads as RESOLVED. */
export type MobileMoneyFilter = 'NEEDS_REVIEW' | 'PENDING' | 'FAILED' | 'SUCCESS' | 'ALL';

/** Hubtel's own words for how an attempt ended, wherever in the stored payload they sit. */
function outcomeDetail(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const response = (p.response ?? p) as Record<string, unknown>;
    const data = (response.Data ?? response.data ?? {}) as Record<string, unknown>;
    const said = [data.Description, response.Message, response.message].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
    if (said) return said.trim();
    if (p.reconciliation) return p.reason === 'stale-pending-unresolved' ? 'No confirmation from Hubtel in time' : 'Settled by status check';
    if (p.mock) return 'Mock mode — no money moved';
    return null;
  } catch {
    return null;
  }
}

/**
 * Every mobile money attempt — prompts customers started (USSD, portal),
 * prompts staff sent, and direct-debit charges — newest first. The one place
 * to see what was tried, what failed and why, and above all what was
 * collected but could not be applied to a contract (NEEDS_REVIEW).
 */
export async function listMobileMoneyAttempts(params: {
  scope: { branchId?: string; createdById?: string };
  filter: MobileMoneyFilter;
  q?: string;
  page: number;
}) {
  const contractWhere = {
    ...(params.scope.branchId && { branchId: params.scope.branchId }),
    ...(params.scope.createdById && { createdById: params.scope.createdById }),
  };
  const q = params.q?.trim();
  const where = {
    contract: contractWhere,
    ...(params.filter === 'NEEDS_REVIEW' && { status: 'NEEDS_REVIEW', resolvedAt: null }),
    ...(params.filter !== 'NEEDS_REVIEW' && params.filter !== 'ALL' && { status: params.filter }),
    ...(q && {
      OR: [
        { msisdn: { contains: q } },
        { clientReference: { contains: q, mode: 'insensitive' as const } },
        { contract: { ...contractWhere, contractNumber: { contains: q, mode: 'insensitive' as const } } },
        { contract: { ...contractWhere, customer: { OR: [
          { firstName: { contains: q, mode: 'insensitive' as const } },
          { lastName: { contains: q, mode: 'insensitive' as const } },
        ] } } },
      ],
    }),
  };

  const [rows, total, needsReview] = await Promise.all([
    prisma.hubtelTransaction.findMany({
      where,
      include: { contract: { select: { id: true, contractNumber: true, status: true, customer: { select: { firstName: true, lastName: true } } } } },
      orderBy: { createdAt: 'desc' },
      skip: (params.page - 1) * MOBILE_MONEY_PAGE_SIZE,
      take: MOBILE_MONEY_PAGE_SIZE,
    }),
    prisma.hubtelTransaction.count({ where }),
    prisma.hubtelTransaction.count({ where: { contract: contractWhere, status: 'NEEDS_REVIEW', resolvedAt: null } }),
  ]);

  return {
    attempts: rows.map(({ rawCallbackPayload, ...t }) => ({
      ...t,
      status: t.status === 'NEEDS_REVIEW' && t.resolvedAt ? 'RESOLVED' : t.status,
      detail: outcomeDetail(rawCallbackPayload),
    })),
    total,
    pageSize: MOBILE_MONEY_PAGE_SIZE,
    needsReview,
  };
}

/**
 * Tries again to post a collected-but-unapplied charge to its contract —
 * for when whatever blocked it has been put right (the contract reopened, a
 * loan amount corrected). It either posts, or lands back in the queue with
 * the reason logged again.
 */
export async function reapplyCollectedCharge(txnId: string) {
  const txn = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txnId } });
  if (txn.status !== 'NEEDS_REVIEW' || txn.resolvedAt) throw new HubtelError('This payment is not waiting for review');

  await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { status: 'SUCCESS' } });
  await recordSuccessfulHubtelCharge(txn.id, txn.rawCallbackPayload ?? JSON.stringify({ manualReapply: true }));
  return prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txn.id } });
}

/** Closes a collected-but-unapplied charge staff dealt with outside the ledger (refunded it, say), with what they did. */
export async function resolveCollectedCharge(params: { txnId: string; userId: string; note: string }) {
  const txn = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: params.txnId } });
  if (txn.status !== 'NEEDS_REVIEW' || txn.resolvedAt) throw new HubtelError('This payment is not waiting for review');
  if (!params.note.trim()) throw new HubtelError('Say what was done with the money');
  return prisma.hubtelTransaction.update({
    where: { id: txn.id },
    data: { resolvedAt: new Date(), resolvedById: params.userId, resolutionNote: params.note.trim() },
  });
}
