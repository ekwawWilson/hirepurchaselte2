/**
 * Hubtel's Direct Receive Money API, as the app uses it wherever a customer
 * pays by mobile money prompt — USSD, the portal, and staff at the counter:
 *  - the request: the wallet's own network channel, a reference Hubtel accepts;
 *  - a refusal, settled at once with a reason fit to show;
 *  - the callback, including a success that arrives after the app gave up;
 *  - the Transaction Status Check: Paid / Unpaid / Refunded, from five minutes;
 *  - Hubtel's security rule: prompts go only to a customer's registered number.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, withLiveHubtel, hubtelHttp, portalToken } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as portalPayPOST } from '@/app/api/portal/pay/route';
import { POST as hubtelCallbackPOST } from '@/app/api/payments/hubtel/callback/route';
import { POST as mobileMoneyPOST } from '@/app/api/contracts/[id]/mobile-money/route';
import { GET as mobileMoneyStatusGET } from '@/app/api/contracts/[id]/mobile-money/[reference]/route';
import { createContract } from '@/lib/services/contractService';
import { handleUssdInput } from '@/lib/services/ussdService';
import {
  initiateHubtelPayment, processHubtelCallback, reconcilePendingHubtelTransactions, HubtelError,
} from '@/lib/services/hubtelPaymentService';
import { generateTransactionRef } from '@/lib/utils/idGenerators';

const PASSWORD = 'Passw0rd!123';
const runId = Date.now().toString().slice(-7) + Math.floor(Math.random() * 100);

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  return (await res.json()).token as string;
}

/** Hubtel's documented "accepted, expect a callback" answer. */
const accepted = (call: { body: Record<string, unknown> | null }) => ({
  Message: 'Transaction pending. Expect callback request for final state', ResponseCode: '0001',
  Data: { TransactionId: 'hubtel-txn', ClientReference: call.body?.ClientReference, Amount: call.body?.Amount, Charges: 0.05, AmountCharged: 0.85 },
});

beforeAll(enableOptionalContractTypes);

describe('Hubtel Direct Receive Money', () => {
  let branchId: string;
  let adminUserId: string;
  let counter = 0;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
  });

  /** A customer on the given number prefix (so on that network) with a savings contract to pay into. */
  async function makeSaver(prefix: string, extra: { phone2?: string } = {}) {
    counter += 1;
    const phone = `${prefix}${runId.slice(-5)}${String(counter).padStart(2, '0')}`;
    const customer = await prisma.customer.create({
      data: { membershipId: `RM-${runId}-${counter}`, firstName: 'Momo', lastName: `Payer${counter}`, phone, branchId, createdById: adminUserId, ...extra },
    });
    const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId: customer.id, branchId, createdById: adminUserId });
    return { customer, contract, phone };
  }

  const latestTxn = (contractId: string) =>
    prisma.hubtelTransaction.findFirstOrThrow({ where: { contractId }, orderBy: { createdAt: 'desc' } });

  it('sends each wallet down its own network\'s channel, under a reference Hubtel accepts', async () => {
    for (const [prefix, channel] of [['020', 'vodafone-gh'], ['024', 'mtn-gh'], ['027', 'tigo-gh']] as const) {
      const { contract, phone } = await makeSaver(prefix);
      const calls = await withLiveHubtel(accepted, async () => {
        const txn = await initiateHubtelPayment({ contractId: contract.id, msisdn: phone, amountMinor: 80 });
        expect(txn.status).toBe('PENDING'); // accepted — the callback decides
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe('https://rmp.hubtel.com/merchantaccount/merchants/11684/receive/mobilemoney');
      const sent = calls[0].body!;
      expect(sent.Channel).toBe(channel);
      expect(sent.CustomerMsisdn).toBe(`233${phone.slice(1)}`);
      expect(sent.Amount).toBe(0.8);
      // "Maximum length is 36 characters", "preferably alphanumeric".
      expect(String(sent.ClientReference)).toMatch(/^[A-Za-z0-9]{1,36}$/);
      // Hubtel fails a description carrying characters like & * ! % @.
      expect(String(sent.Description)).toMatch(/^[A-Za-z0-9 .,/#-]+$/);
    }
    expect(generateTransactionRef().length).toBeLessThanOrEqual(36);
  });

  it('a number whose network cannot be told is refused before Hubtel is asked — there is no default network', async () => {
    const { contract, phone } = await makeSaver('029'); // not a prefix of any network
    const calls = await withLiveHubtel(accepted, async () => {
      await expect(initiateHubtelPayment({ contractId: contract.id, msisdn: phone, amountMinor: 500 })).rejects.toThrow(HubtelError);
      // Said outright, it goes through.
      await initiateHubtelPayment({ contractId: contract.id, msisdn: phone, amountMinor: 500, network: 'TELECEL' });
    });
    expect(calls.map((c) => c.body!.Channel)).toEqual(['vodafone-gh']);
    expect(await prisma.hubtelTransaction.count({ where: { contractId: contract.id } })).toBe(1);
  });

  it('USSD: the gateway\'s operator decides the channel, and the customer is told to approve on their phone', async () => {
    // An MTN-prefixed number ported to Telecel: the prefix alone would be wrong.
    const { phone } = await makeSaver('024');
    const sessionId = `rm-ussd-${runId}`;
    let last = { message: '', continueSession: true };

    const calls = await withLiveHubtel(accepted, async () => {
      await handleUssdInput({ sessionId, msisdn: phone, operator: 'vodafone', input: '', isNewSession: true });
      await handleUssdInput({ sessionId, msisdn: phone, operator: 'vodafone', input: '50', isNewSession: false });
      last = await handleUssdInput({ sessionId, msisdn: phone, operator: 'vodafone', input: '1', isNewSession: false });
    });

    expect(calls[0].body!.Channel).toBe('vodafone-gh');
    expect(last.continueSession).toBe(false);
    expect(last.message).toMatch(/approve the prompt on your phone/i);
    expect(last.message).not.toMatch(/failed/i);
  });

  it('USSD: with no operator given, a Telecel line is still charged on the Telecel channel, not MTN', async () => {
    const { phone } = await makeSaver('050');
    const sessionId = `rm-ussd-tel-${runId}`;
    const calls = await withLiveHubtel(accepted, async () => {
      await handleUssdInput({ sessionId, msisdn: phone, input: '', isNewSession: true });
      await handleUssdInput({ sessionId, msisdn: phone, input: '20', isNewSession: false });
      await handleUssdInput({ sessionId, msisdn: phone, input: '1', isNewSession: false });
    });
    expect(calls[0].body!.Channel).toBe('vodafone-gh');
  });

  it('a refusal is settled at once, with a reason fit to show the customer', async () => {
    const { contract, phone } = await makeSaver('024');
    const pay = () => initiateHubtelPayment({ contractId: contract.id, msisdn: phone, amountMinor: 1000 });

    // 4101 is about this merchant account — not something to show a customer.
    await withLiveHubtel(
      () => hubtelHttp(400, { ResponseCode: '4101', Message: 'Supplied API keys does not have "mobilemoney-receive-direct" in scopes.' }),
      async () => {
        const error = await pay().catch((e) => e);
        expect(error).toBeInstanceOf(HubtelError);
        expect(error.message).not.toMatch(/API keys|scopes/);
        expect(error.message).toMatch(/not available right now/);
      },
    );
    expect((await latestTxn(contract.id)).status).toBe('FAILED');

    // 2001 is the customer's own wallet — Hubtel's wording is for them.
    await withLiveHubtel(
      () => ({ ResponseCode: '2001', Message: 'You entered the wrong PIN. Please try again' }),
      async () => { await expect(pay()).rejects.toThrow('You entered the wrong PIN. Please try again'); },
    );
    expect((await latestTxn(contract.id)).status).toBe('FAILED');

    // A gateway error is not a refusal: Hubtel may have taken the request, so
    // the transaction waits for the status check instead of being written off.
    await withLiveHubtel(() => hubtelHttp(502, 'Bad Gateway'), async () => { await expect(pay()).rejects.toThrow(HubtelError); });
    expect((await latestTxn(contract.id)).status).toBe('PENDING');
  });

  it('the status check reads Paid, Unpaid and Refunded — an Unpaid answered with code 0000 is not a payment', async () => {
    const { contract, phone } = await makeSaver('024');
    const ageMinutes = { paid: 6, unpaidRecent: 6, unpaidOld: 20, refunded: 6, fresh: 2 };
    const refs = Object.fromEntries(await Promise.all(Object.entries(ageMinutes).map(async ([name, minutes]) => {
      const clientReference = generateTransactionRef();
      await prisma.hubtelTransaction.create({
        data: { clientReference, contractId: contract.id, msisdn: phone, amountMinor: 1000, status: 'PENDING', createdAt: new Date(Date.now() - minutes * 60_000) },
      });
      return [name, clientReference] as const;
    }))) as Record<keyof typeof ageMinutes, string>;

    const calls = await withLiveHubtel(
      (call) => {
        const status = call.url.includes(refs.paid) ? 'Paid' : call.url.includes(refs.refunded) ? 'Refunded' : 'Unpaid';
        // Hubtel's own samples: "Successful" / "0000" for an Unpaid transaction too.
        return { message: 'Successful', responseCode: '0000', data: { status, amount: 10, charges: 0.02, paymentMethod: 'mobilemoney' } };
      },
      async () => { await reconcilePendingHubtelTransactions(); },
    );

    const checked = calls.map((c) => c.url).join(' ');
    expect(calls.every((c) => c.url.startsWith('https://api-txnstatus.hubtel.com/transactions/11684/status?clientReference='))).toBe(true);
    expect(checked).not.toContain(refs.fresh); // under five minutes: its callback may still be on the way

    const status = async (ref: string) => (await prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference: ref } })).status;
    expect(await status(refs.paid)).toBe('SUCCESS');
    expect(await status(refs.refunded)).toBe('FAILED');
    expect(await status(refs.unpaidRecent)).toBe('PENDING'); // the prompt may still be on the customer's phone
    expect(await status(refs.unpaidOld)).toBe('FAILED');     // given up on
    expect(await status(refs.fresh)).toBe('PENDING');

    // Only the one Hubtel called Paid reached the ledger.
    const paid = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(paid.totalPaidMinor).toBe(1000);
  });

  it('a success reported after the app gave up waiting is still recorded, once', async () => {
    const { contract, phone } = await makeSaver('020');
    const clientReference = generateTransactionRef();
    await prisma.hubtelTransaction.create({
      data: {
        clientReference, contractId: contract.id, msisdn: phone, amountMinor: 2500, status: 'FAILED',
        rawCallbackPayload: JSON.stringify({ reconciliation: true, reason: 'stale-pending-unresolved' }),
      },
    });

    const callback = () => hubtelCallbackPOST(makeRequest('POST', '/api/payments/hubtel/callback', {
      token: process.env.WEBHOOK_SHARED_TOKEN,
      body: {
        ResponseCode: '0000', Message: 'success',
        Data: { Amount: 25, Charges: 0.05, ClientReference: clientReference, TransactionId: 'late-1', ExternalTransactionId: '2116938399', AmountCharged: 25.05 },
      },
    }));
    expect((await callback()).status).toBe(200);
    expect((await callback()).status).toBe(200); // Hubtel repeating itself

    const txn = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference } });
    expect(txn.status).toBe('SUCCESS');
    expect(txn.paymentId).not.toBeNull();
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).totalPaidMinor).toBe(2500);

    // A failure, on the other hand, never overturns a payment.
    await processHubtelCallback({ clientReference, status: 'FAILED', rawPayload: '{}' });
    expect((await prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference } })).status).toBe('SUCCESS');
  });

  it('a failed direct-debit charge reported by callback schedules its retry, like one that fails on the spot', async () => {
    const { contract, phone } = await makeSaver('024');
    const clientReference = generateTransactionRef();
    await prisma.hubtelTransaction.create({
      data: { clientReference, contractId: contract.id, msisdn: phone, amountMinor: 4000, status: 'PENDING', channel: 'DIRECT_DEBIT' },
    });

    const res = await hubtelCallbackPOST(makeRequest('POST', '/api/payments/hubtel/callback', {
      token: process.env.WEBHOOK_SHARED_TOKEN,
      body: { ResponseCode: '2001', Message: 'failed', Data: { Description: 'FAILED', ClientReference: clientReference } },
    }));
    expect(res.status).toBe(200);

    const txn = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference } });
    expect(txn.status).toBe('FAILED');
    expect(txn.retryCount).toBe(1);
    expect(txn.nextRetryAt).not.toBeNull();
  });

  describe('prompts go only to a number registered to the customer', () => {
    it('the portal refuses any other number, and reads the network from the number when not told it', async () => {
      const { customer, contract, phone } = await makeSaver('020');
      const stranger = await makeSaver('024');
      const token = await portalToken(customer.id);

      const calls = await withLiveHubtel(accepted, async () => {
        const elsewhere = await portalPayPOST(makeRequest('POST', '/api/portal/pay', {
          token, body: { contractId: contract.id, amountMinor: 5000, network: 'MTN', msisdn: stranger.phone },
        }));
        expect(elsewhere.status).toBe(400);
        expect((await elsewhere.json()).error).toMatch(/registered/);

        const own = await portalPayPOST(makeRequest('POST', '/api/portal/pay', {
          token, body: { contractId: contract.id, amountMinor: 5000, msisdn: phone },
        }));
        expect(own.status).toBe(201);
      });
      // One prompt only, to the customer's own Telecel number.
      expect(calls.map((c) => [c.body!.CustomerMsisdn, c.body!.Channel])).toEqual([[`233${phone.slice(1)}`, 'vodafone-gh']]);
    });

    it('staff send a prompt from the contract to a registered number, and see it through to the ledger', async () => {
      const cashier = await login('cashier@example.test');
      const auditor = await login('auditor@example.test');
      const second = `027${runId.slice(-5)}99`;
      const { contract, phone } = await makeSaver('024', { phone2: second });
      const path = `/api/contracts/${contract.id}/mobile-money`;
      const send = (token: string, body: unknown) => mobileMoneyPOST(makeRequest('POST', path, { token, body }), makeParams({ id: contract.id }));

      expect((await send(auditor, { amountMinor: 3000, msisdn: phone })).status).toBe(403);
      expect((await send(cashier, { amountMinor: 0, msisdn: phone })).status).toBe(400);
      const unknown = await send(cashier, { amountMinor: 3000, msisdn: '0240000001' });
      expect(unknown.status).toBe(400);
      expect((await unknown.json()).error).toMatch(/registered/);

      // Mock mode settles at once; any of the customer's numbers will do.
      const sent = await send(cashier, { amountMinor: 3000, msisdn: second });
      expect(sent.status).toBe(201);
      const { reference } = await sent.json();

      const status = await mobileMoneyStatusGET(
        makeRequest('GET', `${path}/${reference}`, { token: cashier }), makeParams({ id: contract.id, reference }),
      );
      expect(await status.json()).toMatchObject({ status: 'SUCCESS', recorded: true, amountMinor: 3000 });
      expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).totalPaidMinor).toBe(3000);

      // A reference from another contract is not found through this one.
      const other = await makeSaver('024');
      const foreign = await mobileMoneyStatusGET(
        makeRequest('GET', `/api/contracts/${other.contract.id}/mobile-money/${reference}`, { token: cashier }),
        makeParams({ id: other.contract.id, reference }),
      );
      expect(foreign.status).toBe(404);
    });

    it('a closed contract takes no prompt', async () => {
      const cashier = await login('cashier@example.test');
      const { contract, phone } = await makeSaver('024');
      await prisma.contract.update({ where: { id: contract.id }, data: { status: 'CANCELLED' } });
      const res = await mobileMoneyPOST(
        makeRequest('POST', `/api/contracts/${contract.id}/mobile-money`, { token: cashier, body: { amountMinor: 1000, msisdn: phone } }),
        makeParams({ id: contract.id }),
      );
      expect(res.status).toBe(409);
    });
  });
});
