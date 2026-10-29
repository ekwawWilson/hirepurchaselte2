/**
 * The customer portal's own data layer (src/app/portal, /api/portal/*).
 *
 * A customer is not a staff user: they sign in with a phone number rather
 * than an email, they see only their own contracts, and their token carries
 * typ: 'customer' so no staff route will ever accept it (auth/jwt.ts).
 */
import bcrypt from 'bcryptjs';
import { prisma } from '../db/prisma';
import { phoneVariants } from './hubtelClient';
import { getDeviceLoanState } from './paymentService';
import { PRE_APPROVAL_STATUSES } from '../constants/contracts';
import { generatePortalPassword, hashPassword } from './authService';

export class PortalError extends Error {}

export const MIN_PORTAL_PASSWORD_LENGTH = 6;

/**
 * Finds the customer by any of their three registered numbers, in any of the
 * formats a number is written in here (0-, 233- or +233-prefixed) — the same
 * matching USSD does, so a customer can sign in with the number they know.
 */
export async function findCustomerByPhone(phone: string) {
  const variants = phoneVariants(phone);
  if (variants.length === 0) return null;
  return prisma.customer.findFirst({
    where: { OR: variants.flatMap((v) => [{ phone: v }, { phone2: v }, { phone3: v }]) },
  });
}

/**
 * Gives a customer a one-time portal password — at registration, or when
 * they ask staff for one — returned in the clear exactly once for staff to
 * hand over, and replaced by the customer at their first sign-in. Issuing a
 * new one signs out anyone already in on the old one.
 */
export async function issuePortalPassword(customerId: string): Promise<string> {
  const password = generatePortalPassword();
  await prisma.customer.update({
    where: { id: customerId },
    data: { passwordHash: await hashPassword(password), mustChangePassword: true, passwordChangedAt: new Date() },
  });
  return password;
}

/**
 * Sign-in. A customer who has never been issued a password cannot sign in:
 * a phone number is known to everyone who has ever called it, so it is never
 * accepted in a password's place.
 */
export async function authenticateCustomer(phone: string, password: string) {
  const customer = await findCustomerByPhone(phone);
  if (!customer?.passwordHash) return null;
  if (!(await bcrypt.compare(password, customer.passwordHash))) return null;

  await prisma.customer.update({ where: { id: customer.id }, data: { portalLastLoginAt: new Date() } });
  return customer;
}

/** Whether `candidate` is one of this customer's own numbers, in any format. */
export function isOwnPhoneNumber(customer: { phone: string | null; phone2: string | null; phone3: string | null }, candidate: string): boolean {
  const own = new Set([customer.phone, customer.phone2, customer.phone3]
    .filter((p): p is string => !!p)
    .flatMap((p) => phoneVariants(p)));
  return phoneVariants(candidate).some((v) => own.has(v));
}

/** Why a customer may not choose this password, or null. Shared by changing it and resetting it. */
export function newPasswordProblem(customer: { phone: string | null; phone2: string | null; phone3: string | null }, newPassword: string): string | null {
  if (newPassword.length < MIN_PORTAL_PASSWORD_LENGTH) return `Your new password must be at least ${MIN_PORTAL_PASSWORD_LENGTH} characters`;
  if (isOwnPhoneNumber(customer, newPassword)) return 'Choose a password that is not your phone number';
  return null;
}

export async function setCustomerPassword(params: { customerId: string; currentPassword: string; newPassword: string }) {
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: params.customerId } });

  const currentOk = !!customer.passwordHash && await bcrypt.compare(params.currentPassword, customer.passwordHash);
  if (!currentOk) throw new PortalError('Your current password is not correct');
  if (params.newPassword === params.currentPassword) throw new PortalError('Choose a password different from your current one');
  const problem = newPasswordProblem(customer, params.newPassword);
  if (problem) throw new PortalError(problem);

  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      passwordHash: await hashPassword(params.newPassword),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      isActivated: true, // the account is now the customer's own
    },
  });
}

/**
 * Everything the portal shows about one contract, shaped per type: a savings
 * account has no schedule or target, a loan has interest rather than
 * instalments, and only a deposit + instalment contract has both.
 */
export async function portalContract(customerId: string, contractId: string) {
  const contract = await prisma.contract.findFirst({
    // Not yet approved (the Agent module) — the customer hasn't agreed final
    // terms yet (a revision could still change them), so it isn't theirs to
    // see. Reads as "not found", the same as any other contract that isn't theirs.
    where: { id: contractId, customerId, status: { notIn: PRE_APPROVAL_STATUSES } },
    include: {
      product: { select: { name: true } },
      inventoryItem: { select: { serialNumber: true, name: true, description: true } },
      instalments: { orderBy: { instalmentNo: 'asc' } },
      // Enough for the customer's own printable statement and receipts — the
      // same documents staff print (components/documents).
      customer: {
        select: {
          firstName: true, lastName: true, membershipId: true, phone: true, phone2: true, phone3: true,
          address: true, occupation: true, workAddress: true, nationalId: true, guarantorName: true, guarantorPhone: true,
        },
      },
      branch: { select: { name: true, address: true, phone: true } },
      payments: {
        where: { status: 'SUCCESS' },
        orderBy: { receivedAt: 'desc' },
        select: {
          id: true, entryType: true, amountMinor: true, channel: true, status: true, receiptNumber: true, transactionRef: true, notes: true,
          mobileMoneyNetwork: true, receivedAt: true, createdAt: true, reversesPaymentId: true, reversedById: true,
          createdBy: { select: { firstName: true, lastName: true } },
        },
      },
    },
  });
  if (!contract) return null;

  const deviceLoanState = contract.contractType === 'DEVICE_LOAN' ? await getDeviceLoanState(contract.id) : null;
  const charges = await unpaidChargesByContract([contract.id]);
  return { ...contract, deviceLoanState, due: dueSummary(contract, contract.instalments, charges.get(contract.id) ?? 0, deviceLoanState) };
}

export async function portalContracts(customerId: string) {
  const contracts = await prisma.contract.findMany({
    where: { customerId, status: { notIn: PRE_APPROVAL_STATUSES } },
    include: {
      product: { select: { name: true } },
      instalments: { where: { status: { not: 'PAID' } }, select: { instalmentNo: true, dueDate: true, amountDueMinor: true, amountPaidMinor: true, status: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const charges = await unpaidChargesByContract(contracts.map((c) => c.id));

  return Promise.all(contracts.map(async ({ instalments, ...c }) => {
    const deviceLoanState = c.contractType === 'DEVICE_LOAN' ? await getDeviceLoanState(c.id) : null;
    return { ...c, deviceLoanState, due: dueSummary(c, instalments, charges.get(c.id) ?? 0, deviceLoanState) };
  }));
}

/**
 * What a customer owes on a contract right now, as the mobile app shows it:
 * the most one payment can be (totalDueMinor, null for open-ended savings),
 * late charges, what is overdue and what falls due next. The same figures
 * the server checks a payment against (paymentService.amountOwedNow), so the
 * app never offers an amount the server would refuse.
 */
export interface DueSummary {
  totalDueMinor: number | null;
  penaltyOutstandingMinor: number;
  overdueMinor: number;
  overdueCount: number;
  nextDueMinor: number;
  nextDueDate: Date | null;
  unpaidCount: number;
}

async function unpaidChargesByContract(contractIds: string[]): Promise<Map<string, number>> {
  if (contractIds.length === 0) return new Map();
  const rows = await prisma.penalty.groupBy({ by: ['contractId'], where: { contractId: { in: contractIds }, isPaid: false }, _sum: { amountMinor: true } });
  return new Map(rows.map((r) => [r.contractId, r._sum.amountMinor ?? 0]));
}

function dueSummary(
  contract: { contractType: string; status: string; balanceMinor: number | null },
  instalments: Array<{ instalmentNo: number; dueDate: Date; amountDueMinor: number; amountPaidMinor: number; status: string }>,
  chargesMinor: number,
  deviceLoanState: { totalOwedMinor: number } | null,
): DueSummary {
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);
  const unpaid = instalments
    .filter((i) => i.status !== 'PAID' && i.amountDueMinor - i.amountPaidMinor > 0)
    .sort((a, b) => a.instalmentNo - b.instalmentNo);
  const overdue = unpaid.filter((i) => i.status === 'OVERDUE' || i.dueDate < startOfToday);
  const next = unpaid.find((i) => !overdue.includes(i)) ?? null;
  const left = (i: { amountDueMinor: number; amountPaidMinor: number }) => i.amountDueMinor - i.amountPaidMinor;
  const totalDueMinor = contract.contractType === 'SAVE_TO_OWN' ? null
    : contract.contractType === 'DEVICE_LOAN' ? deviceLoanState?.totalOwedMinor ?? 0
      : Math.max(0, contract.balanceMinor ?? 0) + chargesMinor;
  return {
    totalDueMinor,
    penaltyOutstandingMinor: contract.contractType === 'DEVICE_LOAN' ? 0 : chargesMinor,
    overdueMinor: overdue.reduce((s, i) => s + left(i), 0),
    overdueCount: overdue.length,
    nextDueMinor: next ? left(next) : 0,
    nextDueDate: next?.dueDate ?? null,
    unpaidCount: unpaid.length,
  };
}

/** The instalments a customer still owes, soonest first, across every contract. */
export async function portalUpcomingInstalments(customerId: string, take = 10) {
  return prisma.instalment.findMany({
    where: { contract: { customerId, status: { notIn: PRE_APPROVAL_STATUSES } }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
    orderBy: { dueDate: 'asc' },
    take,
    include: { contract: { select: { id: true, contractNumber: true, contractType: true } } },
  });
}

export async function portalPayments(customerId: string, take = 100) {
  return prisma.payment.findMany({
    where: { contract: { customerId }, status: 'SUCCESS' },
    orderBy: { receivedAt: 'desc' },
    take,
    include: { contract: { select: { id: true, contractNumber: true, contractType: true } } },
  });
}
