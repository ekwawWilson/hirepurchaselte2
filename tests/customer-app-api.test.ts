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
  describe('signing in', () => {
    it('a new customer signs in with their phone number as username and password, straight in', async () => {
      const c = await customer();
      const login = await portalLoginPOST(makeRequest('POST', '/api/portal/auth/login', { body: { phone: c.phone, password: c.phone } }));
      expect(login.status).toBe(200);
      expect((await login.json()).customer.mustChangePassword).toBe(false);
    });

    it('no reset code is texted: both reset steps say to ask at the shop, and send nothing', async () => {
      const c = await customer();
      const before = sent.length;
      for (const res of [
        await requestPOST(),
        await resetPOST(),
      ]) {
        expect(res.status).toBe(410);
        expect((await res.json()).error).toMatch(/ask at the shop/i);
      }
      expect(sent.length).toBe(before);
      expect(await prisma.customerPasswordReset.count({ where: { customerId: c.id } })).toBe(0);
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
