/**
 * Daily payment notifications: the staff "today's payments" feed, and the
 * due-today / overdue reminder SMS to customers.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeRequest } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { createContract } from '@/lib/services/contractService';
import { postPayment, reversePayment } from '@/lib/services/paymentService';
import { todaysPaymentsFeed } from '@/lib/services/reportService';
import { sendDueTodayReminders, sendOverdueReminders } from '@/lib/services/reminderService';
import { generateContractNumber, generateMembershipId, referencePrefix } from '@/lib/utils/idGenerators';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as todaysPaymentsGET } from '@/app/api/dashboard/todays-payments/route';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
const DAY = 24 * 60 * 60 * 1000;

async function login(email: string) {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!123' } }));
  return (await res.json()).token as string;
}

/** A Wednesday some weeks ahead, at 09:00. */
function aWednesday(weeksAhead: number) {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7) + 7 * weeksAhead);
  return d;
}

describe('Daily payment notifications', () => {
  let branchId: string;
  let adminUserId: string;
  let counter = 0;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow()).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
  });

  async function instalmentContract() {
    counter += 1;
    const product = await prisma.product.create({ data: { sku: `NOTIFY-${runId}-${counter}`, name: 'Notify Phone', cashPriceMinor: 100000 } });
    const customer = await prisma.customer.create({
      data: {
        membershipId: `NOTIFY-${runId}-${counter}`, firstName: 'Notify', lastName: `Tester${counter}`,
        phone: `024${runId}${counter}`, branchId, createdById: adminUserId,
      },
    });
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `NOTIFY-SN-${runId}-${counter}` } });
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item.id,
      totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
    });
    // Paying the deposit activates it: reminders are only for ACTIVE (or DEFAULTED) contracts.
    await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });
    return contract;
  }

  describe("today's payments feed", () => {
    it('counts money received today, leaves reversed-out rows out of the count, and hides the total unless asked', async () => {
      const contract = await instalmentContract();
      const { payment } = await postPayment({ contractId: contract.id, amountMinor: 5000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
      const { payment: mistaken } = await postPayment({ contractId: contract.id, amountMinor: 700, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
      const before = await todaysPaymentsFeed({}, { includeTotal: true, take: 500 });
      await reversePayment({ paymentId: mistaken.id, reason: 'Keyed twice', reversedById: adminUserId });

      const withTotal = await todaysPaymentsFeed({}, { includeTotal: true, take: 500 });
      const ids = withTotal.payments.map((p) => p.id);
      expect(ids).toContain(payment.id);
      expect(withTotal.payments.find((p) => p.id === payment.id)?.contract.customer.lastName).toMatch(/^Tester/);
      // The reversal row is not "a payment came in" ...
      expect(withTotal.count).toBe(before.count);
      // ... but it does take the money back out of the net total.
      expect(withTotal.totalMinor).toBe(before.totalMinor! - 700);

      const withoutTotal = await todaysPaymentsFeed({}, { includeTotal: false });
      expect(withoutTotal).not.toHaveProperty('totalMinor');
    });

    it('needs View payments, and gives the total only to staff who can view reports', async () => {
      const sales = await todaysPaymentsGET(makeRequest('GET', '/api/dashboard/todays-payments', { token: await login('sales@example.test') }));
      expect(sales.status).toBe(403);

      const cashier = await todaysPaymentsGET(makeRequest('GET', '/api/dashboard/todays-payments', { token: await login('cashier@example.test') }));
      expect(cashier.status).toBe(200);
      expect(await cashier.json()).toHaveProperty('totalMinor');
    });
  });

  describe('customer reminders', () => {
    // Reminders run on the real clock (a sent message is stamped with the
    // real time), so open every day of the week for these tests — otherwise
    // they would skip, and fail, whenever the suite runs on a weekend.
    let previousDays: { worksSaturday: boolean; worksSunday: boolean } | null = null;

    beforeAll(async () => {
      previousDays = await prisma.operatingSettings.findUnique({ where: { id: 'singleton' }, select: { worksSaturday: true, worksSunday: true } });
      await prisma.operatingSettings.upsert({
        where: { id: 'singleton' },
        create: { id: 'singleton', worksSaturday: true, worksSunday: true },
        update: { worksSaturday: true, worksSunday: true },
      });
    });

    afterAll(async () => {
      await prisma.operatingSettings.update({
        where: { id: 'singleton' },
        data: previousDays ?? { worksSaturday: false, worksSunday: false },
      });
    });

    it('does not remind a contract still waiting for its deposit', async () => {
      const now = new Date();
      counter += 1;
      const product = await prisma.product.create({ data: { sku: `NOTIFY-PD-${runId}-${counter}`, name: 'Notify Phone', cashPriceMinor: 100000 } });
      const customer = await prisma.customer.create({
        data: { membershipId: `NOTIFY-PD-${runId}-${counter}`, firstName: 'Notify', lastName: 'Pending', phone: `025${runId}${counter}`, branchId, createdById: adminUserId },
      });
      const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `NOTIFY-PD-SN-${runId}-${counter}` } });
      const pending = await createContract({
        contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item.id,
        totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY',
        branchId, createdById: adminUserId,
      });
      const dueMidnight = new Date(now); dueMidnight.setHours(0, 0, 0, 0);
      await prisma.instalment.updateMany({ where: { contractId: pending.id, instalmentNo: 1 }, data: { dueDate: dueMidnight } });

      await sendDueTodayReminders(now);
      expect(await prisma.smsMessage.count({ where: { relatedContractId: pending.id, templateKey: 'instalment.due_today' } })).toBe(0);
    });

    it('sends a due-today reminder once, with the amount due', async () => {
      const now = new Date();
      const contract = await instalmentContract();
      const first = await prisma.instalment.findFirstOrThrow({ where: { contractId: contract.id }, orderBy: { instalmentNo: 'asc' } });
      const dueMidnight = new Date(now); dueMidnight.setHours(0, 0, 0, 0);
      // OVERDUE, as the 08:00 sweep leaves an instalment due at midnight today.
      await prisma.instalment.update({ where: { id: first.id }, data: { dueDate: dueMidnight, status: 'OVERDUE' } });

      await sendDueTodayReminders(now);
      await sendDueTodayReminders(now); // a second run the same day sends nothing more

      const sms = await prisma.smsMessage.findMany({ where: { relatedContractId: contract.id, templateKey: 'instalment.due_today' } });
      expect(sms).toHaveLength(1);
      expect(sms[0].body).toContain('is due today');
      expect(sms[0].body).toContain((first.amountDueMinor / 100).toFixed(2));
    });

    it('sends an overdue reminder with the days overdue, and not again within the interval', async () => {
      const now = new Date();
      const contract = await instalmentContract();
      const first = await prisma.instalment.findFirstOrThrow({ where: { contractId: contract.id }, orderBy: { instalmentNo: 'asc' } });
      const fiveDaysAgo = new Date(now.getTime() - 5 * DAY); fiveDaysAgo.setHours(0, 0, 0, 0);
      await prisma.instalment.update({ where: { id: first.id }, data: { dueDate: fiveDaysAgo, status: 'OVERDUE' } });

      await sendOverdueReminders(now);
      await sendOverdueReminders(new Date(now.getTime() + DAY)); // next day: still inside the interval

      const sms = await prisma.smsMessage.findMany({ where: { relatedContractId: contract.id, templateKey: 'instalment.overdue' } });
      expect(sms).toHaveLength(1);
      expect(sms[0].body).toContain('overdue by 5 day(s)');
    });

    it('sends nothing on a day the business is closed', async () => {
      await prisma.operatingSettings.update({ where: { id: 'singleton' }, data: { worksSunday: false } });
      try {
        const sunday = aWednesday(4);
        sunday.setDate(sunday.getDate() + 4);
        expect((await sendDueTodayReminders(sunday)).skippedClosedDay).toBe(true);
        expect((await sendOverdueReminders(sunday)).skippedClosedDay).toBe(true);
      } finally {
        await prisma.operatingSettings.update({ where: { id: 'singleton' }, data: { worksSunday: true } });
      }
    });
  });

  describe('generated references', () => {
    let previousName: string | undefined;

    beforeAll(async () => {
      previousName = (await prisma.orgSettings.findUnique({ where: { id: 'singleton' } }))?.companyName;
      await prisma.orgSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', companyName: 'Kumasi Phone Credit' }, update: { companyName: 'Kumasi Phone Credit' } });
    });

    afterAll(async () => {
      if (previousName) await prisma.orgSettings.update({ where: { id: 'singleton' }, data: { companyName: previousName } });
    });

    it('start membership IDs and contract numbers with the company initials', async () => {
      expect(referencePrefix('Kumasi Phone Credit')).toBe('KPC');
      expect(await generateMembershipId('MAIN')).toMatch(new RegExp(`^KPC-MAIN-${new Date().getFullYear()}-\\d{6}$`));
      expect(await generateContractNumber()).toMatch(new RegExp(`^KPC-CON-${new Date().getFullYear()}-\\d{6}$`));
    });
  });
});
