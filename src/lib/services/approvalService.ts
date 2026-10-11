import { prisma } from '../db/prisma';
import { getControlSettings } from './controlSettingsService';
import { reversePayment, PaymentError } from './paymentService';
import { writeOffContract, cancelContract, ContractError } from './contractService';
import { logAudit } from './auditService';
import type { AuthenticatedUser } from '../auth/types';
import type { Permission } from '../constants/rbac';

/**
 * Two people for the actions that take money off the books: reversing a
 * payment, writing off a contract, and cancelling a contract money has been
 * paid on (which unwinds or refunds those payments). With the control on
 * (Settings > Controls; on by default), whoever asks for one only files a
 * request, and it happens when a different person who holds the same
 * permission approves it. One person can no longer take cash, reverse the
 * receipt and have nobody else see it.
 */
export class ApprovalError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export type ApprovalKind = 'PAYMENT_REVERSAL' | 'CONTRACT_WRITEOFF' | 'CONTRACT_CANCEL';

const PERMISSION_FOR: Record<ApprovalKind, Permission> = {
  PAYMENT_REVERSAL: 'payment.reverse',
  CONTRACT_WRITEOFF: 'contract.writeoff',
  CONTRACT_CANCEL: 'contract.cancel',
};

export const APPROVAL_PERMISSIONS = Object.values(PERMISSION_FOR);

const holds = (user: AuthenticatedUser, permission: Permission) =>
  user.roleName === 'SUPER_ADMIN' || user.permissions.includes(permission);

export async function secondApprovalRequired(): Promise<boolean> {
  return (await getControlSettings()).requireSecondApproval;
}

export async function requestApproval(params: {
  kind: ApprovalKind; targetId: string; contractId: string; branchId: string; reason: string; requestedById: string;
}) {
  const waiting = await prisma.approvalRequest.findFirst({ where: { kind: params.kind, targetId: params.targetId, status: 'PENDING' } });
  if (waiting) throw new ApprovalError('This is already waiting for a second person to approve it', 409);
  return prisma.approvalRequest.create({ data: params });
}

const APPROVAL_INCLUDE = {
  contract: { select: { id: true, contractNumber: true, totalPayableMinor: true, totalPaidMinor: true, customer: { select: { firstName: true, lastName: true } } } },
  requestedBy: { select: { id: true, firstName: true, lastName: true } },
  decidedBy: { select: { firstName: true, lastName: true } },
} as const;

/** Requests in the caller's branches, of the kinds they could decide, with the amount each concerns. */
export async function listApprovals(params: { user: AuthenticatedUser; status: 'PENDING' | 'DECIDED' }) {
  const kinds = (Object.keys(PERMISSION_FOR) as ApprovalKind[]).filter((k) => holds(params.user, PERMISSION_FOR[k]));
  const rows = await prisma.approvalRequest.findMany({
    where: {
      kind: { in: kinds },
      status: params.status === 'PENDING' ? 'PENDING' : { not: 'PENDING' },
      ...(params.user.branchId && { branchId: params.user.branchId }),
    },
    include: APPROVAL_INCLUDE,
    orderBy: params.status === 'PENDING' ? { createdAt: 'asc' } : { decidedAt: 'desc' },
    take: 100,
  });

  const payments = await prisma.payment.findMany({
    where: { id: { in: rows.filter((r) => r.kind === 'PAYMENT_REVERSAL').map((r) => r.targetId) } },
    select: { id: true, amountMinor: true, channel: true, receiptNumber: true, receivedAt: true },
  });
  const paymentById = new Map(payments.map((p) => [p.id, p]));

  return rows.map((r) => ({
    ...r,
    payment: paymentById.get(r.targetId) ?? null,
    // What is at stake: the payment; what a cancellation would hand back; or
    // what a write-off gives up — whatever of the contract is still unpaid.
    amountMinor: r.kind === 'PAYMENT_REVERSAL' ? paymentById.get(r.targetId)?.amountMinor ?? null
      : r.kind === 'CONTRACT_CANCEL' ? r.contract.totalPaidMinor
      : r.contract.totalPayableMinor === null ? null : Math.max(0, r.contract.totalPayableMinor - r.contract.totalPaidMinor),
    // The one thing the screen must not offer: approving your own request.
    mine: r.requestedById === params.user.id,
  }));
}

export async function countPendingApprovals(user: AuthenticatedUser): Promise<number> {
  const kinds = (Object.keys(PERMISSION_FOR) as ApprovalKind[]).filter((k) => holds(user, PERMISSION_FOR[k]));
  if (kinds.length === 0) return 0;
  return prisma.approvalRequest.count({
    where: { kind: { in: kinds }, status: 'PENDING', requestedById: { not: user.id }, ...(user.branchId && { branchId: user.branchId }) },
  });
}

/**
 * Approves (and carries out) or rejects a request. The person who asked may
 * withdraw it — a rejection of their own request — but can never approve it.
 */
export async function decideApproval(params: { id: string; decision: 'APPROVE' | 'REJECT'; note?: string; user: AuthenticatedUser }) {
  const { user } = params;
  const request = await prisma.approvalRequest.findUnique({ where: { id: params.id } });
  if (!request) throw new ApprovalError('Request not found', 404);
  const kind = request.kind as ApprovalKind;
  if (!holds(user, PERMISSION_FOR[kind]) || (user.branchId && user.branchId !== request.branchId)) {
    throw new ApprovalError('Forbidden', 403);
  }
  if (params.decision === 'APPROVE' && request.requestedById === user.id) {
    throw new ApprovalError('You asked for this, so a different person has to approve it', 403);
  }
  if (params.decision === 'REJECT' && request.requestedById !== user.id && !params.note?.trim()) {
    throw new ApprovalError('Say why you are rejecting this');
  }

  // Claimed first, so two approvers pressing at once cannot both carry it out.
  const status = params.decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
  const claimed = await prisma.approvalRequest.updateMany({
    where: { id: request.id, status: 'PENDING' },
    data: { status, decidedById: user.id, decisionNote: params.note?.trim() || null, decidedAt: new Date() },
  });
  if (claimed.count === 0) throw new ApprovalError('This request has already been decided', 409);

  if (params.decision === 'APPROVE') {
    try {
      await carryOut(request, user.id);
    } catch (e) {
      // Nothing happened, so the request is still open — to be rejected, or
      // approved once whatever blocked it is cleared.
      await prisma.approvalRequest.update({ where: { id: request.id }, data: { status: 'PENDING', decidedById: null, decisionNote: null, decidedAt: null } });
      if (e instanceof PaymentError || e instanceof ContractError) throw new ApprovalError(e.message);
      throw e;
    }
  }

  await logAudit({
    userId: user.id, action: params.decision === 'APPROVE' ? 'APPROVAL_APPROVE' : 'APPROVAL_REJECT', entityType: 'ApprovalRequest', entityId: request.id,
    newValues: { kind, targetId: request.targetId, contractId: request.contractId, requestedById: request.requestedById, note: params.note ?? null },
  });
  return prisma.approvalRequest.findUniqueOrThrow({ where: { id: request.id }, include: APPROVAL_INCLUDE });
}

/** The action itself, recorded against the person who asked for it and the one who approved. */
async function carryOut(request: { id: string; kind: string; targetId: string; reason: string; requestedById: string }, approvedById: string) {
  if (request.kind === 'PAYMENT_REVERSAL') {
    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: request.targetId } });
    await reversePayment({ paymentId: request.targetId, reason: request.reason, reversedById: request.requestedById });
    await logAudit({
      userId: request.requestedById, action: 'PAYMENT_REVERSE', entityType: 'Payment', entityId: request.targetId,
      oldValues: payment, newValues: { reason: request.reason, approvedById, approvalRequestId: request.id },
    });
    return;
  }
  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: request.targetId } });
  const action = { contractId: request.targetId, reason: request.reason, userId: request.requestedById };
  if (request.kind === 'CONTRACT_CANCEL') await cancelContract(action);
  else await writeOffContract(action);
  await logAudit({
    userId: request.requestedById, action: request.kind, entityType: 'Contract', entityId: request.targetId,
    oldValues: contract, newValues: { reason: request.reason, approvedById, approvalRequestId: request.id },
  });
}
