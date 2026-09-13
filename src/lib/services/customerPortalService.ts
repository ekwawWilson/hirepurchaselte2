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
 * Sign-in. Until a customer has chosen a password, their own phone number is
 * accepted — that is what makes an already-registered customer able to sign
 * in without staff doing anything — and mustChangePassword then forces them
 * to set a real one before they can use the portal.
 */
export async function authenticateCustomer(phone: string, password: string) {
  const customer = await findCustomerByPhone(phone);
  if (!customer) return null;

  const ok = customer.passwordHash
    ? await bcrypt.compare(password, customer.passwordHash)
    : isOwnPhoneNumber(customer, password);
  if (!ok) return null;

  await prisma.customer.update({ where: { id: customer.id }, data: { portalLastLoginAt: new Date() } });
  return customer;
}

/** Whether `candidate` is one of this customer's own numbers, in any format. */
function isOwnPhoneNumber(customer: { phone: string | null; phone2: string | null; phone3: string | null }, candidate: string): boolean {
  const own = new Set([customer.phone, customer.phone2, customer.phone3]
    .filter((p): p is string => !!p)
    .flatMap((p) => phoneVariants(p)));
  return phoneVariants(candidate).some((v) => own.has(v));
}

export async function setCustomerPassword(params: { customerId: string; currentPassword: string; newPassword: string }) {
  const customer = await prisma.customer.findUniqueOrThrow({ where: { id: params.customerId } });

  const currentOk = customer.passwordHash
    ? await bcrypt.compare(params.currentPassword, customer.passwordHash)
    : isOwnPhoneNumber(customer, params.currentPassword);
  if (!currentOk) throw new PortalError('Your current password is not correct');

  if (params.newPassword.length < MIN_PORTAL_PASSWORD_LENGTH) {
    throw new PortalError(`Your new password must be at least ${MIN_PORTAL_PASSWORD_LENGTH} characters`);
  }
  if (isOwnPhoneNumber(customer, params.newPassword)) {
    throw new PortalError('Choose a password that is not your phone number');
  }

  await prisma.customer.update({
    where: { id: customer.id },
    data: {
      passwordHash: await bcrypt.hash(params.newPassword, Number(process.env.BCRYPT_ROUNDS ?? 10)),
      mustChangePassword: false,
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
    where: { id: contractId, customerId },
    include: {
      product: { select: { name: true } },
      inventoryItem: { select: { serialNumber: true } },
      instalments: { orderBy: { instalmentNo: 'asc' } },
      payments: {
        where: { status: 'SUCCESS' },
        orderBy: { receivedAt: 'desc' },
        select: { id: true, entryType: true, amountMinor: true, channel: true, receiptNumber: true, receivedAt: true, reversesPaymentId: true },
      },
    },
  });
  if (!contract) return null;

  const deviceLoanState = contract.contractType === 'DEVICE_LOAN' ? await getDeviceLoanState(contract.id) : null;
  return { ...contract, deviceLoanState };
}

export async function portalContracts(customerId: string) {
  const contracts = await prisma.contract.findMany({
    where: { customerId },
    include: { product: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
  });

  return Promise.all(contracts.map(async (c) => ({
    ...c,
    deviceLoanState: c.contractType === 'DEVICE_LOAN' ? await getDeviceLoanState(c.id) : null,
  })));
}

/** The instalments a customer still owes, soonest first, across every contract. */
export async function portalUpcomingInstalments(customerId: string, take = 10) {
  return prisma.instalment.findMany({
    where: { contract: { customerId }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
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
