/**
 * What staff can see and do about mobile money after the fact: every attempt
 * listed with its outcome, and the queue of money collected from a customer
 * but not applied to their contract. Also: older records stay reachable by
 * search however many newer ones there are.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as mobileMoneyGET } from '@/app/api/mobile-money/route';
import { POST as applyPOST } from '@/app/api/mobile-money/[id]/apply/route';
import { POST as resolvePOST } from '@/app/api/mobile-money/[id]/resolve/route';
import { GET as customersGET } from '@/app/api/customers/route';
import { GET as contractsGET } from '@/app/api/contracts/route';
import { GET as inventoryGET } from '@/app/api/inventory/route';
import { createContract } from '@/lib/services/contractService';
import { processHubtelCallback } from '@/lib/services/hubtelPaymentService';
import { generateTransactionRef } from '@/lib/utils/idGenerators';

const runId = Date.now().toString().slice(-7) + Math.floor(Math.random() * 100);

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!123' } }));
  return (await res.json()).token as string;
}

beforeAll(enableOptionalContractTypes);

describe('Mobile money operations', () => {
  let branchId: string;
  let adminUserId: string;
  let admin: string;
  let cashier: string;
  let counter = 0;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
    admin = await login('admin@example.test');
    cashier = await login('cashier@example.test');
  });

  async function makeSaver(lastName: string) {
    counter += 1;
    const phone = `024${runId.slice(-5)}${String(counter).padStart(2, '0')}`;
    const customer = await prisma.customer.create({
      data: { membershipId: `OPS-${runId}-${counter}`, firstName: 'Opsy', lastName, phone, branchId, createdById: adminUserId },
    });
    const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId: customer.id, branchId, createdById: adminUserId });
    return { customer, contract, phone };
  }

  /** A payment Hubtel collected for a contract that, by then, would not take it. */
  async function collectIntoClosedContract(lastName: string, amountMinor: number) {
    const { contract, phone } = await makeSaver(lastName);
    const clientReference = generateTransactionRef();
    await prisma.hubtelTransaction.create({ data: { clientReference, contractId: contract.id, msisdn: phone, amountMinor, status: 'PENDING' } });
    await prisma.contract.update({ where: { id: contract.id }, data: { status: 'CANCELLED' } });
    await processHubtelCallback({ clientReference, status: 'SUCCESS', rawPayload: JSON.stringify({ ResponseCode: '0000', Message: 'success' }) });
    return { contract, clientReference, txn: await prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference } }) };
  }

  const list = async (token: string, query: string) => {
    const res = await mobileMoneyGET(makeRequest('GET', `/api/mobile-money?${query}`, { token }));
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };

  it('money collected but not applied is queued, raises an alert, and can be applied once the contract will take it', async () => {
    const { contract, txn } = await collectIntoClosedContract(`Stuck${runId}`, 7000);
    expect(txn.status).toBe('NEEDS_REVIEW');

    const alert = await prisma.systemAlert.findUnique({ where: { dedupeKey: `payment-needs-review:${txn.id}` } });
    expect(alert?.acknowledgedAt).toBeNull();

    const queue = await list(admin, `filter=NEEDS_REVIEW&q=Stuck${runId}`);
    expect(queue.body.attempts.map((a: { id: string }) => a.id)).toEqual([txn.id]);
    expect(queue.body.needsReview).toBeGreaterThanOrEqual(1);

    // Still closed: trying again changes nothing, and says so.
    const stillClosed = await applyPOST(makeRequest('POST', `/api/mobile-money/${txn.id}/apply`, { token: cashier }), makeParams({ id: txn.id }));
    expect((await stillClosed.json()).transaction.status).toBe('NEEDS_REVIEW');

    await prisma.contract.update({ where: { id: contract.id }, data: { status: 'ACTIVE', cancelledAt: null } });
    const applied = await applyPOST(makeRequest('POST', `/api/mobile-money/${txn.id}/apply`, { token: cashier }), makeParams({ id: txn.id }));
    const { transaction } = await applied.json();
    expect(transaction.status).toBe('SUCCESS');
    expect(transaction.paymentId).not.toBeNull();
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).totalPaidMinor).toBe(7000);
    expect((await list(admin, `filter=NEEDS_REVIEW&q=Stuck${runId}`)).body.attempts).toEqual([]);
  });

  it('one dealt with outside the ledger is closed with a note of what was done — by someone who may reverse payments', async () => {
    const { txn } = await collectIntoClosedContract(`Refunded${runId}`, 3000);
    const resolve = (token: string, note: string) =>
      resolvePOST(makeRequest('POST', `/api/mobile-money/${txn.id}/resolve`, { token, body: { note } }), makeParams({ id: txn.id }));

    expect((await resolve(cashier, 'Refunded in cash')).status).toBe(403); // no payment.reverse
    expect((await resolve(admin, '  ')).status).toBe(400);                // must say what was done
    expect((await resolve(admin, 'Refunded in cash on the 12th')).status).toBe(200);

    expect((await list(admin, `filter=NEEDS_REVIEW&q=Refunded${runId}`)).body.attempts).toEqual([]);
    const all = await list(admin, `filter=ALL&q=Refunded${runId}`);
    expect(all.body.attempts[0]).toMatchObject({ status: 'RESOLVED', resolutionNote: 'Refunded in cash on the 12th' });
    // Closed is closed.
    expect((await resolve(admin, 'again')).status).toBe(400);
  });

  it('lists attempts by outcome with Hubtel\'s own reason, to those who may view payments', async () => {
    const { contract, phone } = await makeSaver(`Declined${runId}`);
    const clientReference = generateTransactionRef();
    await prisma.hubtelTransaction.create({ data: { clientReference, contractId: contract.id, msisdn: phone, amountMinor: 1500, status: 'PENDING' } });
    await processHubtelCallback({
      clientReference, status: 'FAILED',
      rawPayload: JSON.stringify({ ResponseCode: '2001', Message: 'failed', Data: { Description: 'You entered the wrong PIN. Please try again' } }),
    });

    const failed = await list(cashier, `filter=FAILED&q=${clientReference}`);
    expect(failed.body.attempts).toHaveLength(1);
    expect(failed.body.attempts[0]).toMatchObject({ status: 'FAILED', detail: 'You entered the wrong PIN. Please try again', amountMinor: 1500 });
    expect(failed.body.attempts[0]).not.toHaveProperty('rawCallbackPayload');

    expect((await list(await login('storekeeper@example.test'), 'filter=ALL')).status).toBe(403);
    expect((await list(cashier, 'filter=NONSENSE')).status).toBe(400);
  });
});

describe('Finding older records', () => {
  let admin: string;
  let branchId: string;
  let adminUserId: string;

  beforeAll(async () => {
    admin = await login('admin@example.test');
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
  });

  it('search reaches a customer and their contract by any word, in any case, however many newer ones there are', async () => {
    const customer = await prisma.customer.create({
      data: {
        membershipId: `OLD-${runId}`, firstName: 'Abena', lastName: `Longago${runId}`, phone: `055${runId.slice(-7)}`,
        branchId, createdById: adminUserId, createdAt: new Date('2020-01-01'),
      },
    });
    const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId: customer.id, branchId, createdById: adminUserId });
    await prisma.contract.update({ where: { id: contract.id }, data: { createdAt: new Date('2020-01-02') } });

    const customers = async (q: string) => (await (await customersGET(makeRequest('GET', `/api/customers?q=${encodeURIComponent(q)}`, { token: admin }))).json());
    expect((await customers(`longago${runId}`)).customers.map((c: { id: string }) => c.id)).toEqual([customer.id]); // lower case
    expect((await customers(`ABENA longago${runId}`)).customers).toHaveLength(1);                                    // two words
    expect((await customers(`Kwame longago${runId}`)).customers).toHaveLength(0);                                    // every word must match

    // Not among the newest 200, but found by name, by number, or by contract number.
    const contracts = async (q: string) => (await (await contractsGET(makeRequest('GET', `/api/contracts?q=${encodeURIComponent(q)}`, { token: admin }))).json());
    for (const q of [`longago${runId}`, customer.phone!, contract.contractNumber.toLowerCase()]) {
      const found = await contracts(q);
      expect(found.contracts.map((c: { id: string }) => c.id)).toContain(contract.id);
      expect(found.total).toBeGreaterThanOrEqual(1);
    }

    const everything = await (await contractsGET(makeRequest('GET', '/api/contracts', { token: admin }))).json();
    expect(everything.total).toBeGreaterThanOrEqual(everything.contracts.length);
    expect(everything.pageSize).toBe(200);
  });

  it('the wizard\'s unit list can be searched by serial number or product name', async () => {
    const product = await prisma.product.create({ data: { sku: `FIND-${runId}`, name: `Findable Phone ${runId}`, cashPriceMinor: 50000 } });
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `SERIAL-find-${runId}` } });
    const search = async (q: string) =>
      ((await (await inventoryGET(makeRequest('GET', `/api/inventory?status=AVAILABLE&q=${encodeURIComponent(q)}`, { token: admin }))).json()).items as { id: string }[]).map((i) => i.id);
    expect(await search(`serial-FIND-${runId}`)).toEqual([item.id]);
    expect(await search(`findable ${runId}`)).toEqual([item.id]);
    expect(await search(`nothing-like-this-${runId}`)).toEqual([]);
  });
});
