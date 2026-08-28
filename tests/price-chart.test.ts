/**
 * Coverage for the price chart pricing model matching the legacy hirepurchase
 * app's own ProductPricing structure (docs/01-plan.md): fixed 3/4/6-month
 * terms, and an admin-entered absolute deposit amount rather than a percentage.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as productsGET, POST as productsPOST } from '@/app/api/products/route';
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
    admin = await login('admin@hplite.test');
    cashier = await login('cashier@hplite.test');
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
    admin = await login('admin@hplite.test');
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
