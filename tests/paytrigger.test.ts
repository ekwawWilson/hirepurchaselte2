/**
 * Device Financing with Transsion PayTrigger (src/lib/paytrigger): which
 * phones may be sold on which contract, enrolment, the activation callback,
 * locking and opening as payments come and go, the agent deposit hold,
 * release, offline PINs, and the safety switches. PayTrigger itself is
 * replaced by `withPayTrigger`; nothing here reaches the network.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, freshPhone } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { createContract, approveContract, cancelContract } from '@/lib/services/contractService';
import { postPayment, reversePayment } from '@/lib/services/paymentService';
import { fileRemittance, confirmRemittance } from '@/lib/services/agentLedgerService';
import { signBody, signContent, jsonList } from '@/lib/paytrigger/client';
import { notifyPayTrigger, payTriggerIdle, payTriggerHookStats, registryAdd } from '@/lib/paytrigger/notify';
import { reconcileContract } from '@/lib/paytrigger/reconcile';
import { enrolPhones, issueOfflinePin, releaseDevice, setProductBrand } from '@/lib/paytrigger/admin';
import { runPayTriggerSweep } from '@/lib/paytrigger/sweep';
import { clearPayTriggerSettingsCache } from '@/lib/paytrigger/settings';
import { POST as webhookPOST } from '@/app/api/paytrigger/webhook/route';
import { GET as inventoryGET } from '@/app/api/inventory/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';

const KEY = 'test-paytrigger-key-0000000000000';
const runId = Date.now().toString().slice(-7) + Math.floor(Math.random() * 100);
let counter = 0;
const DAY = 24 * 60 * 60 * 1000;

type Call = { path: string; body: Record<string, unknown>; sign: string | null };

/**
 * Runs `fn` with PayTrigger configured (a key set, so callbacks verify and
 * reads are live) and its API replaced by `respond`. `live` also switches
 * actions live, as on a production server. Restores everything after.
 */
async function withPayTrigger(opts: { live?: boolean; canary?: string; respond?: (call: Call) => unknown }, fn: () => Promise<void>): Promise<Call[]> {
  const saved = {
    key: process.env.PAYTRIGGER_API_KEY, dry: process.env.PAYTRIGGER_DRY_RUN, live: process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS, canary: process.env.PAYTRIGGER_CANARY_CONTRACTS,
  };
  process.env.PAYTRIGGER_API_KEY = KEY;
  process.env.PAYTRIGGER_DRY_RUN = opts.live ? 'false' : 'true';
  process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS = opts.live ? 'true' : 'false';
  process.env.PAYTRIGGER_CANARY_CONTRACTS = opts.canary ?? '';
  const calls: Call[] = [];
  const guard = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call = { path: String(url).replace(/^https:\/\/paytrigger\.transsion-os\.com\/PayTrigger/, ''), body: JSON.parse(String(init?.body ?? '{}')), sign: (init?.headers as Record<string, string>)?.sign ?? null };
    calls.push(call);
    return new Response(JSON.stringify(opts.respond?.(call) ?? { code: 200, message: 'Success', data: null }), { status: 200 });
  }) as unknown as typeof fetch;
  try {
    await fn();
    await payTriggerIdle();
  } finally {
    globalThis.fetch = guard;
    process.env.PAYTRIGGER_API_KEY = saved.key ?? '';
    if (saved.dry === undefined) delete process.env.PAYTRIGGER_DRY_RUN; else process.env.PAYTRIGGER_DRY_RUN = saved.dry;
    if (saved.live === undefined) delete process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS; else process.env.PAYTRIGGER_ENABLE_LIVE_ACTIONS = saved.live;
    process.env.PAYTRIGGER_CANARY_CONTRACTS = saved.canary ?? '';
  }
  return calls;
}

/** A callback as PayTrigger sends it, signed with the API key. */
async function callback(body: Record<string, string | number | null>, opts: { sign?: string | null } = {}) {
  const sign = opts.sign === undefined ? signBody(body, KEY) : opts.sign;
  const res = await webhookPOST(makeRequest('POST', '/api/paytrigger/webhook', { body, headers: sign ? { sign } : {} }));
  await payTriggerIdle();
  return res.json();
}

/** A unique 15-digit IMEI. */
const imei = () => `35${runId.padStart(7, '0').slice(-7)}${String(++counter).padStart(6, '0')}`;

beforeAll(enableOptionalContractTypes);
afterEach(() => clearPayTriggerSettingsCache());

describe('PayTrigger signing', () => {
  it('matches the worked example in PayTrigger\'s API reference', () => {
    const body = { apiKey: '8qXIGKndpecSDmlLF1HaQ0fN6AREjvs4', imeiInfo: '[{"expiration":1662136801,"imei":"359581820772412","model":"infinix SMART 6","ram":"2","rom":"32"}]', preLockFlag: false };
    expect(signContent(body)).toBe('apiKey=8qXIGKndpecSDmlLF1HaQ0fN6AREjvs4&imeiInfo=[{"expiration":1662136801,"imei":"359581820772412","model":"infinix SMART 6","ram":"2","rom":"32"}]&preLockFlag=false');
    expect(signBody(body, '8qXIGKndpecSDmlLF1HaQ0fN6AREjvs4')).toBe('QkI3NkM0ODIzN0NDQzJBM0I2REY1RUY5MjgzRTkxQUNGRTk4M0VFOTY0QzlCMzRGNUYzRTE2OTFGMzgzMUFBNw==');
  });

  it('leaves out empty fields and sends a nested list as a JSON string with its keys in order', () => {
    expect(signContent({ b: 2, a: 'x', c: '', d: null, e: undefined })).toBe('a=x&b=2');
    expect(jsonList([{ orderNum: 'o', imei: '1', ruleNum: 0, deeplink: undefined }])).toBe('[{"imei":"1","orderNum":"o","ruleNum":0}]');
  });
});

describe('Device Financing with PayTrigger', () => {
  let branchId: string;
  let adminId: string;
  let agentId: string;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
    agentId = (await prisma.user.findFirstOrThrow({ where: { email: 'agent@example.test' } })).id;
    await prisma.user.update({ where: { id: agentId }, data: { branchId } });
  });

  async function phone(opts: { mark?: boolean } = {}) {
    const product = await prisma.product.create({ data: { sku: `PT-${runId}-${++counter}`, name: 'TECNO Spark 30', brand: 'TECNO', cashPriceMinor: 60000 } });
    if (opts.mark !== false) await setProductBrand(product.id, 'TECNO', adminId);
    return prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: imei() } });
  }
  async function customer() {
    return prisma.customer.create({ data: { membershipId: `PT-${runId}-${++counter}`, firstName: 'Abena', lastName: `Mensah${counter}`, phone: await freshPhone(), branchId, createdById: adminId } });
  }
  /** GHS 600, GHS 120 deposit, four weekly GHS 120 instalments starting today. */
  async function sell(itemId: string, opts: { createdById?: string; requiresApproval?: boolean } = {}) {
    const contract = await createContract({
      contractType: 'DEVICE_FINANCING', customerId: (await customer()).id, inventoryItemId: itemId, branchId, createdById: opts.createdById ?? adminId,
      requiresApproval: opts.requiresApproval, totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 4, paymentFrequency: 'WEEKLY',
    });
    await payTriggerIdle();
    return contract;
  }
  const device = (inventoryItemId: string) => prisma.payTriggerDevice.findUniqueOrThrow({ where: { inventoryItemId } });
  const pay = async (contractId: string, amountMinor: number, extra: { collectedByAgentId?: string; createdById?: string } = {}) => {
    const r = await postPayment({ contractId, amountMinor, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: extra.createdById ?? adminId, ...extra });
    await payTriggerIdle();
    return r;
  };
  /** PayTrigger reporting the phone's first switch-on: it has locked itself. */
  const activate = (item: { serialNumber: string }, tag: string, mobileStatus = 1000) => callback({ notifyType: 1000, imei: item.serialNumber, deviceTag: tag, state: 3000, serverState: 3000, mobileStatus, orderNum: 'x' });

  describe('which phones each contract may sell', () => {
    it('a PayTrigger phone cannot go on Deposit + Instalment', async () => {
      const item = await phone();
      await expect(createContract({
        contractType: 'DEPOSIT_INSTALMENT', customerId: (await customer()).id, inventoryItemId: item.id, branchId, createdById: adminId,
        totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 4,
      })).rejects.toThrow(/sell it on Device Financing/);
    });

    it('Device Financing refuses a phone not marked as PayTrigger, and one not enrolled', async () => {
      const unmarked = await phone({ mark: false });
      await expect(sell(unmarked.id)).rejects.toThrow(/only for TECNO, Infinix and itel phones marked/);
      const notEnrolled = await phone();
      await expect(sell(notEnrolled.id)).rejects.toThrow(/not enrolled with PayTrigger/);
    });

    it('an enrolled phone sells on Device Financing and is linked to its contract at once', async () => {
      const item = await phone();
      expect((await enrolPhones([item.id], adminId))[0]).toMatchObject({ ok: true, dryRun: true });
      const contract = await sell(item.id);
      expect(contract).toMatchObject({ contractType: 'DEVICE_FINANCING', status: 'PENDING_DEPOSIT' });
      expect(await device(item.id)).toMatchObject({ contractId: contract.id, enrollmentStatus: 'QUEUED' });
    });

    it('the new-contract wizard lists only enrolled PayTrigger phones for Device Financing, and none for Deposit + Instalment', async () => {
      const enrolled = await phone();
      await enrolPhones([enrolled.id], adminId);
      const notEnrolled = await phone();
      const plain = await phone({ mark: false });
      const token = (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email: 'admin@example.test', password: 'Passw0rd!123' } }))).json()).token;
      const list = async (saleType: string) => ((await (await inventoryGET(makeRequest('GET', `/api/inventory?status=AVAILABLE&saleType=${saleType}`, { token }))).json()).items as Array<{ id: string }>).map((i) => i.id);
      const financing = await list('DEVICE_FINANCING');
      expect(financing).toContain(enrolled.id);
      expect(financing).not.toContain(notEnrolled.id);
      expect(financing).not.toContain(plain.id);
      const deposit = await list('DEPOSIT_INSTALMENT');
      expect(deposit).toContain(plain.id);
      expect(deposit).not.toContain(enrolled.id);
    });
  });

  it('the whole life of a phone: locked until switched on, opened by its deposit, locked when overdue, opened by paying, locked by a reversal', async () => {
    const item = await phone();
    const calls = await withPayTrigger({}, async () => {
      await enrolPhones([item.id], adminId);
      const contract = await sell(item.id);
      await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminId });
      await payTriggerIdle();
      // Not switched on yet: nothing to send, it locks itself on first switch-on.
      expect((await device(item.id)).providerExpiresAt).toBeNull();

      // First switch-on: PayTrigger calls back; the phone gets its contract's date.
      expect(await activate(item, 'TAG-A')).toEqual({ code: 200, message: 'Success' });
      let d = await device(item.id);
      expect(d).toMatchObject({ enrollmentStatus: 'ACTIVE', deviceTag: 'TAG-A', committedState: 'PENDING' });
      const first = await prisma.instalment.findFirstOrThrow({ where: { contractId: contract.id, instalmentNo: 1 } });
      const expected = new Date(Date.UTC(first.dueDate.getUTCFullYear(), first.dueDate.getUTCMonth(), first.dueDate.getUTCDate() + 8, 8, 30));
      expect(d.providerExpiresAt).toEqual(expected);
      expect(d.lockMessageKey).toMatch(/^dry:/); // the lock-screen text, simulated

      // Instalment 1 unpaid past the grace period: locked a minute from now.
      await prisma.instalment.update({ where: { id: first.id }, data: { dueDate: new Date(Date.now() - 10 * DAY), status: 'OVERDUE' } });
      await reconcileContract(contract.id, { reasons: ['CONTRACT_CHANGED'] });
      d = await device(item.id);
      expect(Math.abs(d.providerExpiresAt!.getTime() - (Date.now() + 60_000))).toBeLessThan(10_000);

      // Paid: open again until instalment 2's grace period has run out.
      const { payment } = await pay(contract.id, 12000);
      d = await device(item.id);
      const second = await prisma.instalment.findFirstOrThrow({ where: { contractId: contract.id, instalmentNo: 2 } });
      expect(d.providerExpiresAt).toEqual(new Date(Date.UTC(second.dueDate.getUTCFullYear(), second.dueDate.getUTCMonth(), second.dueDate.getUTCDate() + 8, 8, 30)));

      // The payment reversed: locked again.
      await reversePayment({ paymentId: payment.id, reason: 'bounced', reversedById: adminId });
      await payTriggerIdle();
      d = await device(item.id);
      expect(d.providerExpiresAt!.getTime()).toBeLessThan(Date.now() + 120_000);

      const sent = await prisma.payTriggerActionLog.findMany({ where: { deviceId: d.id }, orderBy: { createdAt: 'asc' } });
      expect(sent.map((l) => l.action)).toEqual(expect.arrayContaining(['ENROL', 'LINK', 'CALLBACK_ACTIVATED', 'LOCK_TEXT', 'EXTEND', 'LOCK']));
      expect(sent.filter((l) => l.action === 'EXTEND' || l.action === 'LOCK').every((l) => l.dryRun)).toBe(true);
    });
    // Dry run: no action left the server. Only reads may have (none were needed).
    expect(calls.filter((c) => c.path.includes('updateRepayInfo') || c.path.includes('setLockRule'))).toEqual([]);
  });

  it('callbacks: answered 200 every time, kept once however often sent, and ignored unless signed', async () => {
    const item = await phone();
    await enrolPhones([item.id], adminId);
    await withPayTrigger({}, async () => {
      const body = { notifyType: 1000, imei: item.serialNumber, deviceTag: 'TAG-DUP', state: 3000, mobileStatus: 1000 };
      await callback(body);
      await callback(body);
      expect(await prisma.payTriggerWebhookEvent.count({ where: { body: { path: ['imei'], equals: item.serialNumber } } })).toBe(1);
      expect(await prisma.payTriggerActionLog.count({ where: { deviceId: (await device(item.id)).id, action: 'CALLBACK_ACTIVATED' } })).toBe(1);

      const forged = { notifyType: 2000, imei: item.serialNumber, deviceTag: 'TAG-DUP' };
      expect(await callback(forged, { sign: 'not-the-signature' })).toEqual({ code: 200, message: 'Success' });
      expect(await device(item.id)).toMatchObject({ enrollmentStatus: 'ACTIVE' }); // not removed
      const kept = await prisma.payTriggerWebhookEvent.findFirstOrThrow({ where: { notifyType: '2000', body: { path: ['imei'], equals: item.serialNumber } } });
      expect(kept).toMatchObject({ processedAt: null, error: 'Signature check failed' });
    });
  });

  it('an agent\'s contract stays locked until the deposit cash they took is remitted', async () => {
    const item = await phone();
    await withPayTrigger({}, async () => {
      await enrolPhones([item.id], adminId);
      const contract = await sell(item.id, { createdById: agentId, requiresApproval: true });
      await approveContract({ contractId: contract.id, approvedById: adminId });
      await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: agentId, collectedByAgentId: agentId });
      await payTriggerIdle();
      await activate(item, 'TAG-AGENT');
      let d = await device(item.id);
      // Held: it locked itself on switch-on and is not opened; its lock screen
      // tells the customer to contact the agent.
      expect(d.providerExpiresAt).toBeNull();
      const text = await prisma.payTriggerActionLog.findFirstOrThrow({ where: { deviceId: d.id, action: 'LOCK_TEXT' }, orderBy: { createdAt: 'desc' } });
      expect(text.request).toMatchObject({ deviceTitle: 'Phone not yet activated', deviceTips: expect.stringContaining('Contact Field Agent') });

      const ledger = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { contractId: contract.id } });
      const remittance = await fileRemittance({ ledgerId: ledger.id, agentId, amountMinor: ledger.amountOwedMinor - ledger.amountRemittedMinor + ledger.commissionPaidMinor, method: 'CASH' });
      await confirmRemittance({ remittanceId: remittance.id, confirmedById: adminId, confirmerBranchId: null });
      await payTriggerIdle();
      d = await device(item.id);
      expect(d.providerExpiresAt!.getTime()).toBeGreaterThan(Date.now() + DAY); // opened
    });
  });

  it('a contract with no PayTrigger phone never reaches the sidecar, and a burst of events costs at most two reconciles', async () => {
    const plainItem = await prisma.inventoryItem.create({ data: { productId: (await prisma.product.create({ data: { sku: `PT-${runId}-${++counter}`, name: 'Samsung A15', cashPriceMinor: 60000 } })).id, branchId, serialNumber: `SN-${runId}-${counter}` } });
    const plain = await createContract({ contractType: 'DEPOSIT_INSTALMENT', customerId: (await customer()).id, inventoryItemId: plainItem.id, branchId, createdById: adminId, totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 4 });
    const before = payTriggerHookStats.reconciles;
    await pay(plain.id, 12000);
    for (let i = 0; i < 10; i++) notifyPayTrigger(plain.id, 'PAYMENT');
    await payTriggerIdle();
    expect(payTriggerHookStats.reconciles).toBe(before);

    const item = await phone();
    await enrolPhones([item.id], adminId);
    const financed = await sell(item.id);
    registryAdd(financed.id);
    const start = payTriggerHookStats.reconciles;
    for (let i = 0; i < 10; i++) notifyPayTrigger(financed.id, 'PAYMENT');
    await payTriggerIdle();
    expect(payTriggerHookStats.reconciles - start).toBeLessThanOrEqual(2);
  });

  it('a contract cancelled before the phone was switched on returns it to stock still enrolled, for the next sale', async () => {
    const item = await phone();
    await enrolPhones([item.id], adminId);
    const contract = await sell(item.id);
    await cancelContract({ contractId: contract.id, reason: 'customer changed their mind', userId: adminId });
    await payTriggerIdle();
    expect(await device(item.id)).toMatchObject({ contractId: null, enrollmentStatus: 'QUEUED' });
    expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('AVAILABLE');
    const next = await sell(item.id);
    expect(await device(item.id)).toMatchObject({ contractId: next.id });
  });

  describe('live', () => {
    it('enrols a batch: a partial failure (50021) fails only the phones named, and "already enrolled" (50015) counts as enrolled', async () => {
      const [a, b, c] = [await phone(), await phone(), await phone()];
      let outcomes: Awaited<ReturnType<typeof enrolPhones>> = [];
      const calls = await withPayTrigger({
        live: true,
        respond: (call) => call.path.endsWith('/imei/input')
          ? { code: 50021, message: 'Some IMEI entry failed', data: [{ imei: a.serialNumber, errCode: '50015', message: 'This IMEI has been enrolled' }, { imei: b.serialNumber, errCode: '50078', message: 'The IMEI matches the blacklist' }] }
          : { code: 200, message: 'Success', data: { brandName: 'TECNO', modelMarketName: 'TECNO SPARK 30' } },
      }, async () => {
        outcomes = await enrolPhones([a.id, b.id, c.id], adminId);
      });
      expect(outcomes.map((o) => [o.ok, o.dryRun])).toEqual([[true, false], [false, false], [true, false]]);
      expect(outcomes[1].message).toMatch(/blacklist/);
      expect(await device(b.id)).toMatchObject({ enrollmentStatus: 'FAILED' });
      const enrol = calls.find((c) => c.path.endsWith('/imei/input'))!;
      expect(enrol.body).toMatchObject({ preLockFlag: true, apiKey: KEY });
      expect(JSON.parse(enrol.body.imeiInfo as string)[0]).toEqual({ imei: a.serialNumber, nextRepaymentTimeSwitch: true, orderNum: a.id, ruleNum: 0 });
      expect(enrol.sign).toBe(signBody(enrol.body as Record<string, string>, KEY));
      // The key never reaches the log.
      const logged = await prisma.payTriggerActionLog.findFirstOrThrow({ where: { deviceId: (await device(a.id)).id, action: 'ENROL' } });
      expect(JSON.stringify(logged.request)).not.toContain(KEY);
    });

    it('a phone re-added to stock under a new inventory item keeps its enrolment record, moved to the new item; an IMEI on two live items is refused', async () => {
      const old = await phone();
      await enrolPhones([old.id], adminId);
      const serial = old.serialNumber;
      await prisma.inventoryItem.update({ where: { id: old.id }, data: { serialNumber: `${serial}-OLD` } });
      const readded = await prisma.inventoryItem.create({ data: { productId: old.productId, branchId, serialNumber: serial } });
      expect((await enrolPhones([readded.id], adminId))[0]).toMatchObject({ ok: true });
      expect(await device(readded.id)).toMatchObject({ imei: serial });

      const twin = await phone();
      await enrolPhones([twin.id], adminId);
      await prisma.payTriggerDevice.update({ where: { inventoryItemId: twin.id }, data: { enrollmentStatus: 'ACTIVE' } });
      expect((await enrolPhones([twin.id], adminId))[0]).toMatchObject({ ok: false, message: expect.stringMatching(/use Verify/) });
    });

    it('lock dates are sent signed, with the amounts, under the merchant key PayTrigger names relatedMerchant', async () => {
      const item = await phone();
      let contractNumber = '';
      const calls = await withPayTrigger({ live: true }, async () => {
        await enrolPhones([item.id], adminId);
        const contract = await sell(item.id);
        contractNumber = contract.contractNumber;
        await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminId });
        await payTriggerIdle();
        await activate(item, 'TAG-LIVE');
      });
      const update = calls.find((c) => c.path.endsWith('/updateRepayInfo'))!;
      expect(update.body).toMatchObject({
        imei: item.serialNumber, deviceTag: 'TAG-LIVE', relatedMerchant: KEY, orderNum: contractNumber, currencyType: 'GHS',
        repayedAmt: '120.00', totalAmt: '600.00', nextRepayAmt: '120.00', currentTerm: 1, totalTerm: 4,
      });
      expect(update.body).not.toHaveProperty('apiKey');
      expect(update.body.nextRepayTime).toBeGreaterThan(Date.now() / 1000);
      expect(calls.some((c) => c.path.endsWith('/setLockRule') && c.body.deviceTitle === 'Payment overdue')).toBe(true);
    });

    it('while a canary list is set, only those contracts are sent anything live', async () => {
      const item = await phone();
      const calls = await withPayTrigger({ live: true, canary: 'SOME-OTHER-CONTRACT' }, async () => {
        await enrolPhones([item.id], adminId);
        const contract = await sell(item.id);
        await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminId });
        await payTriggerIdle();
        await activate(item, 'TAG-CANARY');
      });
      expect(calls.filter((c) => c.path.endsWith('/updateRepayInfo'))).toEqual([]);
      expect(await prisma.payTriggerActionLog.findFirst({ where: { deviceId: (await device(item.id)).id, skippedReason: { contains: 'canary' } } })).not.toBeNull();
    });

    it('an offline PIN: refused while the phone should be locked, given once (never stored) when paid, and asks for the lock-screen key on an old app', async () => {
      const item = await phone();
      let deviceId = '';
      await withPayTrigger({ live: true, respond: (call) => call.path.endsWith('/verifyCode') ? { code: 200, message: 'Success', data: { verifyCode: '987654321' } } : undefined }, async () => {
        await enrolPhones([item.id], adminId);
        const contract = await sell(item.id);
        await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminId });
        await payTriggerIdle();
        await activate(item, 'TAG-PIN');
        deviceId = (await device(item.id)).id;
        const result = await issueOfflinePin(deviceId, adminId);
        expect(result.pin).toBe('987654321');
        expect(await device(item.id)).toMatchObject({ pinUnlocksUsed: 1 });

        const first = await prisma.instalment.findFirstOrThrow({ where: { contractId: contract.id, instalmentNo: 1 } });
        await prisma.instalment.update({ where: { id: first.id }, data: { dueDate: new Date(Date.now() - 10 * DAY), status: 'OVERDUE' } });
        await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { providerExpiresAt: new Date(Date.now() - DAY) } });
        await expect(issueOfflinePin(deviceId, adminId)).rejects.toThrow(/lock date has passed/);
      });
      const logs = await prisma.payTriggerActionLog.findMany({ where: { deviceId, action: 'PIN' } });
      expect(JSON.stringify(logs)).not.toContain('987654321');

      await withPayTrigger({ live: true, respond: (call) => call.path.endsWith('/verifyCode') ? { code: 50063, message: 'The APK version is 2.1, so the key code is required.' } : undefined }, async () => {
        await prisma.instalment.updateMany({ where: { contract: { inventoryItemId: item.id } }, data: { dueDate: new Date(Date.now() + 5 * DAY), status: 'PENDING' } });
        expect(await issueOfflinePin(deviceId, adminId)).toMatchObject({ pin: null, needsKey: true });
      });
    });

    it('paid off: the lock is removed after the hold period by the sweep, checking the contract again first', async () => {
      const item = await phone();
      await withPayTrigger({ live: true }, async () => {
        await enrolPhones([item.id], adminId);
        const contract = await sell(item.id);
        await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminId });
        await payTriggerIdle();
        await activate(item, 'TAG-REL');
        await expect(releaseDevice((await device(item.id)).id, adminId)).rejects.toThrow(/paid-off contract/);

        await pay(contract.id, 48000);
        expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('COMPLETED');
        const d = await device(item.id);
        expect(d.releaseAfter).not.toBeNull();
        await prisma.payTriggerDevice.update({ where: { id: d.id }, data: { releaseAfter: new Date(Date.now() - 1000) } });
        const summary = await runPayTriggerSweep();
        expect(summary.released).toBeGreaterThanOrEqual(1);
      });
      expect(await device(item.id)).toMatchObject({ enrollmentStatus: 'REMOVED', committedState: 'UNLOCKED' });
    });
  });
});

// Route-level guard for the release action: typing RELEASE is required.
describe('PayTrigger device routes', () => {
  it('refuses to release without RELEASE typed out', async () => {
    const { POST } = await import('@/app/api/paytrigger/devices/[id]/[action]/route');
    const token = (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email: 'superadmin@example.test', password: 'Passw0rd!123' } }))).json()).token;
    const res = await POST(makeRequest('POST', '/api/paytrigger/devices/x/release', { token, body: {} }), makeParams({ id: 'x', action: 'release' }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Type RELEASE/);
  });
});
