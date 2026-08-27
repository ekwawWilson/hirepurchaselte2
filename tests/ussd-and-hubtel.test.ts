import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as branchesGET } from '@/app/api/branches/route';
import { POST as productsPOST } from '@/app/api/products/route';
import { POST as priceChartPOST } from '@/app/api/price-chart/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { POST as inventoryPOST } from '@/app/api/inventory/route';
import { POST as contractsPOST } from '@/app/api/contracts/route';
import { GET as contractGET } from '@/app/api/contracts/[id]/route';
import { POST as ussdPOST } from '@/app/api/ussd/route';

import { handleUssdInput } from '@/lib/services/ussdService';
import { processHubtelCallback, initiateHubtelPayment, reconcilePendingHubtelTransactions } from '@/lib/services/hubtelPaymentService';
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
  let branchId: string;
  let productId: string;

  beforeAll(async () => {
    admin = await login('admin@hplite.test');
    cashier = await login('cashier@hplite.test');

    const branchesRes = await branchesGET(makeRequest('GET', '/api/branches', { token: admin }));
    branchId = (await branchesRes.json()).branches[0].id;

    const productRes = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { sku: `USSD-SKU-${runId}`, name: 'USSD Test Phone', cashPriceMinor: 240000 },
    }));
    productId = (await productRes.json()).product.id;

    await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'SAVE_TO_OWN', termMonths: 6, depositPercentage: 0, totalPayableMinor: 240000 },
    }));
  });

  async function setupContract(phone: string, opts: { customerId?: string; serialSuffix?: string } = {}) {
    let custId = opts.customerId;
    if (!custId) {
      const customer = await customersPOST(makeRequest('POST', '/api/customers', {
        token: cashier, body: { firstName: 'Ussd', lastName: 'Tester', phone },
      }));
      custId = (await customer.json()).customer.id;
    }

    const item = await inventoryPOST(makeRequest('POST', '/api/inventory', {
      token: admin, body: { productId, serialNumber: `IMEI-USSD-${phone}${opts.serialSuffix ?? ''}`, branchId },
    }));
    const itemId = (await item.json()).item.id;

    const contract = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId: custId, inventoryItemId: itemId, termMonths: 6 },
    }));
    return (await contract.json()).contract;
  }

  it('full USSD flow: initiation -> amount -> confirm -> mock payment posts to the ledger', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);
    const sessionId = `sess-${runId}-1`;

    const step1 = await handleUssdInput({ sessionId, msisdn: phone, input: '', isNewSession: true });
    expect(step1.continueSession).toBe(true);
    expect(step1.message).toContain(contract.contractNumber);
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
    const contractB = await setupContract(phone, { customerId: contractA.customerId, serialSuffix: '-B' });
    const sessionId = `sess-${runId}-multi`;

    const step1 = await handleUssdInput({ sessionId, msisdn: phone, input: '', isNewSession: true });
    expect(step1.continueSession).toBe(true);
    expect(step1.message).toContain('Select a contract');
    expect(step1.message).toContain(contractA.contractNumber);
    expect(step1.message).toContain(contractB.contractNumber);

    // Pick the second contract listed (index 2).
    const step2 = await handleUssdInput({ sessionId, msisdn: phone, input: '2', isNewSession: false });
    expect(step2.continueSession).toBe(true);
    expect(step2.message).toContain(contractB.contractNumber);
    expect(step2.message).not.toContain(contractA.contractNumber);

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
    await setupContract(phone, { customerId: first.customerId, serialSuffix: '-B' });
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
    expect(step1.message).toContain(contract.contractNumber);
  });

  it('unknown phone number gets a clear rejection, not a crash', async () => {
    const result = await handleUssdInput({ sessionId: `sess-${runId}-unknown`, msisdn: '0200000000', input: '', isNewSession: true });
    expect(result.continueSession).toBe(false);
    expect(result.message).toMatch(/no hp-lite account/i);
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
    expect(body.Type).toBe('Response');
    expect(body.SessionId).toBe(sessionId);
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

  it('initiateHubtelPayment throws in live mode (not wired to a real account in this build)', async () => {
    const phone = uniquePhone();
    const contract = await setupContract(phone);
    const original = process.env.HUBTEL_PAYMENTS_MODE;
    process.env.HUBTEL_PAYMENTS_MODE = 'live';
    try {
      await expect(initiateHubtelPayment({ contractId: contract.id, msisdn: phone, amountMinor: 1000 })).rejects.toThrow();
    } finally {
      process.env.HUBTEL_PAYMENTS_MODE = original;
    }
  });
});
