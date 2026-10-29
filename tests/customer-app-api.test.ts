/**
 * What the customer mobile app needs from the portal API beyond what the web
 * portal already used: resetting a forgotten password by SMS code, and what
 * is owed on each contract (src/lib/services/passwordResetService.ts,
 * customerPortalService.dueSummary).
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, freshPhone, portalToken } from './helpers';
import { prisma } from '@/lib/db/prisma';

// The SMS as the provider would receive it: the only place a code exists in the clear.
const sent: Array<{ recipient: string; body: string }> = [];
vi.mock('@/lib/services/smsService', async (original) => ({
  ...(await original<typeof import('@/lib/services/smsService')>()),
  deliverQueuedSms: async (id: string) => {
    const sms = await prisma.smsMessage.findUniqueOrThrow({ where: { id } });
    sent.push({ recipient: sms.recipient, body: sms.body });
  },
}));

import { createContract } from '@/lib/services/contractService';
import { issuePortalPassword } from '@/lib/services/customerPortalService';
import { postPayment } from '@/lib/services/paymentService';
import { POST as requestPOST } from '@/app/api/portal/auth/password-reset/request/route';
import { POST as resetPOST } from '@/app/api/portal/auth/password-reset/reset/route';
import { POST as portalLoginPOST } from '@/app/api/portal/auth/login/route';
import { GET as portalContractsGET } from '@/app/api/portal/contracts/route';
import { GET as portalContractGET } from '@/app/api/portal/contracts/[id]/route';

const runId = Date.now().toString().slice(-7) + Math.floor(Math.random() * 100);
let counter = 0;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(enableOptionalContractTypes);

describe('Customer app API', () => {
  let branchId: string;
  let adminId: string;
  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
  });

  async function customer() {
    const c = await prisma.customer.create({ data: { membershipId: `APP-${runId}-${++counter}`, firstName: 'Efua', lastName: `Owusu${counter}`, phone: await freshPhone('024'), branchId, createdById: adminId } });
    await issuePortalPassword(c.id);
    return c;
  }
  const request = async (phone: string) => (await requestPOST(makeRequest('POST', '/api/portal/auth/password-reset/request', { body: { phone } }))).json();
  const reset = (body: Record<string, string>) => resetPOST(makeRequest('POST', '/api/portal/auth/password-reset/reset', { body }));
  const lastCode = () => /^(\d{6}) /.exec(sent[sent.length - 1].body)![1];

  describe('resetting a forgotten password', () => {
    it('texts a code to a registered number, and says the same for one nobody has', async () => {
      const c = await customer();
      const before = sent.length;
      const known = await request(c.phone!);
      const unknown = await request(await freshPhone('024'));
      expect(known).toEqual(unknown);
      expect(sent.length).toBe(before + 1);
      expect(sent[sent.length - 1]).toMatchObject({ recipient: c.phone, body: expect.stringMatching(/^\d{6} is your .+ password reset code/) });
      // Staff reading the SMS history never see the code.
      const kept = await prisma.smsMessage.findFirstOrThrow({ where: { relatedCustomerId: c.id, templateKey: 'customer.password_reset' } });
      expect(kept.body).toMatch(/^\*{6} is your/);
    });

    it('sets a new password with the code, once; a wrong code is refused without saying why', async () => {
      const c = await customer();
      await request(c.phone!);
      const code = lastCode();
      const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
      const refused = await reset({ phone: c.phone!, code: wrong, newPassword: 'brand-new-pass' });
      expect(refused.status).toBe(400);
      expect((await refused.json()).error).toMatch(/not correct or has expired/);

      expect((await reset({ phone: c.phone!, code, newPassword: c.phone! })).status).toBe(400); // not the phone number
      const ok = await reset({ phone: c.phone!, code, newPassword: 'brand-new-pass' });
      expect(ok.status).toBe(200);
      expect((await reset({ phone: c.phone!, code, newPassword: 'another-pass' })).status).toBe(400); // used once

      const login = await portalLoginPOST(makeRequest('POST', '/api/portal/auth/login', { body: { phone: c.phone, password: 'brand-new-pass' } }));
      expect(login.status).toBe(200);
      expect((await login.json()).customer.mustChangePassword).toBe(false);
    });

    it('a code stops working after five wrong tries, and at most three are sent an hour', async () => {
      const c = await customer();
      await request(c.phone!);
      const code = lastCode();
      const reset5 = await prisma.customerPasswordReset.findFirstOrThrow({ where: { customerId: c.id, usedAt: null } });
      await prisma.customerPasswordReset.update({ where: { id: reset5.id }, data: { attempts: 5 } });
      expect((await reset({ phone: c.phone!, code, newPassword: 'brand-new-pass' })).status).toBe(400);

      const before = sent.length;
      await request(c.phone!);
      await request(c.phone!);
      await request(c.phone!);
      expect(sent.length).toBe(before + 2); // three in the hour, counting the first
    });
  });

  describe('what is owed on each contract', () => {
    it('the list and the contract give the total due (late charges included), what is overdue and what is next', async () => {
      const c = await customer();
      const product = await prisma.product.create({ data: { sku: `APP-${runId}-${++counter}`, name: 'Samsung A16', cashPriceMinor: 60000 } });
      const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `APP-SN-${runId}-${counter}` } });
      // Started three weeks ago: instalments 1-3 are already due.
      const contract = await createContract({
        contractType: 'DEPOSIT_INSTALMENT', customerId: c.id, inventoryItemId: item.id, branchId, createdById: adminId,
        totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY', startDate: new Date(Date.now() - 21 * DAY - 3600_000),
      });
      await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminId });
      const first = await prisma.instalment.findFirstOrThrow({ where: { contractId: contract.id, instalmentNo: 1 } });
      await prisma.penalty.create({ data: { contractId: contract.id, instalmentId: first.id, amountMinor: 500, reason: 'LATE_PENALTY', appliedDate: new Date() } });

      const token = await portalToken(c.id);
      const list = await (await portalContractsGET(makeRequest('GET', '/api/portal/contracts', { token }))).json();
      const listed = list.contracts.find((x: { id: string }) => x.id === contract.id);
      const detail = (await (await portalContractGET(makeRequest('GET', `/api/portal/contracts/${contract.id}`, { token }), makeParams({ id: contract.id }))).json()).contract;
      // Due dates skip non-working days, so what is overdue is read from the
      // schedule itself: marked OVERDUE (which happens on the due day), or due before today.
      const today = new Date();
      today.setUTCHours(0, 0, 0, 0);
      const schedule = await prisma.instalment.findMany({ where: { contractId: contract.id }, orderBy: { instalmentNo: 'asc' } });
      const overdue = schedule.filter((i) => i.status === 'OVERDUE' || i.dueDate < today);
      expect(overdue.length).toBeGreaterThanOrEqual(2);
      for (const due of [listed.due, detail.due]) {
        expect(due).toMatchObject({
          totalDueMinor: 48000 + 500, penaltyOutstandingMinor: 500, overdueMinor: overdue.length * 4000, overdueCount: overdue.length, nextDueMinor: 4000, unpaidCount: 12,
        });
        expect(new Date(due.nextDueDate)).toEqual(schedule[overdue.length].dueDate);
      }
    });

    it('open-ended savings has no total due', async () => {
      const c = await customer();
      const savings = await createContract({ contractType: 'SAVE_TO_OWN', customerId: c.id, branchId, createdById: adminId });
      const token = await portalToken(c.id);
      const list = await (await portalContractsGET(makeRequest('GET', '/api/portal/contracts', { token }))).json();
      expect(list.contracts.find((x: { id: string }) => x.id === savings.id).due).toMatchObject({ totalDueMinor: null, overdueCount: 0 });
    });
  });
});
