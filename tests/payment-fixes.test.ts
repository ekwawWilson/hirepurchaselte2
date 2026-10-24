/**
 * How money comes in: what a payment beyond the deposit is applied to, what
 * may be paid at all, and protection against paying or recording twice —
 * plus the USSD screens that fit and what customers can print for themselves.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, freshPhone, portalToken } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as cashPOST } from '@/app/api/payments/cash/route';
import { POST as portalPayPOST } from '@/app/api/portal/pay/route';
import { GET as portalContractGET } from '@/app/api/portal/contracts/[id]/route';
import { createContract } from '@/lib/services/contractService';
import { postPayment, amountOwedNow } from '@/lib/services/paymentService';
import { processHubtelCallback } from '@/lib/services/hubtelPaymentService';
import { handleUssdInput, USSD_SCREEN_LIMIT } from '@/lib/services/ussdService';
import { parseCedis } from '@/lib/services/paymentLimitsService';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
const unique = () => `${runId}${++counter}`;
const DAY = 86_400_000;

/** Dial in and choose 1, Self payment: what follows is the caller's own account. */
async function dialSelf(sessionId: string, msisdn: string) {
  await handleUssdInput({ sessionId, msisdn, input: '', isNewSession: true });
  return handleUssdInput({ sessionId, msisdn, input: '1', isNewSession: false });
}

beforeAll(enableOptionalContractTypes);

describe('Payments', () => {
  let branchId: string;
  let adminId: string;
  let cashier: string;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
    cashier = (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email: 'cashier@example.test', password: 'Passw0rd!123' } }))).json()).token;
  });

  async function customer(names: { firstName?: string; lastName?: string } = {}) {
    return prisma.customer.create({
      data: { membershipId: `PF-${unique()}`, firstName: names.firstName ?? 'Akua', lastName: names.lastName ?? `Payer${counter}`, phone: await freshPhone(), branchId, createdById: adminId },
    });
  }
  /** GHS 600 phone, GHS 120 deposit still owed, twelve weekly GHS 40 instalments — the first two already due. */
  async function awaitingDeposit(customerId?: string, productName = 'Tecno Spark 20') {
    const product = await prisma.product.create({ data: { sku: `PF-${unique()}`, name: productName, cashPriceMinor: 60000 } });
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `PF-SN-${unique()}` } });
    return createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: customerId ?? (await customer()).id, inventoryItemId: item.id, branchId, createdById: adminId,
      totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY', startDate: new Date(Date.now() - 15 * DAY),
    });
  }
  const instalments = async (contractId: string) =>
    (await prisma.instalment.findMany({ where: { contractId }, orderBy: { instalmentNo: 'asc' }, take: 3 })).map((i) => [i.amountPaidMinor, i.status]);

  describe('money paid beyond the deposit', () => {
    it('goes onto the instalments, by mobile money or cash, however the payment was labelled', async () => {
      const momo = await awaitingDeposit();
      const ref = `PF${unique()}`;
      await prisma.hubtelTransaction.create({ data: { clientReference: ref, contractId: momo.id, msisdn: '0240000000', amountMinor: 20000, status: 'PENDING' } });
      await processHubtelCallback({ clientReference: ref, status: 'SUCCESS', rawPayload: '{}' });
      expect(await prisma.contract.findUniqueOrThrow({ where: { id: momo.id } })).toMatchObject({ status: 'ACTIVE', totalPaidMinor: 20000, balanceMinor: 40000 });
      expect(await instalments(momo.id)).toEqual([[4000, 'PAID'], [4000, 'PAID'], [0, 'PENDING']]);

      const cash = await awaitingDeposit();
      await postPayment({ contractId: cash.id, amountMinor: 14000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminId });
      expect(await instalments(cash.id)).toEqual([[2000, 'OVERDUE'], [0, 'OVERDUE'], [0, 'PENDING']]);

      // Labelled an instalment while the deposit is owed: the deposit is still paid first.
      const mislabelled = await awaitingDeposit();
      const { payment } = await postPayment({ contractId: mislabelled.id, amountMinor: 16000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminId });
      expect(payment.entryType).toBe('DEPOSIT');
      expect(await prisma.contract.findUniqueOrThrow({ where: { id: mislabelled.id } })).toMatchObject({ status: 'ACTIVE', balanceMinor: 44000 });
      expect(await instalments(mislabelled.id)).toEqual([[4000, 'PAID'], [0, 'OVERDUE'], [0, 'PENDING']]);
    });

    it('a customer paying the whole price at once is completed then and there', async () => {
      const whole = await awaitingDeposit();
      await postPayment({ contractId: whole.id, amountMinor: 60000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminId });
      expect(await prisma.contract.findUniqueOrThrow({ where: { id: whole.id } })).toMatchObject({ status: 'COMPLETED', balanceMinor: 0 });
    });

    it('every payment gets a receipt number, mobile money included', async () => {
      const c = await awaitingDeposit();
      const { payment } = await postPayment({ contractId: c.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'USSD' });
      expect(payment.receiptNumber).toMatch(/\w/);
    });
  });

  describe('what may be paid', () => {
    it('reads amounts strictly', () => {
      expect(parseCedis('50')).toBe(5000);
      expect(parseCedis(' 50.5 ')).toBe(5050);
      for (const bad of ['50abc', '1e6', '0.001', '-5', '5,000', '']) expect(parseCedis(bad), bad).toBeNull();
    });

    it('USSD asks again for a nonsense, tiny or larger-than-owed amount, and takes a good one', async () => {
      const c = await awaitingDeposit();
      const cust = await prisma.customer.findUniqueOrThrow({ where: { id: c.customerId } });
      const sid = `pf-${unique()}`;
      await dialSelf(sid, cust.phone!);
      const ask = (input: string) => handleUssdInput({ sessionId: sid, msisdn: cust.phone!, input, isNewSession: false });

      expect((await ask('50abc')).message).toBe('Enter the amount in cedis, e.g. 50 or 50.50:');
      expect((await ask('0.50')).message).toMatch(/^The smallest payment is GHS 1\.00\./);
      const tooMuch = await ask('1000000');
      expect(tooMuch).toMatchObject({ continueSession: true });
      expect(tooMuch.message).toMatch(/^That is more than is owed\. Pay at most GHS 600\.00\./);
      expect((await ask('50')).message).toBe('Confirm payment of GHS50.00?\n1. Confirm\n2. Cancel');
    });

    it('what is owed includes late-payment charges, so the last of it can always be paid', async () => {
      const c = await awaitingDeposit();
      await prisma.penalty.create({ data: { contractId: c.id, amountMinor: 500, reason: 'LATE_PENALTY' } });
      expect(await amountOwedNow(c.id)).toBe(60500);
    });

    it('the portal and staff prompts refuse more than is owed, and a second prompt while one is waiting', async () => {
      const cust = await customer();
      const c = await awaitingDeposit(cust.id);
      const token = await portalToken(cust.id);
      const pay = (amountMinor: number) => portalPayPOST(makeRequest('POST', '/api/portal/pay', { token, body: { contractId: c.id, amountMinor, msisdn: cust.phone } }));

      const over = await pay(70000);
      expect(over.status).toBe(400);
      expect((await over.json()).error).toMatch(/Pay at most GHS 600\.00/);

      // Leave one prompt waiting (as if live), then ask again.
      await prisma.hubtelTransaction.create({ data: { clientReference: `PF-W-${unique()}`, contractId: c.id, msisdn: cust.phone!, amountMinor: 5000, status: 'PENDING' } });
      const again = await pay(5000);
      expect(again.status).toBe(409);
      expect((await again.json()).error).toMatch(/already waiting/);
    });

    it('USSD will not send a second request while one is waiting on the phone', async () => {
      const cust = await customer();
      const c = await prisma.contract.findUniqueOrThrow({ where: { id: (await awaitingDeposit(cust.id)).id } });
      await prisma.hubtelTransaction.create({ data: { clientReference: `PF-U-${unique()}`, contractId: c.id, msisdn: cust.phone!, amountMinor: 5000, status: 'PENDING' } });
      const sid = `pf-${unique()}`;
      await dialSelf(sid, cust.phone!);
      await handleUssdInput({ sessionId: sid, msisdn: cust.phone!, input: '50', isNewSession: false });
      const confirm = await handleUssdInput({ sessionId: sid, msisdn: cust.phone!, input: '1', isNewSession: false });
      expect(confirm).toMatchObject({ continueSession: false, label: 'Request already waiting' });
      expect(await prisma.hubtelTransaction.count({ where: { contractId: c.id } })).toBe(1);
    });
  });

  describe('recording cash once', () => {
    it('the same amount again moments later is asked about; a retry of the same entry is recognised', async () => {
      const c = await awaitingDeposit();
      const record = (body: Record<string, unknown>) => cashPOST(makeRequest('POST', '/api/payments/cash', { token: cashier, body: { contractId: c.id, amountMinor: 5000, ...body } }));
      const ref = `PF-CASH-${unique()}`;
      expect((await record({ transactionRef: ref })).status).toBe(201);
      // The same submission sent again — a lost connection, a second click.
      const retry = await record({ transactionRef: ref });
      expect(retry.status).toBe(201);
      expect((await retry.json()).idempotentReplay).toBe(true);
      // A new entry of the same amount.
      const dup = await record({ transactionRef: `PF-CASH-${unique()}` });
      expect(dup.status).toBe(409);
      expect((await dup.json()).code).toBe('POSSIBLE_DUPLICATE');
      expect((await record({ transactionRef: `PF-CASH-${unique()}`, confirmDuplicate: true })).status).toBe(201);
      expect(await prisma.payment.count({ where: { contractId: c.id } })).toBe(2);
    });
  });

  describe('USSD screens', () => {
    it('a long contract list fits each screen and is split, keeping the same numbers on every part', async () => {
      const cust = await customer({ firstName: 'Bartholomew-Kwabena', lastName: 'Longname' });
      for (let i = 0; i < 7; i++) await awaitingDeposit(cust.id, `Samsung Galaxy A${50 + i} Ultra`);
      const sid = `pf-${unique()}`;
      const first = await dialSelf(sid, cust.phone!);
      expect(first.message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT);
      expect(first.message).toMatch(/\n0\. More$/);
      expect(first.message).toContain('Welcome Bartholomew-Kwabena\n'); // whole words, cut to fit
      expect(first.message).toContain('1. Samsung Galaxy A bal GHS600.00'); // product name, cut to fit

      const more = await handleUssdInput({ sessionId: sid, msisdn: cust.phone!, input: '0', isNewSession: false });
      expect(more.message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT);
      const numbers = (screen: string) => screen.split('\n').map((l) => /^(\d+)\. Samsung/.exec(l)?.[1]).filter(Boolean).map(Number);
      expect(Math.min(...numbers(more.message))).toBe(Math.max(...numbers(first.message)) + 1); // the list carries on
      const lastShown = Math.max(...numbers(more.message));
      expect(lastShown).toBeGreaterThan(1);
      const chosen = await handleUssdInput({ sessionId: sid, msisdn: cust.phone!, input: String(lastShown), isNewSession: false });
      expect(chosen.message).toContain('Enter amount to pay:');
      expect(chosen.message.length).toBeLessThanOrEqual(USSD_SCREEN_LIMIT);
    });

    it('0 shows the last payments and what is owed, without paying anything', async () => {
      const c = await awaitingDeposit();
      const cust = await prisma.customer.findUniqueOrThrow({ where: { id: c.customerId } });
      await postPayment({ contractId: c.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminId });
      const sid = `pf-${unique()}`;
      const prompt = await dialSelf(sid, cust.phone!);
      expect(prompt.message).toContain('0. Last payments');
      const last = await handleUssdInput({ sessionId: sid, msisdn: cust.phone!, input: '0', isNewSession: false });
      expect(last.continueSession).toBe(false);
      expect(last.message).toMatch(/^Last payments:\n\d\d\/\d\d GHS120\.00\nPaid GHS120\.00 Bal GHS480\.00$/);
      expect(await prisma.hubtelTransaction.count({ where: { contractId: c.id } })).toBe(0);
    });
  });

  describe('what customers can print', () => {
    it('the portal gives a customer everything their own statement and receipts need', async () => {
      const cust = await customer();
      const c = await awaitingDeposit(cust.id);
      const { payment } = await postPayment({ contractId: c.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'USSD' });
      const token = await portalToken(cust.id);
      const res = await portalContractGET(makeRequest('GET', `/api/portal/contracts/${c.id}`, { token }), makeParams({ id: c.id }));
      const { contract } = await res.json();
      expect(contract.customer).toMatchObject({ firstName: 'Akua', membershipId: cust.membershipId });
      expect(contract.branch).toHaveProperty('name');
      expect(contract.payments[0]).toMatchObject({ id: payment.id, receiptNumber: payment.receiptNumber, transactionRef: payment.transactionRef, status: 'SUCCESS' });
      expect(contract.customer).not.toHaveProperty('passwordHash');
    });
  });
});
