import { prisma } from '../db/prisma';
import { listOpenAlerts } from './alertService';
import { countPendingApprovals } from './approvalService';
import { countFollowUpsDue } from './arrearsFollowUpService';
import type { AuthenticatedUser } from '../auth/types';
import type { Permission } from '../constants/rbac';

/**
 * Everything waiting on a person, in one place, for the dashboard — each
 * item only for someone who can act on it, and scoped as their own screens
 * are. Before this, each of these was a status on a row that nobody would
 * see unless they went looking.
 */
export async function needsAttention(user: AuthenticatedUser) {
  const can = (...perms: Permission[]) => user.roleName === 'SUPER_ADMIN' || perms.some((p) => user.permissions.includes(p));
  const branch = user.branchId ? { branchId: user.branchId } : {};
  const own = user.roleName === 'AGENT' ? { createdById: user.id } : {};

  const [paymentsToReview, refunds, approvals, followUps, alerts] = await Promise.all([
    can('payment.view')
      ? prisma.hubtelTransaction.count({ where: { status: 'NEEDS_REVIEW', resolvedAt: null, ...(user.branchId && { contract: branch }) } })
      : 0,
    can('payment.view')
      ? prisma.contract.aggregate({
          where: { ...branch, status: 'CANCELLED', refundDueMinor: { gt: 0 }, refundedAt: null }, _count: true, _sum: { refundDueMinor: true },
        })
      : null,
    countPendingApprovals(user),
    can('contract.view') ? countFollowUpsDue({ ...branch, ...own }) : 0,
    // What has gone wrong with the system itself is the administrators' to see
    // and clear. A payment needing review is not listed again here: it is
    // counted above, and its alert (which is what texts the owner) closes
    // itself when the payment is applied or resolved.
    can('settings.manage') ? listOpenAlerts().then((all) => all.filter((a) => a.kind !== 'PAYMENT_NEEDS_REVIEW')) : [],
  ]);

  return {
    paymentsToReview,
    refundsOwed: refunds?._count ?? 0,
    refundsOwedMinor: refunds?._sum.refundDueMinor ?? 0,
    approvalsWaiting: approvals,
    followUpsDue: followUps,
    alerts,
    // Not an alert that comes and goes, but a standing fact worth saying
    // plainly: with no provider set up, messages are written to a log and
    // reach nobody, while the app records them as sent.
    smsNotSending: can('settings.manage') && process.env.SMS_PROVIDER !== 'hubtel',
  };
}
