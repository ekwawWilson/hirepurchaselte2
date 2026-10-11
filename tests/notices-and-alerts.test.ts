/**
 * What the system says without being asked: the notice a customer gets the
 * day before a direct debit, the owner's evening summary, alerts when
 * something breaks, and the dashboard's list of what is waiting on a person.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeRequest, makeParams, freshPhone, withLiveHubtel, hubtelHttp, enableOptionalContractTypes } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as attentionGET } from '@/app/api/attention/route';
import { POST as acknowledgePOST } from '@/app/api/alerts/[id]/acknowledge/route';
import { GET as controlsGET, PATCH as controlsPATCH } from '@/app/api/settings/controls/route';
import { createContract } from '@/lib/services/contractService';
import { postPayment } from '@/lib/services/paymentService';
import { initiatePreapproval, enableDirectDebit, processDirectDebitCallback } from '@/lib/services/hubtelPreapprovalService';
import { initiateHubtelPayment } from '@/lib/services/hubtelPaymentService';
import { runDirectDebitCollections } from '@/lib/services/collectionsService';
import { sendDirectDebitNotices, sendOwnerDailySummary, ownerDailySummary } from '@/lib/services/dailyNoticesService';
import { raiseAlert } from '@/lib/services/alertService';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
const DAY = 24 * 3_600_000;

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!123' } }));
  return (await res.json()).token as string;
}

const DEFAULT_CONTROLS = {
  requireSecondApproval: false, ownerPhone: null as string | null, dailySummaryEnabled: true, directDebitNoticeEnabled: true, partialDirectDebitEnabled: true,
};
const setControls = (data: Partial<typeof DEFAULT_CONTROLS>) =>
  prisma.controlSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...DEFAULT_CONTROLS, ...data }, update: data });

beforeAll(enableOptionalContractTypes);
afterAll(() => setControls(DEFAULT_CONTROLS));

describe('Notices, summaries and alerts', () => {
  let branchId: string;
  let adminUserId: string;
  let admin: string;
  let cashier: string;
  let previousDays: { worksSaturday: boolean; worksSunday: boolean } | null = null;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
    admin = await login('admin@example.test');
    cashier = await login('cashier@example.test');
    await setControls(DEFAULT_CONTROLS);
    // The collections run does nothing on a closed day; open every day so
    // these tests mean the same whichever day of the week they run on.
    previousDays = await prisma.operatingSettings.findUnique({ where: { id: 'singleton' }, select: { worksSaturday: true, worksSunday: true } });
    await prisma.operatingSettings.upsert({
      where: { id: 'singleton' }, create: { id: 'singleton', worksSaturday: true, worksSunday: true }, update: { worksSaturday: true, worksSunday: true },
    });
  });
  afterAll(async () => {
    await prisma.operatingSettings.update({ where: { id: 'singleton' }, data: previousDays ?? { worksSaturday: false, worksSunday: false } });
  });

  /** Six weekly instalments of GHS 100 on direct debit, mandate approved; instalment 1 due `firstDueInDays` from now. */
  async function debitContract(firstDueInDays: number, paymentMethod: 'DIRECT_DEBIT' | 'CUSTOMER_INITIATED' = 'DIRECT_DEBIT') {
    counter += 1;
    const msisdn = await freshPhone('024');
    const product = await prisma.product.create({ data: { sku: `NTC-${runId}-${counter}`, name: 'Notice Phone', cashPriceMinor: 100000 } });
    const customer = await prisma.customer.create({
      data: { membershipId: `NTC-${runId}-${counter}`, firstName: 'Notice', lastName: `Debit${counter}`, phone: msisdn, branchId, createdById: adminUserId },
    });
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `NTC-SN-${runId}-${counter}` } });
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item.id,
      totalPayableMinor: 60000, depositAmountMinor: 0, termWeeks: 6, paymentFrequency: 'WEEKLY', branchId, createdById: adminUserId,
    });
    await postPayment({ contractId: contract.id, amountMinor: 1, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });
    if (paymentMethod === 'DIRECT_DEBIT') {
      const { preapproval } = await initiatePreapproval({ customerId: customer.id, msisdn, network: 'MTN', createdById: adminUserId });
      await enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId, paymentMethod: 'DIRECT_DEBIT' });
    }
    await prisma.instalment.updateMany({
      where: { contractId: contract.id, instalmentNo: 1 },
      data: { dueDate: new Date(new Date().setHours(12, 0, 0, 0) + firstDueInDays * DAY) },
    });
    return { contract, customer, msisdn };
  }
  const notices = (contractId: string) => prisma.smsMessage.findMany({ where: { relatedContractId: contractId, templateKey: 'directdebit.notice' } });

  describe('the day-before direct debit notice', () => {
    it('tells a customer whose wallet will be debited tomorrow, once, with the amount', async () => {
      const tomorrow = await debitContract(1);
      const nextWeek = await debitContract(5);
      const paysThemselves = await debitContract(1, 'CUSTOMER_INITIATED');

      const run = await sendDirectDebitNotices();
      expect(run.sent).toBeGreaterThanOrEqual(1);

      const sent = await notices(tomorrow.contract.id);
      expect(sent).toHaveLength(1);
      expect(sent[0].recipient).toBe(tomorrow.msisdn);
      expect(sent[0].body).toContain('GHS 100.00 will be deducted from your mobile money wallet tomorrow');
      expect(sent[0].body).toContain(tomorrow.contract.contractNumber);
      expect(await notices(nextWeek.contract.id)).toHaveLength(0);       // not for days yet
      expect(await notices(paysThemselves.contract.id)).toHaveLength(0); // nothing will be debited

      await sendDirectDebitNotices(); // a second run, or a restart, sends nothing more
      expect(await notices(tomorrow.contract.id)).toHaveLength(1);
    });

    it('can be switched off', async () => {
      const { contract } = await debitContract(1);
      await setControls({ directDebitNoticeEnabled: false });
      try {
        expect(await sendDirectDebitNotices()).toEqual({ sent: 0, skipped: true });
        expect(await notices(contract.id)).toHaveLength(0);
      } finally {
        await setControls({ directDebitNoticeEnabled: true });
      }
    });
  });

  describe('one direct debit attempt at a time', () => {
    it('the daily run leaves alone a contract whose last attempt is unanswered or has a retry scheduled, and resumes once neither is true', async () => {
      const { contract, msisdn } = await debitContract(-1); // instalment 1 fell due yesterday
      const paid = async () => (await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).totalPaidMinor;
      const mandate = (await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).hubtelPreapprovalId!;

      const clientReference = `NTC-INFLIGHT-${runId}`;
      const inFlight = await prisma.hubtelTransaction.create({
        data: { clientReference, contractId: contract.id, msisdn, amountMinor: 10000, status: 'PENDING', channel: 'DIRECT_DEBIT', preapprovalId: mandate },
      });
      await runDirectDebitCollections();
      expect(await paid()).toBe(1); // still waiting on the first attempt

      await processDirectDebitCallback({ clientReference, status: 'FAILED', rawPayload: '{}' });
      await runDirectDebitCollections();
      expect(await paid()).toBe(1); // its retry is the attempt in hand

      await prisma.hubtelTransaction.update({ where: { id: inFlight.id }, data: { nextRetryAt: null } });
      await runDirectDebitCollections();
      expect(await paid()).toBe(1 + 10000);
    });
  });

  describe("the owner's daily summary", () => {
    it('goes nowhere until an owner number is set, then once a day with the day\'s figures', async () => {
      await prisma.smsMessage.deleteMany({ where: { templateKey: 'owner.daily_summary', createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } } });
      expect(await sendOwnerDailySummary()).toBe(false);

      const ownerPhone = await freshPhone('055');
      await setControls({ ownerPhone });
      try {
        const { contract } = await debitContract(3);
        await postPayment({ contractId: contract.id, amountMinor: 4200, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
        const figures = await ownerDailySummary();
        expect(figures.collectedMinor).toBeGreaterThanOrEqual(4200);
        expect(figures.payments).toBeGreaterThanOrEqual(1);
        expect(figures.newContracts).toBeGreaterThanOrEqual(1);

        expect(await sendOwnerDailySummary()).toBe(true);
        const sms = await prisma.smsMessage.findFirstOrThrow({ where: { templateKey: 'owner.daily_summary', recipient: ownerPhone } });
        expect(sms.body).toMatch(/collected GHS [\d,]+\.\d\d in \d+ payments?\. New contracts: \d+\. Overdue: GHS [\d,]+\.\d\d on \d+ contracts?\./);
        expect(sms.status).toBe('SENT');

        expect(await sendOwnerDailySummary()).toBe(false); // already sent today

        await prisma.smsMessage.deleteMany({ where: { templateKey: 'owner.daily_summary', recipient: ownerPhone } });
        await setControls({ dailySummaryEnabled: false });
        expect(await sendOwnerDailySummary()).toBe(false); // switched off
      } finally {
        await setControls({ ownerPhone: null, dailySummaryEnabled: true });
      }
    });
  });

  describe('alerts', () => {
    const attention = async (token: string) => (await (await attentionGET(makeRequest('GET', '/api/attention', { token }))).json());
    const acknowledge = (token: string, id: string) =>
      acknowledgePOST(makeRequest('POST', `/api/alerts/${id}/acknowledge`, { token }), makeParams({ id }));

    it('a fault that keeps happening is one alert that counts; it texts the owner once, clears when acknowledged and opens again if it comes back', async () => {
      const ownerPhone = await freshPhone('055');
      await setControls({ ownerPhone });
      try {
        const dedupeKey = `job-failed:test-${runId}`;
        const fault = { kind: 'JOB_FAILED', message: `The scheduled job "test ${runId}" failed: boom`, dedupeKey };
        await raiseAlert(fault);
        await raiseAlert(fault);
        await raiseAlert(fault);

        const open = (await attention(admin)).alerts.filter((a: { dedupeKey: string }) => a.dedupeKey === dedupeKey);
        expect(open).toHaveLength(1);
        expect(open[0]).toMatchObject({ kind: 'JOB_FAILED', occurrences: 3 });
        const texts = () => prisma.smsMessage.count({ where: { templateKey: 'owner.alert', recipient: ownerPhone } });
        expect(await texts()).toBe(1);

        // Alerts are the administrators' to see and clear.
        expect((await attention(cashier)).alerts).toEqual([]);
        expect((await acknowledge(cashier, open[0].id)).status).toBe(403);
        expect((await acknowledge(admin, open[0].id)).status).toBe(200);
        expect((await attention(admin)).alerts.find((a: { dedupeKey: string }) => a.dedupeKey === dedupeKey)).toBeUndefined();

        await raiseAlert(fault); // still broken
        const reopened = (await attention(admin)).alerts.find((a: { dedupeKey: string }) => a.dedupeKey === dedupeKey);
        expect(reopened).toMatchObject({ occurrences: 1 });
        expect(await texts()).toBe(2);
        await acknowledge(admin, reopened.id);
      } finally {
        await setControls({ ownerPhone: null });
      }
    });

    it('Hubtel turning this server away raises an alert instead of only failing the payment', async () => {
      await prisma.systemAlert.deleteMany({ where: { dedupeKey: 'hubtel-refused:403' } });
      const customer = await prisma.customer.create({
        data: { membershipId: `NTC-H-${runId}`, firstName: 'Refused', lastName: 'ByHubtel', phone: await freshPhone('024'), branchId, createdById: adminUserId },
      });
      const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId: customer.id, branchId, createdById: adminUserId });

      await withLiveHubtel(() => hubtelHttp(403, '<html>403 Forbidden</html>'), async () => {
        await expect(initiateHubtelPayment({ contractId: contract.id, msisdn: customer.phone!, amountMinor: 5000, network: 'MTN' })).rejects.toThrow();
      });

      // Raised without holding the payment up, so give it a moment to land.
      let alert = null;
      for (let i = 0; i < 40 && !alert; i++) {
        alert = await prisma.systemAlert.findUnique({ where: { dedupeKey: 'hubtel-refused:403' } });
        if (!alert) await new Promise((r) => setTimeout(r, 50));
      }
      expect(alert).toMatchObject({ kind: 'HUBTEL_REFUSED', acknowledgedAt: null });
      expect(alert!.message).toMatch(/whitelists the server's IP address/);
      await prisma.systemAlert.update({ where: { id: alert!.id }, data: { acknowledgedAt: new Date() } });
    });

    it('the dashboard feed counts what is waiting, for those who can act on it', async () => {
      const before = await attention(admin);
      const customer = await prisma.customer.create({
        data: { membershipId: `NTC-A-${runId}`, firstName: 'Waiting', lastName: 'Items', phone: await freshPhone('024'), branchId, createdById: adminUserId },
      });
      const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId: customer.id, branchId, createdById: adminUserId });
      await prisma.hubtelTransaction.create({ data: { clientReference: `NTC-NR-${runId}`, contractId: contract.id, msisdn: customer.phone!, amountMinor: 900, status: 'NEEDS_REVIEW' } });
      await prisma.contract.update({ where: { id: contract.id }, data: { status: 'CANCELLED', cancelledAt: new Date(), refundDueMinor: 3300 } });

      const after = await attention(admin);
      expect(after.paymentsToReview).toBe(before.paymentsToReview + 1);
      expect(after.refundsOwed).toBe(before.refundsOwed + 1);
      expect(after.refundsOwedMinor).toBe(before.refundsOwedMinor + 3300);
      expect(after.smsNotSending).toBe(true); // the test environment has no SMS provider, and says so

      // A sales rep can do nothing about payments or refunds, so is told nothing about them.
      const sales = await attention(await login('sales@example.test'));
      expect(sales).toMatchObject({ paymentsToReview: 0, refundsOwed: 0, approvalsWaiting: 0, alerts: [], smsNotSending: false });
    });
  });

  describe('the controls themselves', () => {
    const patch = (token: string, body: Record<string, unknown>) => controlsPATCH(makeRequest('PATCH', '/api/settings/controls', { token, body }));
    const full = { requireSecondApproval: false, dailySummaryEnabled: true, directDebitNoticeEnabled: true, partialDirectDebitEnabled: true, ownerPhone: '' };

    it('are the administrators\' to change, check what they are given, and confirm a new owner number by texting it', async () => {
      expect((await controlsGET(makeRequest('GET', '/api/settings/controls', { token: cashier }))).status).toBe(403);
      expect((await patch(cashier, full)).status).toBe(403);
      expect((await patch(admin, { ...full, requireSecondApproval: 'yes' })).status).toBe(400);
      expect((await patch(admin, { ...full, ownerPhone: '12345' })).status).toBe(400);

      const ownerPhone = await freshPhone('020');
      try {
        const saved = await patch(admin, { ...full, ownerPhone: `+233 ${ownerPhone.slice(1)}`, partialDirectDebitEnabled: false });
        expect(saved.status).toBe(200);
        expect((await saved.json()).settings).toMatchObject({ ownerPhone, partialDirectDebitEnabled: false, requireSecondApproval: false });
        expect(await prisma.smsMessage.count({ where: { templateKey: 'owner.alert', recipient: ownerPhone } })).toBe(1);

        // Saving again without changing the number does not text it again.
        await patch(admin, { ...full, ownerPhone });
        expect(await prisma.smsMessage.count({ where: { templateKey: 'owner.alert', recipient: ownerPhone } })).toBe(1);
        const read = await (await controlsGET(makeRequest('GET', '/api/settings/controls', { token: admin }))).json();
        expect(read.settings).toMatchObject({ ownerPhone, partialDirectDebitEnabled: true });
      } finally {
        await setControls(DEFAULT_CONTROLS);
      }
    });
  });
});
