import { prisma } from '../db/prisma';
import { CUSTOMER_SUMMARY_SELECT } from './customerService';

export class RefundError extends Error {}

type Scope = { branchId?: string };

const REFUND_SELECT = {
  id: true, contractNumber: true, contractType: true, cancelledAt: true, cancelReason: true,
  refundDueMinor: true, refundedMinor: true, refundedAt: true, refundNote: true, refundedById: true,
  customer: { select: CUSTOMER_SUMMARY_SELECT },
} as const;

/**
 * Cancelled contracts on which money had been paid: what is owed back to (or
 * still to be settled with) each customer, and what has been recorded as
 * handed over. Before this, the figure was shown once, in a toast, to
 * whoever pressed Cancel.
 */
export async function listRefunds(params: { scope: Scope; status: 'OWED' | 'SETTLED' }) {
  const where = {
    ...params.scope, status: 'CANCELLED', refundDueMinor: { gt: 0 },
    refundedAt: params.status === 'OWED' ? null : { not: null },
  };
  const [contracts, owed] = await Promise.all([
    prisma.contract.findMany({
      where, select: REFUND_SELECT,
      orderBy: params.status === 'OWED' ? { cancelledAt: 'asc' } : { refundedAt: 'desc' }, take: 200,
    }),
    prisma.contract.aggregate({
      where: { ...params.scope, status: 'CANCELLED', refundDueMinor: { gt: 0 }, refundedAt: null },
      _sum: { refundDueMinor: true }, _count: true,
    }),
  ]);

  const staff = await prisma.user.findMany({
    where: { id: { in: contracts.map((c) => c.refundedById).filter((id): id is string => !!id) } },
    select: { id: true, firstName: true, lastName: true },
  });
  const nameById = new Map(staff.map((u) => [u.id, `${u.firstName} ${u.lastName}`]));

  return {
    refunds: contracts.map((c) => ({ ...c, refundedByName: c.refundedById ? nameById.get(c.refundedById) ?? null : null })),
    owedCount: owed._count,
    owedTotalMinor: owed._sum.refundDueMinor ?? 0,
  };
}

/**
 * Records what was actually handed back. Less than what was due — nothing
 * at all, if the customer kept the device — needs a note saying why.
 */
export async function recordRefund(params: { contractId: string; refundedMinor: number; note?: string; userId: string }) {
  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: params.contractId } });
  if (contract.status !== 'CANCELLED' || !contract.refundDueMinor) throw new RefundError('Nothing is owed back on this contract');
  if (contract.refundedAt) throw new RefundError('This refund has already been recorded');
  if (!Number.isInteger(params.refundedMinor) || params.refundedMinor < 0 || params.refundedMinor > contract.refundDueMinor) {
    throw new RefundError('The amount handed back must be between zero and what was due');
  }
  const note = params.note?.trim() || null;
  if (params.refundedMinor < contract.refundDueMinor && !note) {
    throw new RefundError('Say why less than the full amount was handed back');
  }

  // Claimed on refundedAt being empty, so two people recording it at once cannot both succeed.
  const claimed = await prisma.contract.updateMany({
    where: { id: contract.id, refundedAt: null },
    data: { refundedMinor: params.refundedMinor, refundedAt: new Date(), refundedById: params.userId, refundNote: note },
  });
  if (claimed.count === 0) throw new RefundError('This refund has already been recorded');
  return prisma.contract.findUniqueOrThrow({ where: { id: contract.id }, select: REFUND_SELECT });
}
