import { describe, it, expect, beforeAll, vi } from 'vitest';
import { makeRequest } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { POST as contractsPOST } from '@/app/api/contracts/route';
import { GET as contractGET } from '@/app/api/contracts/[id]/route';
import { POST as ussdPOST } from '@/app/api/ussd/route';
import { POST as hubtelCallbackPOST } from '@/app/api/payments/hubtel/callback/route';
import { POST as serviceFulfilmentPOST } from '@/app/api/payments/hubtel/service-fulfilment/route';
import { GET as hubtelDiagnosticsGET } from '@/app/api/settings/hubtel-diagnostics/route';

import { handleUssdInput } from '@/lib/services/ussdService';
import { processHubtelCallback, initiateHubtelPayment, reconcilePendingHubtelTransactions } from '@/lib/services/hubtelPaymentService';
import { getOrgSettings } from '@/lib/services/orgSettingsService';
import { makeParams } from './helpers';

const PASSWORD = 'Passw0rd!123';
const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
function uniquePhone() {
  counter += 1;
  return `026${runId}${counter}`;
}

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  const body = await res.json();
  return body.token as string;
}

describe('USSD + Hubtel payments', () => {
  let admin: string;
  let cashier: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');
    cashier = await login('cashier@zple.test');
  });

  // SAVE_TO_OWN needs no product/price chart entry/inventory item/branch at
  // all (contractService.ts) — the DEVICE_LOAN test further down creates its
  // own product separately, since it's the only type here that needs one.
  async function setupContract(phone: string, opts: { customerId?: string } = {}) {
    let custId = opts.customerId;
    if (!custId) {
      const customer = await customersPOST(makeRequest('POST', '/api/customers', {
        token: cashier, body: { firstName: 'Ussd', lastName: 'Tester', phone },
      }));
      custId = (await customer.json()).customer.id;
    }

    const contract = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId: custId },
    }));
    return (await contract.json()).contract;
  }

  it('full USSD flow: initiation -> amount -> confirm -> mock payment posts to the ledger', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);
    const sessionId = `sess-${runId}-1`;

    const step1 = await handleUssdInput({ sessionId, msisdn: phone, input: '', isNewSession: true });
    expect(step1.continueSession).toBe(true);
    const { companyName } = await getOrgSettings();
    expect(step1.message).toContain(companyName); // the tenant's own configured business name, on the welcome screen
    expect(step1.message).toContain('Hi Ussd Tester'); // greets the customer by their full name, not an account/contract number
    expect(step1.message).not.toContain(contract.contractNumber);
    expect(step1.message).toContain('Enter amount');

    const step2 = await handleUssdInput({ sessionId, msisdn: phone, input: '500', isNewSession: false });
    expect(step2.continueSession).toBe(true);
    expect(step2.message).toContain('Confirm payment of GHS500.00');

    const step3 = await handleUssdInput({ sessionId, msisdn: phone, input: '1', isNewSession: false });
    expect(step3.continueSession).toBe(false);
    expect(step3.message).toMatch(/successful/i);

    const detail = await contractGET(makeRequest('GET', `/api/contracts/${contract.id}`, { token: cashier }), makeParams({ id: contract.id }));
    const updated = (await detail.json()).contract;
    expect(updated.totalPaidMinor).toBe(50000);
    expect(updated.payments.some((p: { channel: string; amountMinor: number }) => p.channel === 'USSD' && p.amountMinor === 50000)).toBe(true);
  });

  it('USSD cancel flow ends the session without posting a payment', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);
    const sessionId = `sess-${runId}-2`;

    await handleUssdInput({ sessionId, msisdn: phone, input: '', isNewSession: true });
    await handleUssdInput({ sessionId, msisdn: phone, input: '100', isNewSession: false });
    const cancelled = await handleUssdInput({ sessionId, msisdn: phone, input: '2', isNewSession: false });
    expect(cancelled.continueSession).toBe(false);
    expect(cancelled.message).toMatch(/cancelled/i);

    const detail = await contractGET(makeRequest('GET', `/api/contracts/${contract.id}`, { token: cashier }), makeParams({ id: contract.id }));
    expect((await detail.json()).contract.totalPaidMinor).toBe(0);
  });

  it('a customer with multiple contracts is shown a selection menu and pays the one they pick', async () => {
    const phone = uniquePhone();
    const contractA = await setupContract(phone);
    const contractB = await setupContract(phone, { customerId: contractA.customerId });
    const sessionId = `sess-${runId}-multi`;

    const step1 = await handleUssdInput({ sessionId, msisdn: phone, input: '', isNewSession: true });
    expect(step1.continueSession).toBe(true);
    expect(step1.message).toContain('Hi Ussd Tester');
    expect(step1.message).toContain('Select a contract');
    expect(step1.message).toContain(contractA.contractNumber);
    expect(step1.message).toContain(contractB.contractNumber);

    // Pick the second contract listed (index 2) — its own prompt greets by
    // full name only, no contract number (that's only shown in the selection
    // list above, to tell the choices apart).
    const step2 = await handleUssdInput({ sessionId, msisdn: phone, input: '2', isNewSession: false });
    expect(step2.continueSession).toBe(true);
    expect(step2.message).toContain('Hi Ussd Tester');
    expect(step2.message).not.toContain(contractA.contractNumber);
    expect(step2.message).not.toContain(contractB.contractNumber);

    const step3 = await handleUssdInput({ sessionId, msisdn: phone, input: '300', isNewSession: false });
    expect(step3.message).toContain('Confirm payment of GHS300.00');
    const step4 = await handleUssdInput({ sessionId, msisdn: phone, input: '1', isNewSession: false });
    expect(step4.message).toMatch(/successful/i);

    const detailB = await contractGET(makeRequest('GET', `/api/contracts/${contractB.id}`, { token: cashier }), makeParams({ id: contractB.id }));
    expect((await detailB.json()).contract.totalPaidMinor).toBe(30000);

    const detailA = await contractGET(makeRequest('GET', `/api/contracts/${contractA.id}`, { token: cashier }), makeParams({ id: contractA.id }));
    expect((await detailA.json()).contract.totalPaidMinor).toBe(0); // untouched — the payment went to B, not A
  });

  it('an invalid selection index ends the session cleanly instead of crashing', async () => {
    const phone = uniquePhone();
    const first = await setupContract(phone);
    await setupContract(phone, { customerId: first.customerId });
    const sessionId = `sess-${runId}-badselect`;

    await handleUssdInput({ sessionId, msisdn: phone, input: '', isNewSession: true });
    const result = await handleUssdInput({ sessionId, msisdn: phone, input: '99', isNewSession: false });
    expect(result.continueSession).toBe(false);
    expect(result.message).toMatch(/invalid selection/i);
  });

  it('a DEFAULTED contract is still selectable via USSD — self-service payment is how a customer cures their own default', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);
    await prisma.contract.update({ where: { id: contract.id }, data: { status: 'DEFAULTED' } });

    const sessionId = `sess-${runId}-defaulted`;
    const step1 = await handleUssdInput({ sessionId, msisdn: phone, input: '', isNewSession: true });
    expect(step1.continueSession).toBe(true);
    expect(step1.message).toContain('Hi Ussd Tester');
  });

  it('unknown phone number is prompted for a registered number instead of dead-ending', async () => {
    const sessionId = `sess-${runId}-unknown`;
    const result = await handleUssdInput({ sessionId, msisdn: '0200000000', input: '', isNewSession: true });
    expect(result.continueSession).toBe(true);
    expect(result.message).toMatch(/no .+ account found/i);
    expect(result.message).toMatch(/enter a registered phone number/i);

    const cancelled = await handleUssdInput({ sessionId, msisdn: '0200000000', input: '0', isNewSession: false });
    expect(cancelled.continueSession).toBe(false);
    expect(cancelled.message).toMatch(/cancelled/i);
  });

  it('unknown phone number can identify their account with a registered alternate number, and gets billed on the dialed-in number', async () => {
    const dialedPhone = '0200000001';
    const registeredPhone = uniquePhone();
    const contract = await setupContract(registeredPhone);
    const sessionId = `sess-${runId}-altphone`;

    const step1 = await handleUssdInput({ sessionId, msisdn: dialedPhone, input: '', isNewSession: true });
    expect(step1.continueSession).toBe(true);
    expect(step1.message).toMatch(/no .+ account found/i);

    // A typo/unregistered number first — must re-prompt, not crash or end the session.
    const retry = await handleUssdInput({ sessionId, msisdn: dialedPhone, input: '0200000002', isNewSession: false });
    expect(retry.continueSession).toBe(true);
    expect(retry.message).toMatch(/no account found/i);

    const found = await handleUssdInput({ sessionId, msisdn: dialedPhone, input: registeredPhone, isNewSession: false });
    expect(found.continueSession).toBe(true);
    expect(found.message).toContain('Hi Ussd Tester');

    const enterAmount = await handleUssdInput({ sessionId, msisdn: dialedPhone, input: '400', isNewSession: false });
    expect(enterAmount.message).toMatch(/confirm payment/i);

    const confirmed = await handleUssdInput({ sessionId, msisdn: dialedPhone, input: '1', isNewSession: false });
    expect(confirmed.continueSession).toBe(false);
    expect(confirmed.message).toMatch(/payment successful/i);

    // Billed to the phone actually dialed in, never the alternate lookup number.
    const txn = await prisma.hubtelTransaction.findFirstOrThrow({ where: { contractId: contract.id } });
    expect(txn.msisdn).toBe(dialedPhone);
  });

  it('the real /api/ussd route wires the Hubtel-style request/response contract correctly', async () => {
    const phone = uniquePhone();
    await setupContract(phone);
    const sessionId = `sess-${runId}-route`;

    const res = await ussdPOST(makeRequest('POST', '/api/ussd', {
      body: { SessionId: sessionId, Mobile: phone, Message: '', Type: 'Initiation' },
    }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // Lowercase "response"/"release" and the presence of Label/DataType/FieldType
    // match Hubtel's own Programmable Services contract exactly — see
    // ussdService.ts/route.ts, and the docs' Response Parameters table which
    // marks all three Mandatory.
    expect(body.Type).toBe('response');
    expect(body.SessionId).toBe(sessionId);
    expect(typeof body.Label).toBe('string');
    expect(body.Label.length).toBeGreaterThan(0);
    expect(body.DataType).toBe('input');
    expect(typeof body.FieldType).toBe('string');

    // Settings > Hubtel Diagnostics sources its "sample payloads" panel from
    // real captured traffic, not hand-typed illustrative JSON — this is the
    // one durable record of a USSD exchange's raw shape (see
    // hubtelSampleLogService.ts).
    const sample = await prisma.hubtelSampleLog.findUnique({ where: { kind: 'USSD' } });
    expect(sample).not.toBeNull();
    expect(JSON.parse(sample!.requestPayload as string)).toMatchObject({ SessionId: sessionId, Type: 'Initiation' });
    expect(JSON.parse(sample!.responsePayload as string)).toMatchObject({ SessionId: sessionId, Type: 'response' });

    // Settings > Hubtel Diagnostics surfaces exactly that captured exchange —
    // real traffic this server handled, not hand-typed illustrative JSON.
    const diag = await hubtelDiagnosticsGET(makeRequest('GET', '/api/settings/hubtel-diagnostics', { token: admin }));
    expect(diag.status).toBe(200);
    const diagBody = await diag.json();
    expect(diagBody.samples.ussd).not.toBeNull();
    expect(diagBody.samples.ussd.request).toMatchObject({ SessionId: sessionId });
  });

  it('a Hubtel "Timeout" notification (customer hung up) ends the session cleanly instead of treating it as input', async () => {
    const phone = uniquePhone();
    await setupContract(phone);
    const sessionId = `sess-${runId}-timeout`;

    await ussdPOST(makeRequest('POST', '/api/ussd', {
      body: { SessionId: sessionId, Mobile: phone, Message: '', Type: 'Initiation' },
    }));
    expect(await prisma.ussdSession.findUnique({ where: { sessionId } })).not.toBeNull();

    const res = await ussdPOST(makeRequest('POST', '/api/ussd', {
      body: { SessionId: sessionId, Mobile: phone, Message: '', Type: 'Timeout' },
    }));
    const body = await res.json();
    expect(body.Type).toBe('release');
    expect(await prisma.ussdSession.findUnique({ where: { sessionId } })).toBeNull();
  });

  it('Hubtel callback idempotency: replaying the same clientReference does not double-post', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);

    // Create a PENDING transaction directly (bypassing the mock's synchronous resolution)
    // to exercise processHubtelCallback's own idempotency guard in isolation.
    const clientReference = `TEST-HUBTEL-${runId}`;
    await prisma.hubtelTransaction.create({
      data: { clientReference, contractId: contract.id, msisdn: phone, amountMinor: 30000, status: 'PENDING' },
    });

    const first = await processHubtelCallback({ clientReference, status: 'SUCCESS', rawPayload: '{}' });
    expect(first.status).toBe('SUCCESS');

    const replay = await processHubtelCallback({ clientReference, status: 'SUCCESS', rawPayload: '{}' });
    expect(replay.status).toBe('SUCCESS'); // unchanged, not reprocessed

    const detail = await contractGET(makeRequest('GET', `/api/contracts/${contract.id}`, { token: cashier }), makeParams({ id: contract.id }));
    expect((await detail.json()).contract.totalPaidMinor).toBe(30000); // not 60000
  });

  it('the real /api/payments/hubtel/callback route parses Hubtel\'s actual Receive-Money callback shape', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);
    const clientReference = `TEST-ROUTE-CALLBACK-${runId}`;

    await prisma.hubtelTransaction.create({
      data: { clientReference, contractId: contract.id, msisdn: phone, amountMinor: 20000, status: 'PENDING' },
    });

    // Hubtel's real Receive-Money callback shape — {ResponseCode, Message,
    // Data: {ClientReference, ...}} — not the internal {clientReference,
    // status} shape processHubtelCallback takes directly.
    const res = await hubtelCallbackPOST(makeRequest('POST', '/api/payments/hubtel/callback', {
      token: process.env.WEBHOOK_SHARED_TOKEN,
      body: {
        ResponseCode: '0000',
        Message: 'Success',
        Data: {
          ClientReference: clientReference,
          TransactionId: 'HTX-TEST-1',
          ExternalTransactionId: 'EXT-TEST-1',
          Amount: 200,
          Status: 'Success',
        },
      },
    }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('SUCCESS');

    const txn = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference } });
    expect(txn.status).toBe('SUCCESS');
  });

  it('the Service Fulfilment route rejects an unauthenticated call — this integration never expects to receive one, but must still fail closed', async () => {
    const res = await serviceFulfilmentPOST(makeRequest('POST', '/api/payments/hubtel/service-fulfilment', {
      body: { SessionId: 'sess-x', OrderId: 'order-x' },
    }));
    expect(res.status).toBe(401);
  });

  it('the Service Fulfilment route acknowledges an authenticated call and sends the required Service Fulfillment Callback', async () => {
    const guardedFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://gs-callback.hubtel.com:9055/callback');
      const sent = JSON.parse(init?.body as string);
      expect(sent).toEqual({ SessionId: 'sess-unexpected', OrderId: 'order-unexpected', ServiceStatus: 'success', MetaData: null });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const res = await serviceFulfilmentPOST(makeRequest('POST', '/api/payments/hubtel/service-fulfilment', {
        token: process.env.WEBHOOK_SHARED_TOKEN,
        body: { SessionId: 'sess-unexpected', OrderId: 'order-unexpected', OrderInfo: { Status: 'Paid' } },
      }));
      expect(res.status).toBe(200);
      expect((await res.json()).received).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = guardedFetch;
    }
  });

  it('reconciliation marks stale PENDING transactions FAILED', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);
    const clientReference = `TEST-STALE-${runId}`;

    await prisma.hubtelTransaction.create({
      data: {
        clientReference, contractId: contract.id, msisdn: phone, amountMinor: 10000, status: 'PENDING',
        createdAt: new Date(Date.now() - 60 * 60_000), // 1 hour ago
      },
    });

    const result = await reconcilePendingHubtelTransactions(15);
    expect(result.failed).toBeGreaterThanOrEqual(1);

    const txn = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference } });
    expect(txn.status).toBe('FAILED');
  });

  it('reconciliation asks Hubtel\'s Transaction Status Check before failing a stale transaction, and honors a Paid result', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);
    const clientReference = `TEST-STALE-PAID-${runId}`;

    await prisma.hubtelTransaction.create({
      data: {
        clientReference, contractId: contract.id, msisdn: phone, amountMinor: 15000, status: 'PENDING',
        createdAt: new Date(Date.now() - 60 * 60_000),
      },
    });

    const originalMode = process.env.HUBTEL_PAYMENTS_MODE;
    const originalSalesId = process.env.HUBTEL_POS_SALES_ID;
    const originalKey = process.env.HUBTEL_API_KEY;
    const originalSecret = process.env.HUBTEL_API_SECRET;
    process.env.HUBTEL_PAYMENTS_MODE = 'live';
    process.env.HUBTEL_POS_SALES_ID = 'TEST-SALES-ID';
    process.env.HUBTEL_API_KEY = 'test-key';
    process.env.HUBTEL_API_SECRET = 'test-secret';

    // Same response shape the legacy hirepurchase app's checkHubtelPaymentStatus
    // callers parse for this exact endpoint (data.status, case-insensitive).
    // Saved/restored directly (not vi.stubGlobal/unstubAllGlobals) so this
    // test's cleanup can never accidentally remove tests/setup.ts's global
    // real-network guard — see that file for why.
    const guardedFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async (url: string) => {
      expect(url).toContain('/transactions/TEST-SALES-ID/status');
      expect(url).toContain(`clientReference=${clientReference}`);
      return new Response(JSON.stringify({ responseCode: '0000', data: { status: 'Paid' } }), { status: 200 });
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const result = await reconcilePendingHubtelTransactions(15);
      expect(result.succeeded).toBeGreaterThanOrEqual(1);
      expect(fetchSpy).toHaveBeenCalled();

      const txn = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference } });
      expect(txn.status).toBe('SUCCESS');
    } finally {
      globalThis.fetch = guardedFetch;
      process.env.HUBTEL_PAYMENTS_MODE = originalMode;
      process.env.HUBTEL_POS_SALES_ID = originalSalesId;
      process.env.HUBTEL_API_KEY = originalKey;
      process.env.HUBTEL_API_SECRET = originalSecret;
    }
  });

  it('initiateHubtelPayment in live mode never reaches the real network in tests', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);
    const original = process.env.HUBTEL_PAYMENTS_MODE;
    process.env.HUBTEL_PAYMENTS_MODE = 'live';
    // No local fetch stub here on purpose — this relies entirely on
    // tests/setup.ts's global fetch guard (every test gets it by default) to
    // prove a careless live-mode call can never slip through to Hubtel's
    // real API, regardless of what credentials happen to be configured.
    try {
      await expect(initiateHubtelPayment({ contractId: contract.id, msisdn: phone, amountMinor: 1000 }))
        .rejects.toThrow(/Blocked outbound network call/);
    } finally {
      process.env.HUBTEL_PAYMENTS_MODE = original;
    }
  });

  it('a live Receive-Money call is captured for Hubtel Diagnostics\' sample-payloads panel, request and response alike', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);
    const originalMode = process.env.HUBTEL_PAYMENTS_MODE;
    const originalSalesId = process.env.HUBTEL_POS_SALES_ID;
    const originalKey = process.env.HUBTEL_API_KEY;
    const originalSecret = process.env.HUBTEL_API_SECRET;
    process.env.HUBTEL_PAYMENTS_MODE = 'live';
    process.env.HUBTEL_POS_SALES_ID = 'TEST-SALES-ID';
    process.env.HUBTEL_API_KEY = 'test-key';
    process.env.HUBTEL_API_SECRET = 'test-secret';

    const guardedFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      Message: 'Accepted', ResponseCode: '0001',
      Data: { TransactionId: 'HTX-1', ClientReference: 'whatever', Amount: 10, Charges: 0, AmountCharged: 10 },
    }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const txn = await initiateHubtelPayment({ contractId: contract.id, msisdn: phone, amountMinor: 1000 });
      expect(txn.status).toBe('PENDING');

      // captured at the single choke point every outbound Receive-Money call
      // goes through (hubtelClient.ts) — real data, not a fabricated example.
      const sample = await prisma.hubtelSampleLog.findUnique({ where: { kind: 'RECEIVE_MONEY_INITIATE' } });
      expect(sample).not.toBeNull();
      expect(JSON.parse(sample!.requestPayload as string)).toMatchObject({ Channel: 'mtn-gh', Amount: 10 });
      expect(JSON.parse(sample!.responsePayload as string)).toMatchObject({ ResponseCode: '0001' });
    } finally {
      globalThis.fetch = guardedFetch;
      process.env.HUBTEL_PAYMENTS_MODE = originalMode;
      process.env.HUBTEL_POS_SALES_ID = originalSalesId;
      process.env.HUBTEL_API_KEY = originalKey;
      process.env.HUBTEL_API_SECRET = originalSecret;
    }
  });

  it('SAVE_TO_OWN\'s payment prompt shows only the running total paid — no due schedule to report', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);

    const step1 = await handleUssdInput({ sessionId: `sess-${runId}-sto`, msisdn: phone, input: '', isNewSession: true });
    expect(step1.message).not.toContain(contract.contractNumber);
    expect(step1.message).toContain('Total paid: GHS0.00');
    expect(step1.message).not.toContain('Bal ');
    expect(step1.message).not.toContain('OVERDUE');
  });

  it('DEVICE_LOAN\'s prompt offers only the currently-owed option(s) — no schedule, no free-typed amount', async () => {
    const phone = uniquePhone();
    const customer = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { firstName: 'Ussd', lastName: 'Loan', phone },
    }));
    const customerId = (await customer.json()).customer.id;
    // DEVICE_LOAN disburses cash directly — not linked to a product or
    // inventory item at all (src/app/api/contracts/route.ts).
    const contractRes = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId, loanAmountMinor: 100000 },
    }));
    const contract = (await contractRes.json()).contract;

    // Fresh loan, nothing accrued yet — only "pay full loan" is offered, no interest option.
    const step1 = await handleUssdInput({ sessionId: `sess-${runId}-dl1`, msisdn: phone, input: '', isNewSession: true });
    expect(step1.continueSession).toBe(true);
    expect(step1.message).not.toContain('Pay interest');
    expect(step1.message).toContain('Pay full loan GHS1000.00');
    expect(step1.message).toContain('Reply with option:');

    // Simulate a day of accrued interest (loanService.accrueDailyLoanInterest's
    // own row shape) so both options are on offer.
    await prisma.penalty.create({
      data: { contractId: contract.id, amountMinor: 1000, reason: 'DAILY_LOAN_INTEREST', appliedDate: new Date() },
    });

    const step2 = await handleUssdInput({ sessionId: `sess-${runId}-dl2`, msisdn: phone, input: '', isNewSession: true });
    expect(step2.message).toContain('1. Pay interest GHS10.00');
    expect(step2.message).toContain('2. Pay full loan GHS1000.00');

    // Picking option 1 (interest) goes straight to a confirm screen for the
    // exact accrued amount — no free-typed amount is ever possible here.
    const chooseInterest = await handleUssdInput({ sessionId: `sess-${runId}-dl2`, msisdn: phone, input: '1', isNewSession: false });
    expect(chooseInterest.continueSession).toBe(true);
    expect(chooseInterest.message).toContain('Confirm payment of GHS10.00');

    const confirmed = await handleUssdInput({ sessionId: `sess-${runId}-dl2`, msisdn: phone, input: '1', isNewSession: false });
    expect(confirmed.continueSession).toBe(false);
    expect(confirmed.message).toMatch(/successful/i);

    const detail = await contractGET(makeRequest('GET', `/api/contracts/${contract.id}`, { token: cashier }), makeParams({ id: contract.id }));
    const state = (await detail.json()).contract.deviceLoanState;
    expect(state.accruedInterestMinor).toBe(0);
    expect(state.interestPaidMinor).toBe(1000);
    expect(state.principalOutstanding).toBe(true); // paying interest never touches the principal
  });

  it('an invalid DEVICE_LOAN option is rejected instead of accepted as a free-typed amount', async () => {
    const phone = uniquePhone();
    const customer = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { firstName: 'Ussd', lastName: 'BadOption', phone },
    }));
    const customerId = (await customer.json()).customer.id;
    await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId, loanAmountMinor: 50000 },
    }));

    await handleUssdInput({ sessionId: `sess-${runId}-dlbad`, msisdn: phone, input: '', isNewSession: true });
    // Option 1 (pay interest) isn't valid yet — nothing has accrued.
    const result = await handleUssdInput({ sessionId: `sess-${runId}-dlbad`, msisdn: phone, input: '1', isNewSession: false });
    expect(result.continueSession).toBe(true);
    expect(result.message).toMatch(/invalid option/i);
  });
});
