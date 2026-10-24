/**
 * The USSD menu greets a number's owner by name, shows what they owe and —
 * once payments are live — sends their phone a payment prompt, so the endpoint
 * is never open: Hubtel's gateway carries the shared secret in the URL, and
 * the staff simulator a signed-in session. Also: what the app does while
 * Hubtel is still refusing or ignoring this server.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, withLiveHubtel, hubtelHttp } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as ussdPOST } from '@/app/api/ussd/route';
import { POST as ussdByPathPOST } from '@/app/api/ussd/[token]/route';
import { GET as diagnosticsGET } from '@/app/api/settings/hubtel-diagnostics/route';
import { POST as mobileMoneyPOST } from '@/app/api/contracts/[id]/mobile-money/route';
import { createContract } from '@/lib/services/contractService';
import { initiateHubtelPayment, HubtelError } from '@/lib/services/hubtelPaymentService';

const runId = Date.now().toString().slice(-7) + Math.floor(Math.random() * 100);
const SECRET = process.env.WEBHOOK_SHARED_TOKEN!;

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!123' } }));
  return (await res.json()).token as string;
}

beforeAll(enableOptionalContractTypes);

describe('USSD gateway guard', () => {
  let phone: string;
  let contractId: string;
  let counter = 0;
  const dial = () => ({ SessionId: `guard-${runId}-${counter += 1}`, Mobile: phone, Message: '', Type: 'Initiation', Operator: 'mtn' });

  beforeAll(async () => {
    const branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    const adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
    phone = `024${runId.slice(-5)}55`;
    const customer = await prisma.customer.create({
      data: { membershipId: `GUARD-${runId}`, firstName: 'Private', lastName: 'Person', phone, branchId, createdById: adminUserId },
    });
    contractId = (await createContract({ contractType: 'SAVE_TO_OWN', customerId: customer.id, branchId, createdById: adminUserId })).id;
  });

  it('answers nobody without the shared secret or a staff session — a stranger learns nothing about a number', async () => {
    const anonymous = await ussdPOST(makeRequest('POST', '/api/ussd', { body: dial() }));
    expect(anonymous.status).toBe(401);
    expect(JSON.stringify(await anonymous.json())).not.toContain('Private');

    const wrong = await ussdPOST(makeRequest('POST', '/api/ussd?token=not-the-secret', { body: dial() }));
    expect(wrong.status).toBe(401);
  });

  it('answers Hubtel\'s gateway at the address registered with it, the secret in the path', async () => {
    const res = await ussdByPathPOST(makeRequest('POST', `/api/ussd/${SECRET}`, { body: dial() }), makeParams({ token: SECRET }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ Type: 'response', DataType: 'input' });
    expect(body.Message).toContain('Welcome Private Person');

    const guess = await ussdByPathPOST(makeRequest('POST', '/api/ussd/guess', { body: dial() }), makeParams({ token: 'guess' }));
    expect(guess.status).toBe(404);
  });

  it('lets signed-in staff use it as a simulator — any of them in mock mode, only administrators once payments are live', async () => {
    const cashier = await login('cashier@example.test');
    const admin = await login('admin@example.test');
    expect((await ussdPOST(makeRequest('POST', '/api/ussd', { token: cashier, body: dial() }))).status).toBe(200);

    const calls = await withLiveHubtel(() => ({}), async () => {
      const blocked = await ussdPOST(makeRequest('POST', '/api/ussd', { token: cashier, body: dial() }));
      expect(blocked.status).toBe(403);
      expect((await ussdPOST(makeRequest('POST', '/api/ussd', { token: admin, body: dial() }))).status).toBe(200);
    });
    // Dialling in asks Hubtel only whose wallet the number is (the welcome's name) — the blocked cashier, nothing at all.
    expect(calls.map((c) => c.url.split('?')[0])).toEqual(['https://rnv.hubtel.com/v2/merchantaccount/merchants/11684/mobilemoney/verify']);
  });

  it('Settings lists the two addresses Hubtel\'s Programmable Service form asks for, each carrying the secret', async () => {
    const saved = process.env.HUBTEL_CALLBACK_URL;
    process.env.HUBTEL_CALLBACK_URL = 'https://pay.example.test/api/payments/hubtel/callback';
    try {
      const res = await diagnosticsGET(makeRequest('GET', '/api/settings/hubtel-diagnostics', { token: await login('admin@example.test') }));
      const { config } = await res.json();
      expect(config.ussdInteractionUrl).toBe(`https://pay.example.test/api/ussd/${SECRET}`);
      expect(config.serviceFulfilmentUrl).toBe(`https://pay.example.test/api/payments/hubtel/service-fulfilment?token=${SECRET}`);
      expect(config.paymentCallbackUrl).toBe(`https://pay.example.test/api/payments/hubtel/callback?token=${SECRET}`);
    } finally {
      process.env.HUBTEL_CALLBACK_URL = saved;
    }
  });

  describe('while Hubtel has not whitelisted this server', () => {
    const latestTxn = () => prisma.hubtelTransaction.findFirstOrThrow({ where: { contractId }, orderBy: { createdAt: 'desc' } });

    it('a 403 fails the payment at once: the customer is told it is unavailable, staff are told why', async () => {
      const cashier = await login('cashier@example.test');
      await withLiveHubtel(() => hubtelHttp(403, '<html><head><title>403 Forbidden</title></head></html>'), async () => {
        const error = await initiateHubtelPayment({ contractId, msisdn: phone, amountMinor: 1000 }).catch((e) => e);
        expect(error).toBeInstanceOf(HubtelError);
        expect(error.message).toMatch(/not available right now/);
        expect(error.message).not.toMatch(/whitelist|403/);

        const res = await mobileMoneyPOST(
          makeRequest('POST', `/api/contracts/${contractId}/mobile-money`, { token: cashier, body: { amountMinor: 1000, msisdn: phone } }),
          makeParams({ id: contractId }),
        );
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/403 Forbidden.*not whitelisted/);
      });
      expect((await latestTxn()).status).toBe('FAILED');
    });

    it('a request Hubtel never answers gives up after a time limit, and the transaction waits for the status check', async () => {
      await withLiveHubtel(
        () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
        async () => {
          const error = await initiateHubtelPayment({ contractId, msisdn: phone, amountMinor: 1000 }).catch((e) => e);
          expect(error).toBeInstanceOf(HubtelError);
          expect(error.message).toMatch(/could not reach/i);
          expect(error.staffDetail).toMatch(/did not answer in time/);
        },
      );
      // Unknown outcome, not a refusal: Hubtel may have taken it.
      expect((await latestTxn()).status).toBe('PENDING');
    });
  });
});
