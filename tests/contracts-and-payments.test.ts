import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as branchesGET } from '@/app/api/branches/route';
import { POST as productsPOST } from '@/app/api/products/route';
import { POST as priceChartPOST } from '@/app/api/price-chart/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { POST as inventoryPOST, GET as inventoryGET } from '@/app/api/inventory/route';
import { POST as contractsPOST } from '@/app/api/contracts/route';
import { GET as contractGET } from '@/app/api/contracts/[id]/route';
import { POST as contractReleasePOST } from '@/app/api/contracts/[id]/release/route';
import { POST as paymentsCashPOST } from '@/app/api/payments/cash/route';
import { GET as paymentsGET } from '@/app/api/payments/route';
import { POST as paymentReversePOST } from '@/app/api/payments/[id]/reverse/route';
import { POST as withdrawPOST } from '@/app/api/payments/withdraw/route';

const PASSWORD = 'Passw0rd!123';

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.token as string;
}

const runId = Date.now().toString().slice(-8);
let counter = 0;
function uniquePhone() {
  counter += 1;
  return `020${runId}${counter}`;
}
function uniqueSerial(label: string) {
  return `IMEI-${label}-${runId}`;
}

describe('Contracts + payments: full lifecycle across all three types', () => {
  let admin: string;
  let cashier: string;
  let sales: string;
  let branchId: string;
  let productId: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');
    cashier = await login('cashier@zple.test');
    sales = await login('sales@zple.test');

    const branchesRes = await branchesGET(makeRequest('GET', '/api/branches', { token: admin }));
    const branchesBody = await branchesRes.json();
    branchId = branchesBody.branches[0].id;

    const productRes = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { sku: `TEST-SKU-${runId}`, name: 'Test Phone', cashPriceMinor: 250000 },
    }));
    expect(productRes.status).toBe(201);
    const productBody = await productRes.json();
    productId = productBody.product.id;
  });

  async function makeCustomer(label: string) {
    const res = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { firstName: 'Test', lastName: label, phone: uniquePhone() },
    }));
    expect(res.status).toBe(201);
    return (await res.json()).customer.id as string;
  }

  async function receiveItem(label: string) {
    const res = await inventoryPOST(makeRequest('POST', '/api/inventory', {
      token: admin, body: { productId, serialNumber: uniqueSerial(label), branchId },
    }));
    expect(res.status).toBe(201);
    return (await res.json()).item.id as string;
  }

  async function getItemStatus(itemId: string) {
    const res = await inventoryGET(makeRequest('GET', `/api/inventory?productId=${productId}`, { token: admin }));
    const body = await res.json();
    return body.items.find((i: { id: string; status: string }) => i.id === itemId).status;
  }

  async function getContract(contractId: string, token: string) {
    const res = await contractGET(makeRequest('GET', `/api/contracts/${contractId}`, { token }), makeParams({ id: contractId }));
    expect(res.status).toBe(200);
    return (await res.json()).contract;
  }

  it('SAVE_TO_OWN: pays from zero, device withheld until fully paid, then explicitly released', async () => {
    const entry = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'SAVE_TO_OWN', termMonths: 6, depositAmountMinor: 0, totalPayableMinor: 240000 },
    }));
    expect(entry.status).toBe(201);

    const custId = await makeCustomer('SaveToOwn');
    const itemId = await receiveItem('A');

    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId: custId, inventoryItemId: itemId, termMonths: 6 },
    }));
    expect(created.status).toBe(201);
    const contract = (await created.json()).contract;
    expect(contract.status).toBe('ACTIVE');
    expect(contract.depositAmountMinor).toBe(0);
    expect(contract.totalPayableMinor).toBe(240000);
    expect(await getItemStatus(itemId)).toBe('RESERVED');

    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 200000, entryType: 'INSTALMENT_PAYMENT' },
    }));
    let detail = await getContract(contract.id, cashier);
    expect(detail.balanceMinor).toBe(40000);
    expect(detail.status).toBe('ACTIVE');

    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 40000, entryType: 'INSTALMENT_PAYMENT' },
    }));
    detail = await getContract(contract.id, cashier);
    expect(detail.status).toBe('COMPLETED');
    expect(detail.balanceMinor).toBe(0);
    expect(detail.instalments.every((i: { status: string }) => i.status === 'PAID')).toBe(true);

    const released = await contractReleasePOST(makeRequest('POST', `/api/contracts/${contract.id}/release`, { token: admin }), makeParams({ id: contract.id }));
    expect(released.status).toBe(200);
    expect((await released.json()).contract.status).toBe('RELEASED');
    expect(await getItemStatus(itemId)).toBe('ISSUED');
  });

  it('SAVE_TO_OWN: customer can withdraw part of their savings, capped at what they saved, and reversing it restores the balance', async () => {
    const entry = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'SAVE_TO_OWN', termMonths: 6, depositAmountMinor: 0, totalPayableMinor: 240000 },
    }));
    expect(entry.status).toBe(201);

    const custId = await makeCustomer('Withdraw');
    const itemId = await receiveItem('W');
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId: custId, inventoryItemId: itemId, termMonths: 6 },
    }));
    const contract = (await created.json()).contract;

    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 100000, entryType: 'INSTALMENT_PAYMENT' },
    }));

    // Can't withdraw more than has actually been saved.
    const overWithdraw = await withdrawPOST(makeRequest('POST', '/api/payments/withdraw', {
      token: admin, body: { contractId: contract.id, amountMinor: 100001 },
    }));
    expect(overWithdraw.status).toBe(400);

    // A cashier (payment.cash.record only, no payment.reverse) can record money in but not pay it back out.
    const forbidden = await withdrawPOST(makeRequest('POST', '/api/payments/withdraw', {
      token: cashier, body: { contractId: contract.id, amountMinor: 10000 },
    }));
    expect(forbidden.status).toBe(403);

    const withdrawn = await withdrawPOST(makeRequest('POST', '/api/payments/withdraw', {
      token: admin, body: { contractId: contract.id, amountMinor: 30000 },
    }));
    expect(withdrawn.status).toBe(201);
    const withdrawal = (await withdrawn.json()).payment;
    expect(withdrawal.entryType).toBe('WITHDRAWAL');

    let detail = await getContract(contract.id, admin);
    expect(detail.totalPaidMinor).toBe(70000);
    expect(detail.balanceMinor).toBe(170000);

    // Reversing the withdrawal — same reversal mechanism as any other payment — restores it.
    const reversed = await paymentReversePOST(
      makeRequest('POST', `/api/payments/${withdrawal.id}/reverse`, { token: admin, body: { reason: 'test reversal' } }),
      makeParams({ id: withdrawal.id }),
    );
    expect(reversed.status).toBe(200);
    detail = await getContract(contract.id, admin);
    expect(detail.totalPaidMinor).toBe(100000);
    expect(detail.balanceMinor).toBe(140000);
  });

  it('withdrawals are only available on SAVE_TO_OWN contracts', async () => {
    const entry = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 6, depositAmountMinor: 60000, totalPayableMinor: 300000 },
    }));
    expect(entry.status).toBe(201);

    const custId = await makeCustomer('NoWithdraw');
    const itemId = await receiveItem('NW');
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEPOSIT_INSTALMENT', customerId: custId, inventoryItemId: itemId, termMonths: 6 },
    }));
    const contract = (await created.json()).contract;

    const res = await withdrawPOST(makeRequest('POST', '/api/payments/withdraw', {
      token: admin, body: { contractId: contract.id, amountMinor: 10000 },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/only available on save to own/i);
  });

  it('DEPOSIT_INSTALMENT: device withheld until deposit threshold is met (partial deposits accumulate)', async () => {
    const entry = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 6, depositAmountMinor: 60000, totalPayableMinor: 300000 },
    }));
    expect(entry.status).toBe(201);

    const custId = await makeCustomer('DepositInst');
    const itemId = await receiveItem('B');

    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEPOSIT_INSTALMENT', customerId: custId, inventoryItemId: itemId, termMonths: 6 },
    }));
    const contract = (await created.json()).contract;
    expect(contract.status).toBe('PENDING_DEPOSIT');
    expect(contract.depositAmountMinor).toBe(60000);
    expect(await getItemStatus(itemId)).toBe('RESERVED');

    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 30000, entryType: 'DEPOSIT' },
    }));
    let detail = await getContract(contract.id, cashier);
    expect(detail.status).toBe('PENDING_DEPOSIT');

    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 30000, entryType: 'DEPOSIT' },
    }));
    detail = await getContract(contract.id, cashier);
    expect(detail.status).toBe('ACTIVE');
    expect(detail.totalPaidMinor).toBe(60000);
    expect(detail.instalments[0].amountDueMinor).toBe(40000);
    expect(await getItemStatus(itemId)).toBe('ISSUED');
  });

  it('Payment idempotency + reversal: replay does not double-post, original row survives reversal', async () => {
    const entry = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 6, depositAmountMinor: 60000, totalPayableMinor: 300000 },
    }));
    expect(entry.status).toBe(201);
    const custId = await makeCustomer('Idempotency');
    const itemId = await receiveItem('IDEM');
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEPOSIT_INSTALMENT', customerId: custId, inventoryItemId: itemId, termMonths: 6 },
    }));
    const contract = (await created.json()).contract;
    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 60000, entryType: 'DEPOSIT' },
    }));

    const ref = `TEST-IDEMPOTENT-${runId}`;
    const first = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 40000, entryType: 'INSTALMENT_PAYMENT', transactionRef: ref },
    }));
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const paidAfterFirst = (await getContract(contract.id, cashier)).totalPaidMinor;

    const replay = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 40000, entryType: 'INSTALMENT_PAYMENT', transactionRef: ref },
    }));
    expect(replay.status).toBe(201);
    expect((await replay.json()).idempotentReplay).toBe(true);
    expect((await getContract(contract.id, cashier)).totalPaidMinor).toBe(paidAfterFirst);

    const paymentId = firstBody.payment.id;
    const reversed = await paymentReversePOST(
      makeRequest('POST', `/api/payments/${paymentId}/reverse`, { token: admin, body: { reason: 'test correction' } }),
      makeParams({ id: paymentId }),
    );
    expect(reversed.status).toBe(201);
    expect((await getContract(contract.id, cashier)).totalPaidMinor).toBe(paidAfterFirst - 40000);

    const paymentsRes = await paymentsGET(makeRequest('GET', `/api/payments?contractId=${contract.id}`, { token: cashier }));
    const originalRow = (await paymentsRes.json()).payments.find((p: { id: string }) => p.id === paymentId);
    expect(originalRow.status).toBe('SUCCESS'); // never mutated/deleted
    expect(originalRow.reversedById).not.toBeNull();

    const doubleReverse = await paymentReversePOST(
      makeRequest('POST', `/api/payments/${paymentId}/reverse`, { token: admin, body: { reason: 'again' } }),
      makeParams({ id: paymentId }),
    );
    expect(doubleReverse.status).toBe(400);
  });

  it('DEVICE_LOAN: flat interest matches the docs/02-loan-maths.md worked example exactly', async () => {
    // Created directly (not via the validated POST /api/price-chart route) since this
    // worked example is deliberately a 12-month term, outside the {3,4,6}-month admin
    // pricing tiers (priceChartService.validateEntryBody, matching the legacy hirepurchase
    // app's fixed ProductPricing tiers) — the test's real purpose is verifying flat-interest
    // schedule math against a documented example, not re-testing that validation.
    const adminUser = await prisma.user.findFirstOrThrow({ where: { email: 'admin@zple.test' } });
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEVICE_LOAN', termMonths: 12, depositAmountMinor: 0,
        totalPayableMinor: 248000, instalmentAmountMinor: Math.ceil(248000 / 12), interestRateBps: 2400,
        createdById: adminUser.id,
      },
    });

    const custId = await makeCustomer('DeviceLoan');

    // No inventoryItemId — DEVICE_LOAN disburses cash for the customer to buy a
    // device outside the store, so no stock unit is ever reserved/issued for it.
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId: custId, productId, termMonths: 12 },
    }));
    expect(created.status).toBe(201);
    const contract = (await created.json()).contract;
    expect(contract.status).toBe('ACTIVE'); // no down-payment gate
    expect(Math.abs(contract.principalMinor - 200000)).toBeLessThanOrEqual(1);
    expect(contract.totalPayableMinor).toBe(248000);
    expect(contract.inventoryItemId).toBeNull();

    const detail = await getContract(contract.id, cashier);
    const insts = detail.instalments;
    expect(insts).toHaveLength(12);
    expect(insts[0].interestPortionMinor).toBe(4000);
    expect(insts[0].principalPortionMinor).toBe(16667);
    expect(insts[11].interestPortionMinor).toBe(4000); // last absorbs remainder
    expect(insts[11].principalPortionMinor).toBe(16663);
    expect(insts.reduce((s: number, i: { amountDueMinor: number }) => s + i.amountDueMinor, 0)).toBe(248000);

    const settle = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 248000, entryType: 'INSTALMENT_PAYMENT' },
    }));
    expect(settle.status).toBe(201);
    const afterSettle = await getContract(contract.id, cashier);
    expect(afterSettle.status).toBe('COMPLETED');
    expect(afterSettle.balanceMinor).toBe(0);
  });

  it('rejects a DEVICE_LOAN contract with no productId — cash is disbursed against a priced product, not a stock unit', async () => {
    const custId = await makeCustomer('NoProductLoan');
    const res = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId: custId, termMonths: 6 },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/productId is required/i);
  });

  it('rejects a DEPOSIT_INSTALMENT contract with no inventoryItemId', async () => {
    const custId = await makeCustomer('NoItemDeposit');
    const res = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEPOSIT_INSTALMENT', customerId: custId, termMonths: 6 },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/inventoryItemId is required/i);
  });

  it('Overpayment is accepted and flagged as credit, not rejected', async () => {
    const custId = await makeCustomer('Overpay');
    const itemId = await receiveItem('D');
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId: custId, inventoryItemId: itemId, termMonths: 6 },
    }));
    const contract = (await created.json()).contract;

    const over = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 250000, entryType: 'INSTALMENT_PAYMENT' },
    }));
    expect(over.status).toBe(201);

    const detail = await getContract(contract.id, cashier);
    expect(detail.status).toBe('COMPLETED');
    expect(detail.creditMinor).toBe(10000);
  });

  it('RBAC: SALES cannot record cash payments (403), CASHIER can', async () => {
    const custId = await makeCustomer('RbacCheck');
    const itemId = await receiveItem('E');
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId: custId, inventoryItemId: itemId, termMonths: 6 },
    }));
    const contract = (await created.json()).contract;

    const forbidden = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: sales, body: { contractId: contract.id, amountMinor: 100, entryType: 'INSTALMENT_PAYMENT' },
    }));
    expect(forbidden.status).toBe(403);

    const allowed = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 100, entryType: 'INSTALMENT_PAYMENT' },
    }));
    expect(allowed.status).toBe(201);
  });
});
