/**
 * Temporary unlock on a Device Financing phone: pay a share of what is
 * overdue, the phone opens for that tier's time, and it locks again unless
 * all that is overdue is paid.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, freshPhone, portalToken } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { createContract } from '@/lib/services/contractService';
import { postPayment, reversePayment } from '@/lib/services/paymentService';
import { handleUssdInput } from '@/lib/services/ussdService';
import { portalContracts } from '@/lib/services/customerPortalService';
import { payTriggerIdle } from '@/lib/paytrigger/notify';
import { setProductBrand } from '@/lib/paytrigger/admin';
import { clearPayTriggerSettingsCache, validatePayTriggerSettings } from '@/lib/paytrigger/settings';
import { getTemporaryUnlockOffer, requestTemporaryUnlock, temporaryUnlockUntil } from '@/lib/paytrigger/temporaryUnlock';
import { POST as appPOST } from '@/app/api/portal/temporary-unlock/route';
import { GET as staffGET, POST as staffPOST } from '@/app/api/contracts/[id]/temporary-unlock/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';

const runId = Date.now().toString().slice(-7) + Math.floor(Math.random() * 100);
let counter = 0;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const login = async (email: string) => (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!123' } }))).json()).token as string;
const settings = async (data: Record<string, unknown>) => { await prisma.payTriggerSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', ...data }, update: data }); clearPayTriggerSettingsCache(); };

beforeAll(async () => {
  await enableOptionalContractTypes();
  process.env.PAYTRIGGER_API_KEY = 'test-paytrigger-key-0000000000000';
  process.env.PAYTRIGGER_DRY_RUN = 'true';
  process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS = 'false';
  await settings({ temporaryUnlockEnabled: true, temporaryUnlockMaxUses: 2, lockScreenAppLink: false, lockOnUnpaidAgentDeposit: true });
});
afterAll(async () => {
  await settings({ temporaryUnlockEnabled: false, lockScreenAppLink: false });
  delete process.env.PAYTRIGGER_API_KEY;
  delete process.env.PAYTRIGGER_DRY_RUN;
  delete process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS;
});
afterEach(() => clearPayTriggerSettingsCache());

describe('Temporary unlock', () => {
  let branchId: string;
  let adminId: string;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
  });

  /** A switched-on phone, deposit paid, its first GHS 120 instalment 20 days overdue: locked. */
  async function lockedSale(opts: { createdById?: string } = {}) {
    const product = await prisma.product.create({ data: { sku: `TU-${runId}-${++counter}`, name: 'TECNO Spark 30', brand: 'TECNO', cashPriceMinor: 60000 } });
    await setProductBrand(product.id, 'TECNO', adminId);
    const createdById = opts.createdById ?? adminId;
    const imei = `36${runId.padStart(7, '0').slice(-7)}${String(++counter).padStart(6, '0')}`;
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: imei, assignedAgentId: opts.createdById ?? null } });
    const device = await prisma.payTriggerDevice.create({ data: { inventoryItemId: item.id, imei, enrollmentStatus: 'QUEUED' } });
    const phone = await freshPhone();
    const customer = await prisma.customer.create({ data: { membershipId: `TU-${runId}-${++counter}`, firstName: 'Abena', lastName: `Mensah${counter}`, phone, branchId, createdById } });
    const contract = await createContract({
      contractType: 'DEVICE_FINANCING', customerId: customer.id, inventoryItemId: item.id, branchId, createdById,
      totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 4, paymentFrequency: 'WEEKLY',
      startDate: new Date(Date.now() - 20 * DAY),
    });
    await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminId, collectedByAgentId: opts.createdById });
    await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { enrollmentStatus: 'ACTIVE', deviceTag: `TAG-${counter}`, contractId: contract.id } });
    await prisma.instalment.updateMany({ where: { contractId: contract.id, instalmentNo: { gt: 1 } }, data: { dueDate: new Date(Date.now() + 10 * DAY), status: 'PENDING' } });
    await prisma.instalment.updateMany({ where: { contractId: contract.id, instalmentNo: 1 }, data: { dueDate: new Date(Date.now() - 20 * DAY), status: 'OVERDUE' } });
    await payTriggerIdle();
    return { contract, customer, phone, device };
  }
  const buyInApp = async (s: Awaited<ReturnType<typeof lockedSale>>, percent: number) => {
    const res = await appPOST(makeRequest('POST', '/api/portal/temporary-unlock', { token: await portalToken(s.customer.id), body: { contractId: s.contract.id, percent, msisdn: s.phone, network: 'MTN' } }));
    await payTriggerIdle();
    return res;
  };
  const deviceOf = (id: string) => prisma.payTriggerDevice.findUniqueOrThrow({ where: { id } });

  describe('the offer', () => {
    it('is nothing while the feature is off, and nothing before the phone reaches its lock date', async () => {
      const s = await lockedSale();
      await settings({ temporaryUnlockEnabled: false });
      expect(await getTemporaryUnlockOffer(s.contract.id)).toBeNull();
      await settings({ temporaryUnlockEnabled: true });
      await prisma.instalment.updateMany({ where: { contractId: s.contract.id, instalmentNo: 1 }, data: { dueDate: new Date(Date.now() - 2 * DAY) } });
      expect(await getTemporaryUnlockOffer(s.contract.id)).toBeNull(); // still within the grace period
    });

    it('prices each tier from what is overdue, leaving late charges out', async () => {
      const s = await lockedSale();
      await prisma.penalty.create({ data: { contractId: s.contract.id, amountMinor: 5000, reason: 'LATE_PENALTY' } });
      const offer = await getTemporaryUnlockOffer(s.contract.id);
      expect(offer).toMatchObject({ available: true, overdueMinor: 12000, usesLeft: 2, activeUntil: null });
      expect(offer!.options.map((o) => [o.percent, o.amountMinor, o.period])).toEqual([[25, 3000, '1 day'], [50, 6000, '3 days'], [75, 9000, '5 days'], [90, 10800, '7 days']]);
      expect((await portalContracts(s.customer.id))[0].temporaryUnlock).toMatchObject({ available: true, overdueMinor: 12000 });
    });

    it('settings need 4 to 6 tiers, each paying more and opening longer, within the cap', () => {
      const tiers = [[25, 24], [50, 72], [75, 120], [90, 168]].map(([percent, hours]) => ({ percent, hours }));
      expect(validatePayTriggerSettings({ temporaryUnlockTiers: tiers })).toBeNull();
      expect(validatePayTriggerSettings({ temporaryUnlockTiers: tiers.slice(0, 3) })).toMatch(/between 4 and 6/);
      expect(validatePayTriggerSettings({ temporaryUnlockTiers: [...tiers.slice(0, 3), { percent: 90, hours: 72 }] })).toMatch(/open for longer/);
      expect(validatePayTriggerSettings({ temporaryUnlockTiers: [{ percent: 100, hours: 24 }, ...tiers.slice(1)] })).toMatch(/from 1 to 99/);
      expect(validatePayTriggerSettings({ temporaryUnlockTiers: tiers }, { maxUnlockHorizonDays: 5 })).toMatch(/from 1 to 120/);
    });
  });

  describe('buying a tier', () => {
    it('from the app: takes the share, opens the phone for the tier, and tells the customer when it locks', async () => {
      const s = await lockedSale();
      const res = await buyInApp(s, 25);
      expect(res.status).toBe(201);
      expect(await res.json()).toMatchObject({ amountMinor: 3000, period: '1 day' });

      const until = await temporaryUnlockUntil(s.contract.id);
      expect(Math.abs(until!.getTime() - (Date.now() + 24 * HOUR))).toBeLessThan(60_000);
      expect((await deviceOf(s.device.id)).providerExpiresAt).toEqual(until);
      expect((await prisma.instalment.findFirstOrThrow({ where: { contractId: s.contract.id, instalmentNo: 1 } })).amountPaidMinor).toBe(3000);
      const sms = await prisma.smsMessage.findFirstOrThrow({ where: { relatedContractId: s.contract.id, templateKey: 'paytrigger.temporary_unlock' } });
      expect(sms.body).toMatch(/your phone is open until .* Pay the remaining GHS 90.00 overdue/);

      const offer = await getTemporaryUnlockOffer(s.contract.id);
      expect(offer).toMatchObject({ overdueMinor: 9000, usesLeft: 1 });
      expect(offer!.activeUntil).toEqual(until);
    });

    it('from the short code, also for someone with a locked phone paying from another', async () => {
      const s = await lockedSale();
      const sessionId = `tu-${runId}-${++counter}`;
      const step = (input: string, isNewSession = false) => handleUssdInput({ sessionId, msisdn: s.phone, input, isNewSession });
      await step('', true);
      const choice = await step('1');
      expect(choice.message).toMatch(/Phone locked\. Overdue GHS120\.00\n1\. Open phone \(pay part\)\n2\. Pay any amount/);
      const tiers = await step('1');
      expect(tiers.message).toBe('Open phone:\n1. GHS30.00 - 1 day\n2. GHS60.00 - 3 days\n3. GHS90.00 - 5 days\n4. GHS108.00 - 7 days\n0. Back');
      const confirm = await step('2');
      expect(confirm.message).toMatch(/Pay GHS60\.00 to open phone for 3 days\?/);
      expect((await step('1')).continueSession).toBe(false);
      await payTriggerIdle();
      expect(Math.abs((await temporaryUnlockUntil(s.contract.id))!.getTime() - (Date.now() + 72 * HOUR))).toBeLessThan(60_000);
    });

    it('keeps the short code screens within what a network shows', async () => {
      const s = await lockedSale();
      await settings({ temporaryUnlockTiers: [[20, 12], [30, 24], [40, 48], [50, 72], [60, 96], [70, 120]].map(([percent, hours]) => ({ percent, hours })) });
      try {
        const sessionId = `tu-${runId}-${++counter}`;
        await handleUssdInput({ sessionId, msisdn: s.phone, input: '', isNewSession: true });
        await handleUssdInput({ sessionId, msisdn: s.phone, input: '1', isNewSession: false });
        const tiers = await handleUssdInput({ sessionId, msisdn: s.phone, input: '1', isNewSession: false });
        expect(tiers.message.split('\n')).toHaveLength(8);
        expect(tiers.message.length).toBeLessThanOrEqual(160);
      } finally {
        await settings({ temporaryUnlockTiers: [[25, 24], [50, 72], [75, 120], [90, 168]].map(([percent, hours]) => ({ percent, hours })) });
      }
    });

    it('leaves the short code as it was for anyone else: "Pay any amount" goes to the normal screen', async () => {
      const s = await lockedSale();
      const sessionId = `tu-${runId}-${++counter}`;
      await handleUssdInput({ sessionId, msisdn: s.phone, input: '', isNewSession: true });
      await handleUssdInput({ sessionId, msisdn: s.phone, input: '1', isNewSession: false });
      expect((await handleUssdInput({ sessionId, msisdn: s.phone, input: '2', isNewSession: false })).message).toMatch(/Enter amount to pay:/);
    });

    it('with cash at the office, but not through an agent', async () => {
      const s = await lockedSale();
      const params = makeParams({ id: s.contract.id });
      const cashier = await login('cashier@example.test');
      expect((await (await staffGET(makeRequest('GET', `/api/contracts/${s.contract.id}/temporary-unlock`, { token: cashier }), params)).json()).offer.available).toBe(true);
      expect((await staffPOST(makeRequest('POST', `/api/contracts/${s.contract.id}/temporary-unlock`, { token: await login('agent@example.test'), body: { percent: 25 } }), params)).status).toBe(403);

      const res = await staffPOST(makeRequest('POST', `/api/contracts/${s.contract.id}/temporary-unlock`, { token: cashier, body: { percent: 50 } }), params);
      expect(res.status).toBe(201);
      await payTriggerIdle();
      expect((await res.json()).payment).toMatchObject({ amountMinor: 6000, channel: 'CASH' });
      expect(await temporaryUnlockUntil(s.contract.id)).not.toBeNull();
    });

    it('opens nothing until the money has come in', async () => {
      const s = await lockedSale();
      await requestTemporaryUnlock({ contractId: s.contract.id, percent: 25, channel: 'APP' });
      expect(await temporaryUnlockUntil(s.contract.id)).toBeNull();
      expect((await getTemporaryUnlockOffer(s.contract.id))!.usesLeft).toBe(2);
    });
  });

  describe('its limits', () => {
    it('stops at the set number of uses, then only the full overdue amount opens the phone', async () => {
      const s = await lockedSale();
      expect((await buyInApp(s, 25)).status).toBe(201);
      expect((await buyInApp(s, 25)).status).toBe(201);
      const offer = await getTemporaryUnlockOffer(s.contract.id);
      expect(offer).toMatchObject({ available: false, usesLeft: 0, overdueMinor: 6750 });
      expect(offer!.message).toMatch(/Pay the full overdue amount of GHS 67\.50/);
      const refused = await buyInApp(s, 25);
      expect(refused.status).toBe(400);
    });

    it('keeps counting uses while the customer is behind, and starts afresh only once nothing was overdue', async () => {
      const s = await lockedSale();
      const inst = await prisma.instalment.findMany({ where: { contractId: s.contract.id }, orderBy: { instalmentNo: 'asc' } });
      await prisma.instalment.update({ where: { id: inst[1].id }, data: { dueDate: new Date(Date.now() - 10 * DAY), status: 'OVERDUE' } });
      expect((await buyInApp(s, 25)).status).toBe(201);
      await prisma.payTriggerTemporaryUnlock.updateMany({ where: { contractId: s.contract.id }, data: { activatedAt: new Date(Date.now() - 12 * DAY), expiresAt: new Date(Date.now() - 11 * DAY) } });
      expect(await getTemporaryUnlockOffer(s.contract.id)).toMatchObject({ usesLeft: 1 });

      // The oldest instalment is cleared, but the next is still overdue: the use still counts.
      const first = await prisma.instalment.findUniqueOrThrow({ where: { id: inst[0].id } });
      await postPayment({ contractId: s.contract.id, amountMinor: first.amountDueMinor - first.amountPaidMinor, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminId });
      await payTriggerIdle();
      expect(await getTemporaryUnlockOffer(s.contract.id)).toMatchObject({ overdueMinor: 12000, usesLeft: 1 });

      // Everything paid five days ago, and a later instalment overdue since: a new stretch of arrears.
      await postPayment({ contractId: s.contract.id, amountMinor: 12000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminId });
      await payTriggerIdle();
      await prisma.instalment.updateMany({ where: { id: { in: [inst[0].id, inst[1].id] } }, data: { paidAt: new Date(Date.now() - 5 * DAY) } });
      await prisma.contract.update({ where: { id: s.contract.id }, data: { gracePeriodDays: 0 } });
      await prisma.instalment.update({ where: { id: inst[2].id }, data: { dueDate: new Date(Date.now() - 3 * DAY), status: 'OVERDUE' } });
      expect(await getTemporaryUnlockOffer(s.contract.id)).toMatchObject({ usesLeft: 2 });
    });

    it('lengthens a window already running, never shortens it', async () => {
      const s = await lockedSale();
      await buyInApp(s, 75); // 5 days
      const first = await temporaryUnlockUntil(s.contract.id);
      await buyInApp(s, 25); // 1 day
      expect(await temporaryUnlockUntil(s.contract.id)).toEqual(first);
    });

    it('a reversed payment takes its unlock with it, and gives the use back', async () => {
      const s = await lockedSale();
      await buyInApp(s, 25);
      const unlock = await prisma.payTriggerTemporaryUnlock.findFirstOrThrow({ where: { contractId: s.contract.id, status: 'APPLIED' } });
      await reversePayment({ paymentId: unlock.paymentId!, reason: 'Bounced', reversedById: adminId });
      await payTriggerIdle();
      expect(await temporaryUnlockUntil(s.contract.id)).toBeNull();
      expect((await getTemporaryUnlockOffer(s.contract.id))!.usesLeft).toBe(2);
    });

    it('paying all that is overdue ends the offer: the phone is back on its schedule', async () => {
      const s = await lockedSale();
      await buyInApp(s, 25);
      await postPayment({ contractId: s.contract.id, amountMinor: 9000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminId });
      await payTriggerIdle();
      expect(await getTemporaryUnlockOffer(s.contract.id)).toBeNull();
    });

    it('works on a defaulted contract', async () => {
      const s = await lockedSale();
      await prisma.contract.update({ where: { id: s.contract.id }, data: { status: 'DEFAULTED' } });
      expect((await getTemporaryUnlockOffer(s.contract.id))!.available).toBe(true);
      await buyInApp(s, 25);
      const until = await temporaryUnlockUntil(s.contract.id);
      expect((await deviceOf(s.device.id)).providerExpiresAt).toEqual(until);
    });

    it('is closed while an agent has not remitted the deposit: paying could not open the phone', async () => {
      const role = await prisma.role.findUniqueOrThrow({ where: { name: 'AGENT' } });
      const agent = await prisma.user.create({ data: { email: `tu-agent-${runId}-${++counter}@example.test`, passwordHash: 'x', firstName: 'Ama', lastName: 'Field', roleId: role.id, branchId } });
      const s = await lockedSale({ createdById: agent.id });
      const offer = await getTemporaryUnlockOffer(s.contract.id);
      expect(offer).toMatchObject({ available: false });
      expect(offer!.message).toMatch(/held until your agent/);
    });
  });

  it('the lock screen button links to the app only once that is switched on', async () => {
    const s = await lockedSale();
    await settings({ lockScreenAppLink: true });
    try {
      await buyInApp(s, 25);
      const command = await prisma.payTriggerCommand.findFirstOrThrow({ where: { deviceId: s.device.id, type: 'EXTEND' }, orderBy: { createdAt: 'desc' } });
      expect(command.payload).toMatchObject({ deeplink: `flezepay://open-phone?contract=${s.contract.id}`, deeplinkPkg: 'com.flezepay.customer' });
    } finally {
      await settings({ lockScreenAppLink: false });
    }
  });
});
