/**
 * Coverage for the price chart pricing model matching the legacy hirepurchase
 * app's own ProductPricing structure (docs/01-plan.md): fixed 3/4/6-month
 * terms, and an admin-entered absolute deposit amount rather than a percentage.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as productsGET, POST as productsPOST } from '@/app/api/products/route';
import { GET as productGET, PATCH as productPATCH } from '@/app/api/products/[id]/route';
import { POST as priceChartPOST } from '@/app/api/price-chart/route';
import { POST as priceChartBundlePOST } from '@/app/api/price-chart/bundle/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { POST as inventoryPOST } from '@/app/api/inventory/route';
import { POST as contractsPOST } from '@/app/api/contracts/route';
import { GET as branchesGET } from '@/app/api/branches/route';

const PASSWORD = 'Passw0rd!123';
const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
function uniquePhone() {
  counter += 1;
  return `023${runId}${counter}`;
}

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  return (await res.json()).token as string;
}

describe('Price chart: legacy-matching pricing model', () => {
  let admin: string;
  let cashier: string;
  let branchId: string;
  let productId: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');
    cashier = await login('cashier@zple.test');
    branchId = (await (await branchesGET(makeRequest('GET', '/api/branches', { token: admin }))).json()).branches[0].id;

    const product = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { sku: `PC-SKU-${runId}`, name: 'Price Chart Test Phone', cashPriceMinor: 200000 },
    }));
    productId = (await product.json()).product.id;
  });

  it('rejects a term outside the fixed 3/4/6-month tiers', async () => {
    const res = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'SAVE_TO_OWN', termMonths: 5, depositAmountMinor: 0, totalPayableMinor: 200000 },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/termMonths must be one of/i);
  });

  it.each([3, 4, 6])('accepts a %i-month term', async (months) => {
    const res = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'SAVE_TO_OWN', termMonths: months, depositAmountMinor: 0, totalPayableMinor: 200000 },
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

  it('a contract snapshots the exact admin-entered absolute deposit amount, not a derived percentage', async () => {
    const entry = await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 4, depositAmountMinor: 75000, totalPayableMinor: 200000 },
    }));
    expect(entry.status).toBe(201);

    const customer = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { firstName: 'Price', lastName: 'Chart', phone: uniquePhone() },
    }));
    const customerId = (await customer.json()).customer.id;
    const item = await inventoryPOST(makeRequest('POST', '/api/inventory', {
      token: admin, body: { productId, serialNumber: `IMEI-PC-${runId}`, branchId },
    }));
    const inventoryItemId = (await item.json()).item.id;

    const contractRes = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId, termMonths: 4 },
    }));
    expect(contractRes.status).toBe(201);
    const contract = (await contractRes.json()).contract;
    expect(contract.depositAmountMinor).toBe(75000); // exact figure admin typed, no percentage math involved
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

  it('flags a freshly created product as missing pricing for all 3 contract types', async () => {
    const res = await productsGET(makeRequest('GET', '/api/products', { token: admin }));
    const { products } = await res.json();
    const product = products.find((p: { id: string }) => p.id === productId);
    expect(product.missingContractTypes.sort()).toEqual(['DEPOSIT_INSTALMENT', 'DEVICE_LOAN', 'SAVE_TO_OWN'].sort());
  });

  it('creates entries for multiple contract types atomically in one request', async () => {
    const res = await priceChartBundlePOST(makeRequest('POST', '/api/price-chart/bundle', {
      token: admin,
      body: {
        productId, termMonths: 6, paymentFrequency: 'MONTHLY',
        entries: {
          SAVE_TO_OWN: { totalPayableMinor: 300000 },
          DEPOSIT_INSTALMENT: { totalPayableMinor: 320000, depositAmountMinor: 60000 },
          DEVICE_LOAN: { totalPayableMinor: 350000, interestRateBps: 2400 },
        },
      },
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(Object.keys(body.entries).sort()).toEqual(['DEPOSIT_INSTALMENT', 'DEVICE_LOAN', 'SAVE_TO_OWN'].sort());

    const productRes = await productsGET(makeRequest('GET', '/api/products', { token: admin }));
    const { products } = await productRes.json();
    const product = products.find((p: { id: string }) => p.id === productId);
    expect(product.missingContractTypes).toEqual([]);
  });

  it('rejects a bundle where every submitted type is already priced for that exact combo', async () => {
    const res = await priceChartBundlePOST(makeRequest('POST', '/api/price-chart/bundle', {
      token: admin,
      body: { productId, termMonths: 6, paymentFrequency: 'MONTHLY', entries: { SAVE_TO_OWN: { totalPayableMinor: 310000 } } },
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
          SAVE_TO_OWN: { totalPayableMinor: 300000 },
          DEVICE_LOAN: { totalPayableMinor: -100 },
        },
      },
    }));
    expect(res.status).toBe(400);

    // the whole bundle rolled back — not even the valid SAVE_TO_OWN entry should exist
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

  it('creates the product plus DEPOSIT_INSTALMENT pricing for whichever terms were filled in, skipping blank ones', async () => {
    const res = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin,
      body: {
        name: `Bundled Pricing Phone ${runId}`, cashPriceMinor: 250000,
        termPricing: {
          3: { totalPayableMinor: 280000, depositAmountMinor: 50000 },
          // 4 deliberately left out — should be skipped, not defaulted
          6: { totalPayableMinor: 320000, depositAmountMinor: 40000 },
        },
      },
    }));
    expect(res.status).toBe(201);
    const { product } = await res.json();

    const entries = await prisma.priceChartEntry.findMany({ where: { productId: product.id }, orderBy: { termMonths: 'asc' } });
    expect(entries.map((e) => e.termMonths)).toEqual([3, 6]);
    expect(entries.every((e) => e.contractType === 'DEPOSIT_INSTALMENT')).toBe(true);
    expect(entries.find((e) => e.termMonths === 3)?.depositAmountMinor).toBe(50000);

    // Save-to-Own / Device Loan are untouched by this shortcut — still missing.
    const productsRes = await productsGET(makeRequest('GET', '/api/products', { token: admin }));
    const { products } = await productsRes.json();
    const listed = products.find((p: { id: string }) => p.id === product.id);
    expect(listed.missingContractTypes.sort()).toEqual(['DEVICE_LOAN', 'SAVE_TO_OWN']);
  });

  it('rejects the whole creation if any filled-in period is invalid, without creating the product at all', async () => {
    const name = `Should Not Exist Phone ${runId}`;
    const res = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin,
      body: {
        name, cashPriceMinor: 250000,
        termPricing: { 3: { totalPayableMinor: 100000, depositAmountMinor: 100000 } }, // deposit == total, invalid
      },
    }));
    expect(res.status).toBe(400);

    const existing = await prisma.product.findFirst({ where: { name } });
    expect(existing).toBeNull();
  });
});

describe('Product setup/edit can also close a Device Loan pricing gap', () => {
  let admin: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');
  });

  it('POST /api/products accepts a deviceLoanPricing bundle alongside termPricing', async () => {
    const res = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin,
      body: {
        name: `Device Loan At Creation ${runId}`, cashPriceMinor: 250000,
        termPricing: { 3: { totalPayableMinor: 280000, depositAmountMinor: 50000 } },
        deviceLoanPricing: { 6: { totalPayableMinor: 320000, interestRateBps: 2400 } },
      },
    }));
    expect(res.status).toBe(201);
    const { product } = await res.json();

    const entries = await prisma.priceChartEntry.findMany({ where: { productId: product.id }, orderBy: { termMonths: 'asc' } });
    expect(entries.map((e) => `${e.contractType}:${e.termMonths}`).sort()).toEqual(['DEPOSIT_INSTALMENT:3', 'DEVICE_LOAN:6'].sort());
    const loanEntry = entries.find((e) => e.contractType === 'DEVICE_LOAN');
    expect(loanEntry?.interestRateBps).toBe(2400);
    expect(loanEntry?.depositAmountMinor).toBe(0);

    const productsRes = await productsGET(makeRequest('GET', '/api/products', { token: admin }));
    const { products } = await productsRes.json();
    const listed = products.find((p: { id: string }) => p.id === product.id);
    expect(listed.missingContractTypes.sort()).toEqual(['SAVE_TO_OWN']);
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
      token: admin,
      body: {
        name: `Skip Already Priced Deposit ${runId}`, cashPriceMinor: 250000,
        termPricing: { 3: { totalPayableMinor: 280000, depositAmountMinor: 50000 } },
      },
    }));
    const productId = (await created.json()).product.id;
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
      token: admin,
      body: {
        name: `Skip Already Priced ${runId}`, cashPriceMinor: 250000,
        deviceLoanPricing: { 3: { totalPayableMinor: 300000, interestRateBps: 2000 } },
      },
    }));
    const productId = (await created.json()).product.id;
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
