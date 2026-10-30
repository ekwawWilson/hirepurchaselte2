/**
 * Device Financing phones are kept apart from every other product: marked on
 * the product form, badged and filterable on the product, inventory and
 * price chart lists, and a mark is changed or removed only by an admin.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { prisma } from '@/lib/db/prisma';
import { makeRequest, makeParams } from './helpers';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as productsGET, POST as productsPOST } from '@/app/api/products/route';
import { GET as productGET, PATCH as productPATCH } from '@/app/api/products/[id]/route';
import { GET as inventoryGET } from '@/app/api/inventory/route';
import { suggestDeviceFinancingBrand } from '@/lib/constants/deviceFinancing';

const runId = Date.now().toString().slice(-7) + Math.floor(Math.random() * 100);
const login = async (email: string) =>
  (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!123' } }))).json()).token as string;

describe('Device Financing products', () => {
  let admin: string;
  let storeKeeper: string;
  let branchId: string;

  beforeAll(async () => {
    [admin, storeKeeper] = await Promise.all([login('admin@example.test'), login('storekeeper@example.test')]);
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
  });

  async function create(token: string, name: string, deviceFinancingBrand?: unknown) {
    return productsPOST(makeRequest('POST', '/api/products', { token, body: { name, cashPriceMinor: 150000, ...(deviceFinancingBrand !== undefined && { deviceFinancingBrand }) } }));
  }
  const patch = (token: string, id: string, body: unknown) => productPATCH(makeRequest('PATCH', `/api/products/${id}`, { token, body }), makeParams({ id }));
  const brandOf = async (id: string) => (await (await productGET(makeRequest('GET', `/api/products/${id}`, { token: admin }), makeParams({ id }))).json()).product.deviceFinancingBrand;

  it('is marked on the product form, and the lists can show only it or only regular products', async () => {
    const phone = (await (await create(storeKeeper, `TECNO Spark ${runId}`, 'TECNO')).json()).product;
    const laptop = (await (await create(storeKeeper, `HP Laptop ${runId}`)).json()).product;
    expect(phone.deviceFinancingBrand).toBe('TECNO');
    expect(await brandOf(phone.id)).toBe('TECNO');
    expect(await brandOf(laptop.id)).toBeNull();

    const list = async (financing: string) =>
      ((await (await productsGET(makeRequest('GET', `/api/products?financing=${financing}&q=${runId}`, { token: admin }))).json()).products as { id: string }[]).map((p) => p.id);
    expect(await list('device')).toEqual([phone.id]);
    expect(await list('regular')).toEqual([laptop.id]);

    await prisma.inventoryItem.createMany({ data: [
      { productId: phone.id, branchId, serialNumber: `DF-${runId}-1` },
      { productId: laptop.id, branchId, serialNumber: `DF-${runId}-2` },
    ] });
    const units = async (financing: string) =>
      ((await (await inventoryGET(makeRequest('GET', `/api/inventory?financing=${financing}&q=DF-${runId}`, { token: admin }))).json()).items as { serialNumber: string; product: { deviceFinancingBrand: string | null } }[]);
    expect((await units('device')).map((i) => [i.serialNumber, i.product.deviceFinancingBrand])).toEqual([[`DF-${runId}-1`, 'TECNO']]);
    expect((await units('regular')).map((i) => i.serialNumber)).toEqual([`DF-${runId}-2`]);
  });

  it('refuses a brand that is not TECNO, Infinix or itel', async () => {
    const res = await create(admin, `Samsung A06 ${runId}`, 'SAMSUNG');
    expect(res.status).toBe(400);
  });

  it('may be added by whoever adds products, but changed or removed only by an admin', async () => {
    const id = (await (await create(storeKeeper, `itel A70 ${runId}`)).json()).product.id;
    expect((await patch(storeKeeper, id, { deviceFinancingBrand: 'ITEL' })).status).toBe(200);
    expect(await brandOf(id)).toBe('ITEL');

    const refused = await patch(storeKeeper, id, { deviceFinancingBrand: null });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toMatch(/Only an admin/);
    expect((await patch(storeKeeper, id, { deviceFinancingBrand: 'TECNO' })).status).toBe(400);
    expect(await brandOf(id)).toBe('ITEL');

    // Saving the form unchanged is not a change.
    expect((await patch(storeKeeper, id, { deviceFinancingBrand: 'ITEL', name: `itel A70 ${runId} 64GB` })).status).toBe(200);

    expect((await patch(admin, id, { deviceFinancingBrand: null })).status).toBe(200);
    expect(await brandOf(id)).toBeNull();
  });

  it('suggests the brand from the name, without marking anything', () => {
    expect(suggestDeviceFinancingBrand('Infinix Hot 40')).toBe('INFINIX');
    expect(suggestDeviceFinancingBrand('Samsung A06')).toBeNull();
    expect(suggestDeviceFinancingBrand('Bitelli kettle')).toBeNull();
  });
});
