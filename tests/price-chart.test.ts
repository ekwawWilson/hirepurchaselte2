/**
 * Coverage for the price chart pricing model matching the legacy hirepurchase
 * app's own ProductPricing structure (docs/01-plan.md): fixed 3/4/6-month
 * terms, and an admin-entered absolute deposit amount rather than a percentage.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as productsPOST } from '@/app/api/products/route';
import { GET as productGET, PATCH as productPATCH } from '@/app/api/products/[id]/route';
import { POST as priceChartPOST } from '@/app/api/price-chart/route';
import { POST as priceChartBundlePOST } from '@/app/api/price-chart/bundle/route';
const PASSWORD = 'Passw0rd!123';
const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  return (await res.json()).token as string;
}

describe('Price chart: legacy-matching pricing model', () => {
  let admin: string;
  let productId: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');

    const product = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { sku: `PC-SKU-${runId}`, name: 'Price Chart Test Phone', cashPriceMinor: 200000 },
    }));
    productId = (await product.json()).product.id;
  });

  it('rejects a term outside the fixed 3/4/6-month tiers', async () => {
    const res = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 5, depositAmountMinor: 0, totalPayableMinor: 200000 },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/termMonths must be one of/i);
  });

  it('rejects SAVE_TO_OWN outright — it has no payment terms to price at all', async () => {
    const res = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'SAVE_TO_OWN', termMonths: 6, depositAmountMinor: 0, totalPayableMinor: 200000 },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no payment terms to price/i);
  });

  it.each([3, 4, 6])('accepts a %i-month term', async (months) => {
    const res = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: months, depositAmountMinor: 0, totalPayableMinor: 200000 },
    }));
    expect(res.status).toBe(201);
  });

  it('rejects a deposit amount that is not less than the total payable', async () => {
    const res = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 6, depositAmountMinor: 200000, totalPayableMinor: 200000 },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/less than totalPayableMinor/i);
  });

  // The standalone Price Chart page/entries are legacy-only now — no contract
  // type reads a PriceChartEntry at creation any more (contractService.ts).
  // DEPOSIT_INSTALMENT's total/deposit/term are entered directly at contract
  // creation instead — covered by tests/contracts-and-payments.test.ts and
  // tests/payment-frequency.test.ts, not here.
  it('editing a price (resubmitting the same product/type/term/frequency) supersedes the old entry — a Price Chart page mechanic, independent of contract creation', async () => {
    const entry = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 3, depositAmountMinor: 50000, totalPayableMinor: 200000 },
    }));
    expect(entry.status).toBe(201);
    const original = (await entry.json()).entry;

    const reprice = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 3, depositAmountMinor: 60000, totalPayableMinor: 240000 },
    }));
    expect(reprice.status).toBe(201);
    const repriced = (await reprice.json()).entry;
    expect(repriced.id).not.toBe(original.id);
    expect(repriced.totalPayableMinor).toBe(240000);

    const supersededOriginal = await prisma.priceChartEntry.findUniqueOrThrow({ where: { id: original.id } });
    expect(supersededOriginal.effectiveTo).not.toBeNull();
  });
});

describe('Price chart: bundle creation across all contract types', () => {
  let admin: string;
  let productId: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');
    const product = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { sku: `PCB-SKU-${runId}`, name: 'Bundle Test Phone', cashPriceMinor: 300000 },
    }));
    productId = (await product.json()).product.id;
  });

  it('a freshly created product has no price chart entries yet', async () => {
    const res = await productGET(makeRequest('GET', `/api/products/${productId}`, { token: admin }), makeParams({ id: productId }));
    const { product } = await res.json();
    expect(product.priceChartEntries).toEqual([]);
  });

  it('creates entries for multiple contract types atomically in one request', async () => {
    const res = await priceChartBundlePOST(makeRequest('POST', '/api/price-chart/bundle', {
      token: admin,
      body: {
        productId, termMonths: 6, paymentFrequency: 'MONTHLY',
        entries: {
          DEPOSIT_INSTALMENT: { totalPayableMinor: 320000, depositAmountMinor: 60000 },
          DEVICE_LOAN: { totalPayableMinor: 350000, interestRateBps: 2400 },
        },
      },
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body.entries).sort()).toEqual(['DEPOSIT_INSTALMENT', 'DEVICE_LOAN'].sort());

    const productRes = await productGET(makeRequest('GET', `/api/products/${productId}`, { token: admin }), makeParams({ id: productId }));
    const { product } = await productRes.json();
    expect(product.priceChartEntries.map((e: { contractType: string }) => e.contractType).sort()).toEqual(['DEPOSIT_INSTALMENT', 'DEVICE_LOAN'].sort());
  });

  it('rejects a bundle where every submitted type is already priced for that exact combo', async () => {
    const res = await priceChartBundlePOST(makeRequest('POST', '/api/price-chart/bundle', {
      token: admin,
      body: { productId, termMonths: 6, paymentFrequency: 'MONTHLY', entries: { DEPOSIT_INSTALMENT: { totalPayableMinor: 310000, depositAmountMinor: 50000 } } },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/already has active pricing/i);
  });

  it('rejects an invalid entry inside a bundle without creating any of the others', async () => {
    const res = await priceChartBundlePOST(makeRequest('POST', '/api/price-chart/bundle', {
      token: admin,
      body: {
        productId, termMonths: 4, paymentFrequency: 'MONTHLY',
        entries: {
          DEPOSIT_INSTALMENT: { totalPayableMinor: 300000, depositAmountMinor: 50000 },
          DEVICE_LOAN: { totalPayableMinor: -100 },
        },
      },
    }));
    expect(res.status).toBe(400);

    // the whole bundle rolled back — not even the valid DEPOSIT_INSTALMENT entry should exist
    const fourMonthEntries = await prisma.priceChartEntry.findMany({ where: { productId, termMonths: 4 } });
    expect(fourMonthEntries).toEqual([]);
  });
});

describe('Product creation: SKU auto-generation and the term-pricing shortcut', () => {
  let admin: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');
  });

  it('auto-generates a SKU when none is supplied', async () => {
    const res = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { name: `Auto SKU Phone ${runId}`, cashPriceMinor: 150000 },
    }));
    expect(res.status).toBe(201);
    const { product } = await res.json();
    expect(product.sku).toMatch(/^PRD-\d{4}-\d{6}$/);
  });

  it('still honours an explicitly supplied SKU, and rejects a duplicate', async () => {
    const sku = `EXPLICIT-SKU-${runId}`;
    const first = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { sku, name: 'Explicit SKU Phone', cashPriceMinor: 150000 },
    }));
    expect(first.status).toBe(201);

    const dupe = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { sku, name: 'Explicit SKU Phone Again', cashPriceMinor: 150000 },
    }));
    expect(dupe.status).toBe(409);
  });

  it('creates just the base-price product — a termPricing payload from an old client is silently ignored, not parsed into pricing tiers', async () => {
    const res = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin,
      body: {
        name: `No Tier Pricing Phone ${runId}`, cashPriceMinor: 250000,
        // Deal terms are entered per contract now, never at product creation
        // (contractService.ts) — a stale client still sending this shape must
        // not resurrect the old bundle-parsing behavior, even one shaped to
        // fail the old validator (deposit == total would have been rejected).
        termPricing: { 3: { totalPayableMinor: 100000, depositAmountMinor: 100000 } },
      },
    }));
    expect(res.status).toBe(201);
    const { product } = await res.json();
    expect(product.cashPriceMinor).toBe(250000);

    const entries = await prisma.priceChartEntry.findMany({ where: { productId: product.id } });
    expect(entries).toEqual([]);
  });
});

describe('Product setup/edit can also close a Device Loan pricing gap', () => {
  let admin: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');
  });

  it('PATCH /api/products/[id] adds missing Deposit + Instalment pricing without touching existing entries', async () => {
    const created = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin,
      body: { name: `Fix Missing Deposit Instalment ${runId}`, cashPriceMinor: 250000 },
    }));
    const productId = (await created.json()).product.id;

    const before = await productGET(makeRequest('GET', `/api/products/${productId}`, { token: admin }), makeParams({ id: productId }));
    expect((await before.json()).product.priceChartEntries).toEqual([]);

    const patched = await productPATCH(
      makeRequest('PATCH', `/api/products/${productId}`, {
        token: admin,
        body: { termPricing: { 3: { totalPayableMinor: 280000, depositAmountMinor: 50000 }, 6: { totalPayableMinor: 320000, depositAmountMinor: 50000 } } },
      }),
      makeParams({ id: productId }),
    );
    expect(patched.status).toBe(200);

    const after = await productGET(makeRequest('GET', `/api/products/${productId}`, { token: admin }), makeParams({ id: productId }));
    const entries = (await after.json()).product.priceChartEntries;
    expect(entries).toHaveLength(2);
    expect(entries.every((e: { contractType: string }) => e.contractType === 'DEPOSIT_INSTALMENT')).toBe(true);
  });

  it('a re-submitted PATCH does not version-out (overwrite) an already-priced Deposit + Instalment term', async () => {
    const created = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { name: `Skip Already Priced Deposit ${runId}`, cashPriceMinor: 250000 },
    }));
    const productId = (await created.json()).product.id;
    await productPATCH(
      makeRequest('PATCH', `/api/products/${productId}`, {
        token: admin, body: { termPricing: { 3: { totalPayableMinor: 280000, depositAmountMinor: 50000 } } },
      }),
      makeParams({ id: productId }),
    );
    const original = await prisma.priceChartEntry.findFirstOrThrow({ where: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 3 } });

    // Resubmit the same 3-month term (already priced) plus a genuinely new 6-month term.
    const patched = await productPATCH(
      makeRequest('PATCH', `/api/products/${productId}`, {
        token: admin,
        body: { termPricing: { 3: { totalPayableMinor: 999999, depositAmountMinor: 1 }, 6: { totalPayableMinor: 320000, depositAmountMinor: 50000 } } },
      }),
      makeParams({ id: productId }),
    );
    expect(patched.status).toBe(200);

    const stillOriginal = await prisma.priceChartEntry.findUniqueOrThrow({ where: { id: original.id } });
    expect(stillOriginal.effectiveTo).toBeNull(); // never superseded
    expect(stillOriginal.totalPayableMinor).toBe(280000); // untouched, not overwritten with 999999

    const sixMonth = await prisma.priceChartEntry.findFirst({ where: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 6 } });
    expect(sixMonth?.totalPayableMinor).toBe(320000); // the genuinely-new term was still created
  });

  it('PATCH /api/products/[id] adds missing Device Loan pricing without touching existing entries', async () => {
    const created = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin,
      body: { name: `Fix Missing Device Loan ${runId}`, cashPriceMinor: 250000 },
    }));
    const productId = (await created.json()).product.id;

    const before = await productGET(makeRequest('GET', `/api/products/${productId}`, { token: admin }), makeParams({ id: productId }));
    expect((await before.json()).product.priceChartEntries).toEqual([]);

    const patched = await productPATCH(
      makeRequest('PATCH', `/api/products/${productId}`, {
        token: admin,
        body: { deviceLoanPricing: { 3: { totalPayableMinor: 300000, interestRateBps: 2000 }, 6: { totalPayableMinor: 340000, interestRateBps: 2000 } } },
      }),
      makeParams({ id: productId }),
    );
    expect(patched.status).toBe(200);

    const after = await productGET(makeRequest('GET', `/api/products/${productId}`, { token: admin }), makeParams({ id: productId }));
    const entries = (await after.json()).product.priceChartEntries;
    expect(entries).toHaveLength(2);
    expect(entries.every((e: { contractType: string }) => e.contractType === 'DEVICE_LOAN')).toBe(true);
  });

  it('a re-submitted PATCH does not version-out (overwrite) an already-priced Device Loan term', async () => {
    const created = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { name: `Skip Already Priced ${runId}`, cashPriceMinor: 250000 },
    }));
    const productId = (await created.json()).product.id;
    await productPATCH(
      makeRequest('PATCH', `/api/products/${productId}`, {
        token: admin, body: { deviceLoanPricing: { 3: { totalPayableMinor: 300000, interestRateBps: 2000 } } },
      }),
      makeParams({ id: productId }),
    );
    const original = await prisma.priceChartEntry.findFirstOrThrow({ where: { productId, contractType: 'DEVICE_LOAN', termMonths: 3 } });

    // Resubmit the same 3-month term (already priced) plus a genuinely new 6-month term.
    const patched = await productPATCH(
      makeRequest('PATCH', `/api/products/${productId}`, {
        token: admin,
        body: { deviceLoanPricing: { 3: { totalPayableMinor: 999999, interestRateBps: 5000 }, 6: { totalPayableMinor: 340000, interestRateBps: 2000 } } },
      }),
      makeParams({ id: productId }),
    );
    expect(patched.status).toBe(200);

    const stillOriginal = await prisma.priceChartEntry.findUniqueOrThrow({ where: { id: original.id } });
    expect(stillOriginal.effectiveTo).toBeNull(); // never superseded
    expect(stillOriginal.totalPayableMinor).toBe(300000); // untouched, not overwritten with 999999

    const sixMonth = await prisma.priceChartEntry.findFirst({ where: { productId, contractType: 'DEVICE_LOAN', termMonths: 6 } });
    expect(sixMonth?.totalPayableMinor).toBe(340000); // the genuinely-new term was still created
  });
});
