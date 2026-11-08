/**
 * Messages to customers about what happens to their contract and phone. The
 * texts are off until their wording is approved (isActive), and the pop-ups
 * until switched on in Settings.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { enableOptionalContractTypes, freshPhone, makeRequest, registrationFields } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { createContract, cancelContract, writeOffContract } from '@/lib/services/contractService';
import { postPayment } from '@/lib/services/paymentService';
import { rescheduleContract } from '@/lib/services/rescheduleService';
import { markDefaultedContracts } from '@/lib/services/overdueService';
import { sendLockWarnings } from '@/lib/services/reminderService';
import { getWorkingDays } from '@/lib/services/operatingSettingsService';
import { sendPaymentReminders } from '@/lib/paytrigger/reminders';
import { getPayTriggerSettings } from '@/lib/paytrigger/settings';
import { isWorkingDay } from '@/lib/workingDays';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as customersPOST } from '@/app/api/customers/route';

const runId = Date.now().toString().slice(-7) + Math.floor(Math.random() * 100);
let counter = 0;
const unique = () => `${runId}${++counter}`;
const DAY = 24 * 60 * 60 * 1000;
const KEYS = ['paytrigger.lock_tomorrow', 'contract.defaulted', 'contract.cancelled', 'contract.written_off', 'contract.rescheduled', 'customer.portal_password'];
const switchTexts = (isActive: boolean) => prisma.smsTemplate.updateMany({ where: { key: { in: KEYS } }, data: { isActive } });

describe('Customer notices', () => {
  let branchId: string;
  let adminId: string;

  beforeAll(async () => {
    await enableOptionalContractTypes();
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } });
    adminId = admin.id;
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
  });
  afterAll(() => switchTexts(false));

  /** An active sale, its deposit paid, the phone with the customer. */
  async function activeSale(paymentFrequency: 'WEEKLY' | 'DAILY' = 'WEEKLY') {
    const product = await prisma.product.create({ data: { sku: `CN-${unique()}`, name: 'Notice Phone', cashPriceMinor: 60000 } });
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `CN-${unique()}` } });
    const customer = await prisma.customer.create({ data: { membershipId: `CN-${unique()}`, firstName: 'Abena', lastName: 'Notice', phone: await freshPhone(), branchId, createdById: adminId } });
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item.id, branchId, createdById: adminId,
      totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 4, paymentFrequency,
    });
    await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminId });
    return { contract, customer, item };
  }
  const sent = (contractId: string, templateKey: string) => prisma.smsMessage.count({ where: { relatedContractId: contractId, templateKey } });

  it('sends none of the new texts until they are switched on', async () => {
    await switchTexts(false);
    const { contract } = await activeSale();
    await writeOffContract({ contractId: contract.id, reason: 'Stopped paying', userId: adminId, phoneReturned: false });
    expect(await sent(contract.id, 'contract.written_off')).toBe(0);
  });

  it('tells the customer when a contract is cancelled, written off, rescheduled or defaulted', async () => {
    await switchTexts(true);
    const cancelled = await activeSale();
    await cancelContract({ contractId: cancelled.contract.id, reason: 'Returned', userId: adminId, phoneReturned: true });
    expect(await sent(cancelled.contract.id, 'contract.cancelled')).toBe(1);

    const writtenOff = await activeSale();
    await writeOffContract({ contractId: writtenOff.contract.id, reason: 'Stopped paying', userId: adminId, phoneReturned: true });
    expect(await sent(writtenOff.contract.id, 'contract.written_off')).toBe(1);

    const moved = await activeSale();
    await rescheduleContract({ contractId: moved.contract.id, termWeeks: 8, paymentFrequency: 'WEEKLY', reason: 'Asked for longer', userId: adminId });
    const text = await prisma.smsMessage.findFirstOrThrow({ where: { relatedContractId: moved.contract.id, templateKey: 'contract.rescheduled' } });
    expect(text.body).toContain('Next due:');

    const defaulted = await activeSale();
    await prisma.instalment.updateMany({ where: { contractId: defaulted.contract.id }, data: { dueDate: new Date(Date.now() - 400 * DAY), status: 'OVERDUE' } });
    await markDefaultedContracts();
    expect(await sent(defaulted.contract.id, 'contract.defaulted')).toBe(1);
  });

  it('says nothing about a sale that was never approved', async () => {
    await switchTexts(true);
    const product = await prisma.product.create({ data: { sku: `CN-${unique()}`, name: 'Notice Phone', cashPriceMinor: 60000 } });
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `CN-${unique()}` } });
    const customer = await prisma.customer.create({ data: { membershipId: `CN-${unique()}`, firstName: 'Esi', lastName: 'Notice', phone: await freshPhone(), branchId, createdById: adminId } });
    const contract = await createContract({ contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item.id, branchId, createdById: adminId, requiresApproval: true, totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 4, paymentFrequency: 'WEEKLY' });
    await cancelContract({ contractId: contract.id, reason: 'Declined', userId: adminId });
    expect(await sent(contract.id, 'contract.cancelled')).toBe(0);
  });

  it('texts a new customer their sign-in password, and keeps no readable copy', async () => {
    await switchTexts(true);
    const token = (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email: 'cashier@example.test', password: 'Passw0rd!123' } }))).json()).token as string;
    const phone = await freshPhone();
    const res = await customersPOST(makeRequest('POST', '/api/customers', { token, body: { ...registrationFields(), firstName: 'Kofi', lastName: 'Notice', phone } }));
    expect(res.status).toBe(201);
    const { customer, portalPassword } = await res.json();
    const sms = await prisma.smsMessage.findFirstOrThrow({ where: { relatedCustomerId: customer.id, templateKey: 'customer.portal_password' } });
    expect(sms.body).toContain('******');
    expect(sms.body).not.toContain(portalPassword);
  });

  async function workingDay() {
    const days = await getWorkingDays();
    const when = new Date();
    while (!isWorkingDay(when, days)) when.setTime(when.getTime() + DAY);
    return when;
  }
  const startOf = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

  async function withPhone(sale: Awaited<ReturnType<typeof activeSale>>, data: { committedState?: string; providerExpiresAt?: Date } = {}) {
    const imei = `35${unique().padStart(13, '0').slice(-13)}`;
    return prisma.payTriggerDevice.create({ data: { inventoryItemId: sale.item.id, imei, deviceTag: `T-${imei}`, contractId: sale.contract.id, enrollmentStatus: 'ACTIVE', committedState: 'UNLOCKED', ...data } });
  }

  it('warns once the day before a phone locks, and only if money is still due', async () => {
    await switchTexts(true);
    const now = await workingDay();
    const tomorrow = new Date(startOf(now).getTime() + DAY + 8 * 3_600_000);

    const behind = await activeSale();
    await prisma.instalment.updateMany({ where: { contractId: behind.contract.id, instalmentNo: 1 }, data: { dueDate: new Date(startOf(now).getTime() - 3 * DAY), status: 'OVERDUE' } });
    await withPhone(behind, { providerExpiresAt: tomorrow });
    await sendLockWarnings(now);
    await sendLockWarnings(now);
    expect(await sent(behind.contract.id, 'paytrigger.lock_tomorrow')).toBe(1);
    const text = await prisma.smsMessage.findFirstOrThrow({ where: { relatedContractId: behind.contract.id, templateKey: 'paytrigger.lock_tomorrow' } });
    expect(text.body).toContain(tomorrow.toISOString().slice(0, 10));

    const nothingDue = await activeSale();
    await prisma.instalment.updateMany({ where: { contractId: nothingDue.contract.id }, data: { dueDate: new Date(startOf(now).getTime() + 10 * DAY) } });
    await withPhone(nothingDue, { providerExpiresAt: tomorrow });
    await sendLockWarnings(now);
    expect(await sent(nothingDue.contract.id, 'paytrigger.lock_tomorrow')).toBe(0);
  });

  describe('Pop-ups on the phone', () => {
    const now = new Date();
    const settings = async (extra = {}) => ({ ...(await getPayTriggerSettings()), reminderEnabled: true, reminderDaysBefore: '3,1,0', reminderIncludeDaily: false, ...extra });
    const reminded = (deviceId: string) => prisma.payTriggerActionLog.count({ where: { deviceId, action: 'REMIND', success: true } });
    const dueIn = (sale: Awaited<ReturnType<typeof activeSale>>, days: number) => prisma.instalment.updateMany({ where: { contractId: sale.contract.id, instalmentNo: 1 }, data: { dueDate: new Date(now.getTime() + days * DAY) } });

    it('reminds on the set days, once a day, and never while switched off', async () => {
      const sale = await activeSale();
      await dueIn(sale, 1);
      const device = await withPhone(sale);
      await sendPaymentReminders({ ...(await settings()), reminderEnabled: false }, now);
      expect(await reminded(device.id)).toBe(0);
      await sendPaymentReminders(await settings(), now);
      await sendPaymentReminders(await settings(), now);
      expect(await reminded(device.id)).toBe(1);

      const notYet = await activeSale();
      await dueIn(notYet, 2);
      const quiet = await withPhone(notYet);
      await sendPaymentReminders(await settings(), now);
      expect(await reminded(quiet.id)).toBe(0);
    });

    it('leaves out locked phones, and daily payers unless they are included', async () => {
      const locked = await activeSale();
      await dueIn(locked, 1);
      const lockedDevice = await withPhone(locked, { committedState: 'LOCKED' });
      const daily = await activeSale('DAILY');
      await dueIn(daily, 1);
      const dailyDevice = await withPhone(daily);
      await sendPaymentReminders(await settings(), now);
      expect(await reminded(lockedDevice.id)).toBe(0);
      expect(await reminded(dailyDevice.id)).toBe(0);
      await sendPaymentReminders(await settings({ reminderIncludeDaily: true }), now);
      expect(await reminded(dailyDevice.id)).toBe(1);
    });
  });
});
