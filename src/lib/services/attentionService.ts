import { prisma } from '../db/prisma';
import { listOpenAlerts } from './alertService';
import { countPendingApprovals } from './approvalService';
import { countFollowUpsDue } from './arrearsFollowUpService';
import { ledgerBalance } from './agentLedgerService';
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

  const isAgent = user.roleName === 'AGENT';
  const [paymentsToReview, refunds, approvals, followUps, alerts, contractsToApprove, remittancesToConfirm, sentBack, agentEntries] = await Promise.all([
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
    // Agents' submissions waiting on an approver, and their claims to have paid cash in.
    can('contract.approve') ? prisma.contract.count({ where: { ...branch, status: 'PENDING_APPROVAL' } }) : 0,
    can('agent.ledger.manage')
      ? prisma.agentRemittance.count({ where: { status: 'PENDING', ...(user.branchId && { agent: { branchId: user.branchId } }) } })
      : 0,
    // An agent's own: contracts sent back to them, and what they and the office owe each other.
    isAgent ? prisma.contract.count({ where: { createdById: user.id, status: 'REVISION_REQUESTED' } }) : 0,
    isAgent ? prisma.agentDepositLedger.findMany({ where: { agentId: user.id, status: { not: 'SETTLED' } } }) : [],
  ]);
  const agentBalances = agentEntries.map(ledgerBalance);

  return {
    paymentsToReview,
    refundsOwed: refunds?._count ?? 0,
    refundsOwedMinor: refunds?._sum.refundDueMinor ?? 0,
    approvalsWaiting: approvals,
    contractsToApprove,
    remittancesToConfirm,
    contractsSentBack: sentBack,
    cashToRemitMinor: agentBalances.filter((b) => b > 0).reduce((s, b) => s + b, 0),
    commissionOwedToYouMinor: agentBalances.filter((b) => b < 0).reduce((s, b) => s - b, 0),
    followUpsDue: followUps,
    alerts,
    // Not an alert that comes and goes, but a standing fact worth saying
    // plainly: with no provider set up, messages are written to a log and
    // reach nobody, while the app records them as sent.
    smsNotSending: can('settings.manage') && process.env.SMS_PROVIDER !== 'hubtel',
  };
}
