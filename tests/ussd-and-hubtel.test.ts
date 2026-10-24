import { describe, it, expect, beforeAll, vi } from 'vitest';
import { makeRequest, enableOptionalContractTypes, registrationFields, freshPhone } from './helpers';
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
const uniquePhone = () => freshPhone('026');

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  const body = await res.json();
  return body.token as string;
}

// Save to Own and Device Loan must be activated before they can be created.
beforeAll(enableOptionalContractTypes);

describe('USSD + Hubtel payments', () => {
  let admin: string;
  let cashier: string;

  beforeAll(async () => {
    admin = await login('admin@example.test');
    cashier = await login('cashier@example.test');
  });

  // SAVE_TO_OWN needs no product/price chart entry/inventory item/branch at
  // all (contractService.ts) — the DEVICE_LOAN test further down creates its
  // own product separately, since it's the only type here that needs one.
  async function setupContract(phone: string, opts: { customerId?: string } = {}) {
    let custId = opts.customerId;
    if (!custId) {
      const customer = await customersPOST(makeRequest('POST', '/api/customers', {
        token: cashier, body: { ...registrationFields(), firstName: 'Ussd', lastName: 'Tester', phone },
      }));
      custId = (await customer.json()).customer.id;
    }

    const contract = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId: custId },
    }));
    return (await contract.json()).contract;
  }

  /** Dial in and choose 1, Self payment: what follows is the caller's own account. */
  async function dialSelf(sessionId: string, msisdn: string) {
    const menu = await handleUssdInput({ sessionId, msisdn, input: '', isNewSession: true });
    expect(menu.message).toMatch(/\n1\. Self payment\n2\. Pay for others$/);
    return handleUssdInput({ sessionId, msisdn, input: '1', isNewSession: false });
  }

  it('the first screen welcomes the caller by name and asks whether they are paying for themselves or someone else', async () => {
    const phone = await uniquePhone();
    await setupContract(phone);
    const menu = await handleUssdInput({ sessionId: `sess-${runId}-menu`, msisdn: phone, input: '', isNewSession: true });
    expect(menu).toMatchObject({ continueSession: true, fieldType: 'number' });
    expect(menu.message).toBe('Welcome Ussd Tester\n1. Self payment\n2. Pay for others'); // mock mode: the registered name stands in for the wallet's

    const again = await handleUssdInput({ sessionId: `sess-${runId}-menu`, msisdn: phone, input: '7', isNewSession: false });
    expect(again.message).toBe('Not an option.\nWelcome Ussd Tester\n1. Self payment\n2. Pay for others');
  });

  it('Self payment from a registered number with nothing to pay offers to pay for someone else instead, or to cancel', async () => {
    const phone = await uniquePhone();
    await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { ...registrationFields(), firstName: 'Nothing', lastName: 'Owed', phone },
    }));
    const sessionId = `sess-${runId}-noactive`;
    await handleUssdInput({ sessionId, msisdn: phone, input: '', isNewSession: true });
    const self = await handleUssdInput({ sessionId, msisdn: phone, input: '1', isNewSession: false });
    expect(self.continueSession).toBe(true);
    expect(self.message).toBe('This number has no active contract.\n1. Pay for others\n2. Cancel');

    const wrong = await handleUssdInput({ sessionId, msisdn: phone, input: '5', isNewSession: false });
    expect(wrong).toMatchObject({ continueSession: true, message: 'Not an option.\n1. Pay for others\n2. Cancel' });

    const others = await handleUssdInput({ sessionId, msisdn: phone, input: '1', isNewSession: false });
    expect(others.message).toMatch(/enter their registered phone number/i);

    // ...or the caller stops there.
    const cancelSession = `sess-${runId}-noactive-cancel`;
    await handleUssdInput({ sessionId: cancelSession, msisdn: phone, input: '', isNewSession: true });
    await handleUssdInput({ sessionId: cancelSession, msisdn: phone, input: '1', isNewSession: false });
    const cancelled = await handleUssdInput({ sessionId: cancelSession, msisdn: phone, input: '2', isNewSession: false });
    expect(cancelled).toMatchObject({ continueSession: false, message: 'Cancelled.' });
    expect(await prisma.ussdSession.findUnique({ where: { sessionId: cancelSession } })).toBeNull();
  });

  it('full USSD flow: initiation -> amount -> confirm -> mock payment posts to the ledger', async () => {
    const phone = await uniquePhone();
    const contract = await setupContract(phone);
    const sessionId = `sess-${runId}-1`;

    const step1 = await dialSelf(sessionId, phone);
    expect(step1.continueSession).toBe(true);
    const { companyName } = await getOrgSettings();
    expect(step1.message).toContain(companyName); // the tenant's own configured business name, on the welcome screen
    expect(step1.message).toMatch(/^Welcome Ussd Tester\n/); // the first thing on screen: the name on the wallet (mock mode: the registered name) — not an account/contract number
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
    const phone = await uniquePhone();
    const contract = await setupContract(phone);
    const sessionId = `sess-${runId}-2`;

    await dialSelf(sessionId, phone);
    await handleUssdInput({ sessionId, msisdn: phone, input: '100', isNewSession: false });
    const cancelled = await handleUssdInput({ sessionId, msisdn: phone, input: '2', isNewSession: false });
    expect(cancelled.continueSession).toBe(false);
    expect(cancelled.message).toMatch(/cancelled/i);

    const detail = await contractGET(makeRequest('GET', `/api/contracts/${contract.id}`, { token: cashier }), makeParams({ id: contract.id }));
    expect((await detail.json()).contract.totalPaidMinor).toBe(0);
  });

  it('a customer with multiple contracts is shown a selection menu and pays the one they pick', async () => {
    const phone = await uniquePhone();
    const contractA = await setupContract(phone);
    const contractB = await setupContract(phone, { customerId: contractA.customerId });
    const sessionId = `sess-${runId}-multi`;

    const step1 = await dialSelf(sessionId, phone);
    expect(step1.continueSession).toBe(true);
    expect(step1.message).toContain('Welcome Ussd Tester');
    expect(step1.message).toContain('Choose:');
    // Lines name what the customer is paying for, not contract numbers.
    expect(step1.message).toMatch(/1\. Savings saved GHS0\.00\n2\. Savings saved GHS0\.00/);
    expect(step1.message).not.toContain(contractA.contractNumber);

    // Pick the second contract listed (index 2) — its own prompt greets by
    // full name only, no contract number (that's only shown in the selection
    // list above, to tell the choices apart).
    const step2 = await handleUssdInput({ sessionId, msisdn: phone, input: '2', isNewSession: false });
    expect(step2.continueSession).toBe(true);
    expect(step2.message).toContain('Welcome Ussd Tester');
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

  it('a choice not on the list is asked again, not the end of the session', async () => {
    const phone = await uniquePhone();
    const first = await setupContract(phone);
    await setupContract(phone, { customerId: first.customerId });
    const sessionId = `sess-${runId}-badselect`;

    await dialSelf(sessionId, phone);
    const result = await handleUssdInput({ sessionId, msisdn: phone, input: '99', isNewSession: false });
    expect(result.continueSession).toBe(true);
    expect(result.message).toMatch(/^Not on the list\.\n/);
    expect(result.message).toContain('Choose:');
    // ...and a valid choice after that still works.
    const next = await handleUssdInput({ sessionId, msisdn: phone, input: '2', isNewSession: false });
    expect(next.message).toContain('Enter amount to pay');
  });

  it('a DEFAULTED contract is still selectable via USSD — self-service payment is how a customer cures their own default', async () => {
    const phone = await uniquePhone();
    const contract = await setupContract(phone);
    await prisma.contract.update({ where: { id: contract.id }, data: { status: 'DEFAULTED' } });

    const sessionId = `sess-${runId}-defaulted`;
    const step1 = await dialSelf(sessionId, phone);
    expect(step1.continueSession).toBe(true);
    expect(step1.message).toContain('Welcome Ussd Tester');
  });

  it('an unknown number choosing Self payment is offered Pay for others, and can go back to the menu from there', async () => {
    const sessionId = `sess-${runId}-unknown`;
    const ask = (input: string, isNewSession = false) => handleUssdInput({ sessionId, msisdn: '0200000000', input, isNewSession });
    const { companyName } = await getOrgSettings();
    expect((await ask('', true)).message).toBe(`Welcome to ${companyName.length > 22 ? `${companyName.slice(0, 21).trimEnd()}.` : companyName}\n1. Self payment\n2. Pay for others`);

    const self = await ask('1');
    expect(self.continueSession).toBe(true);
    expect(self.message).toBe('This number is not registered.\n1. Pay for others\n2. Cancel');

    expect((await ask('1')).message).toMatch(/enter their registered phone number/i);
    const back = await ask('0');
    expect(back.continueSession).toBe(true);
    expect(back.message).toMatch(/\n1\. Self payment\n2\. Pay for others$/);
  });

  it('Pay for others: anyone can pay on an account by typing its registered number, and is billed on the phone they dialled from', async () => {
    const dialedPhone = '0200000001';
    const registeredPhone = await uniquePhone();
    const contract = await setupContract(registeredPhone);
    const sessionId = `sess-${runId}-altphone`;

    await handleUssdInput({ sessionId, msisdn: dialedPhone, input: '', isNewSession: true });
    const step1 = await handleUssdInput({ sessionId, msisdn: dialedPhone, input: '2', isNewSession: false });
    expect(step1.continueSession).toBe(true);
    expect(step1.message).toMatch(/enter their registered phone number/i);

    // A typo/unregistered number first — must re-prompt, not crash or end the session.
    const retry = await handleUssdInput({ sessionId, msisdn: dialedPhone, input: '0200000002', isNewSession: false });
    expect(retry.continueSession).toBe(true);
    expect(retry.message).toMatch(/no account found/i);

    const found = await handleUssdInput({ sessionId, msisdn: dialedPhone, input: registeredPhone, isNewSession: false });
    expect(found.continueSession).toBe(true);
    expect(found.message).toMatch(/^Paying for Ussd Tester\n/); // whose account it is, for the person paying

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
    const phone = await uniquePhone();
    await setupContract(phone);
    const sessionId = `sess-${runId}-route`;

    const res = await ussdPOST(makeRequest('POST', '/api/ussd', {
      token: process.env.WEBHOOK_SHARED_TOKEN, // the gateway's shared secret — the route is never open
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
    const phone = await uniquePhone();
    await setupContract(phone);
    const sessionId = `sess-${runId}-timeout`;

    await ussdPOST(makeRequest('POST', '/api/ussd', {
      token: process.env.WEBHOOK_SHARED_TOKEN, // the gateway's shared secret — the route is never open
      body: { SessionId: sessionId, Mobile: phone, Message: '', Type: 'Initiation' },
    }));
    expect(await prisma.ussdSession.findUnique({ where: { sessionId } })).not.toBeNull();

    const res = await ussdPOST(makeRequest('POST', '/api/ussd', {
      token: process.env.WEBHOOK_SHARED_TOKEN, // the gateway's shared secret — the route is never open
      body: { SessionId: sessionId, Mobile: phone, Message: '', Type: 'Timeout' },
    }));
    const body = await res.json();
    expect(body.Type).toBe('release');
    expect(await prisma.ussdSession.findUnique({ where: { sessionId } })).toBeNull();
  });

  it('Hubtel callback idempotency: replaying the same clientReference does not double-post', async () => {
    const phone = await uniquePhone();
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
    const phone = await uniquePhone();
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

  // What the Service Fulfilment URL does with a report from Hubtel's checkout
  // is tested in tests/ussd-checkout.test.ts; this is only its front door.
  it('the Service Fulfilment route rejects a call that does not carry the shared secret', async () => {
    const res = await serviceFulfilmentPOST(makeRequest('POST', '/api/payments/hubtel/service-fulfilment', {
      body: { SessionId: 'sess-x', OrderId: 'order-x' },
    }));
    expect(res.status).toBe(401);
  });

  it('reconciliation marks stale PENDING transactions FAILED', async () => {
    const phone = await uniquePhone();
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
    const phone = await uniquePhone();
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
    const phone = await uniquePhone();
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
    const phone = await uniquePhone();
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
      // await uniquePhone() is an 026 number — AirtelTigo — so it goes out on that network's channel.
      expect(JSON.parse(sample!.requestPayload as string)).toMatchObject({ Channel: 'tigo-gh', Amount: 10 });
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
    const phone = await uniquePhone();
    const contract = await setupContract(phone);

    const step1 = await dialSelf(`sess-${runId}-sto`, phone);
    expect(step1.message).not.toContain(contract.contractNumber);
    expect(step1.message).toContain('Saved GHS0.00');
    expect(step1.message).not.toContain('Bal ');
    expect(step1.message).not.toContain('OVERDUE');
  });

  it('DEVICE_LOAN\'s prompt offers only the currently-owed option(s) — no schedule, no free-typed amount', async () => {
    const phone = await uniquePhone();
    const customer = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { ...registrationFields(), firstName: 'Ussd', lastName: 'Loan', phone },
    }));
    const customerId = (await customer.json()).customer.id;
    // DEVICE_LOAN disburses cash directly — not linked to a product or
    // inventory item at all (src/app/api/contracts/route.ts).
    const contractRes = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId, loanAmountMinor: 100000 },
    }));
    const contract = (await contractRes.json()).contract;

    // Fresh loan, nothing accrued yet — only "pay full loan" is offered, no interest option.
    const step1 = await dialSelf(`sess-${runId}-dl1`, phone);
    expect(step1.continueSession).toBe(true);
    expect(step1.message).not.toContain('Pay interest');
    expect(step1.message).toContain('Pay full loan GHS1000.00');
    expect(step1.message).toContain('Reply with option:');

    // Simulate a day of accrued interest (loanService.accrueDailyLoanInterest's
    // own row shape) so both options are on offer.
    await prisma.penalty.create({
      data: { contractId: contract.id, amountMinor: 1000, reason: 'DAILY_LOAN_INTEREST', appliedDate: new Date() },
    });

    const step2 = await dialSelf(`sess-${runId}-dl2`, phone);
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
    const phone = await uniquePhone();
    const customer = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { ...registrationFields(), firstName: 'Ussd', lastName: 'BadOption', phone },
    }));
    const customerId = (await customer.json()).customer.id;
    await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId, loanAmountMinor: 50000 },
    }));

    await dialSelf(`sess-${runId}-dlbad`, phone);
    // Option 1 (pay interest) isn't valid yet — nothing has accrued.
    const result = await handleUssdInput({ sessionId: `sess-${runId}-dlbad`, msisdn: phone, input: '1', isNewSession: false });
    expect(result.continueSession).toBe(true);
    expect(result.message).toMatch(/not an option/i);
  });
});
