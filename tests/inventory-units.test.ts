/**
 * Stock in three levels — category (Laptops) > product (HP Laptop) > unit,
 * with the unit's own model (HP Envy) and specification — and that wording
 * reaching the contract the unit is sold on.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, freshPhone } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as inventoryGET, POST as inventoryPOST } from '@/app/api/inventory/route';
import { PATCH as inventoryPATCH } from '@/app/api/inventory/[id]/route';
import { GET as contractGET } from '@/app/api/contracts/[id]/route';
import { createContract } from '@/lib/services/contractService';
import { unitTitle } from '@/lib/unitLabel';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
const login = async (email: string) =>
  (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!123' } }))).json()).token as string;

beforeAll(enableOptionalContractTypes);

describe('Stock units: category, product, model and specification', () => {
  let admin: string;
  let cashier: string;
  let branchId: string;
  let productId: string;

  beforeAll(async () => {
    admin = await login('admin@example.test');
    cashier = await login('cashier@example.test');
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    const laptops = await prisma.productCategory.create({ data: { name: `Laptops ${runId}` } });
    productId = (await prisma.product.create({ data: { sku: `HPL-${runId}`, name: 'HP Laptop', categoryId: laptops.id, cashPriceMinor: 450000 } })).id;
  });

  const receive = (body: Record<string, unknown>, token = admin) =>
    inventoryPOST(makeRequest('POST', '/api/inventory', { token, body: { productId, branchId, ...body } }));
  const search = async (q: string) =>
    ((await (await inventoryGET(makeRequest('GET', `/api/inventory?q=${encodeURIComponent(q)}`, { token: admin }))).json()).items as { id: string }[]).map((i) => i.id);

  it('receives a unit with its own model and specification, and finds it by either', async () => {
    const res = await receive({ serialNumber: ` ENVY-${runId} `, name: ' HP Envy ', description: '15" screen, 200 GB HDD, 6 GB RAM' });
    expect(res.status).toBe(201);
    const { item } = await res.json();
    expect(item).toMatchObject({ serialNumber: `ENVY-${runId}`, name: 'HP Envy', description: '15" screen, 200 GB HDD, 6 GB RAM', status: 'AVAILABLE' });

    expect(await search(`envy ENVY-${runId}`)).toEqual([item.id]);
    expect(await search(`6 GB RAM ENVY-${runId}`)).toEqual([item.id]);
    expect(await search(`laptops ${runId} envy`)).toContain(item.id);

    expect((await receive({ serialNumber: `ENVY-${runId}`, name: 'HP Envy' })).status).toBe(409); // serials are unique
    expect((await receive({ productId: 'no-such-product', serialNumber: `X-${runId}` })).status).toBe(400);
    expect((await receive({ serialNumber: `C-${runId}` }, cashier)).status).toBe(403);
  });

  it('a unit received without a model can be given one later, by someone who handles stock', async () => {
    const { item } = await (await receive({ serialNumber: `OLD-${runId}` })).json();
    expect(item.name).toBeNull();
    const patch = (body: Record<string, unknown>, token = admin) =>
      inventoryPATCH(makeRequest('PATCH', `/api/inventory/${item.id}`, { token, body }), makeParams({ id: item.id }));

    expect((await patch({ name: 'HP Pavilion' }, cashier)).status).toBe(403);
    const res = await patch({ name: 'HP Pavilion', description: '14" screen, 512 GB SSD, 8 GB RAM' });
    expect(res.status).toBe(200);
    expect((await res.json()).item).toMatchObject({ name: 'HP Pavilion', description: '14" screen, 512 GB SSD, 8 GB RAM', serialNumber: `OLD-${runId}` });
    // Only what was sent changes; an empty value clears it.
    expect((await (await patch({ description: '' })).json()).item).toMatchObject({ name: 'HP Pavilion', description: null });
    expect(await prisma.auditLog.count({ where: { action: 'INVENTORY_ITEM_UPDATE', entityId: item.id } })).toBe(2);
  });

  it('the contract a unit is sold on carries its model and specification', async () => {
    const { item } = await (await receive({ serialNumber: `SOLD-${runId}`, name: 'HP Envy', description: '15" screen, 200 GB HDD, 6 GB RAM' })).json();
    const adminId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
    const customer = await prisma.customer.create({
      data: { membershipId: `UNIT-${runId}`, firstName: 'Ama', lastName: 'Buyer', phone: await freshPhone(), branchId, createdById: adminId },
    });
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item.id, branchId, createdById: adminId,
      totalPayableMinor: 480000, depositAmountMinor: 96000, termWeeks: 12, paymentFrequency: 'WEEKLY',
    });
    const shown = (await (await contractGET(makeRequest('GET', `/api/contracts/${contract.id}`, { token: admin }), makeParams({ id: contract.id }))).json()).contract;
    expect(shown.product.name).toBe('HP Laptop');
    expect(shown.inventoryItem).toMatchObject({ name: 'HP Envy', description: '15" screen, 200 GB HDD, 6 GB RAM', serialNumber: `SOLD-${runId}` });
    expect(unitTitle(shown.product.name, shown.inventoryItem.name)).toBe('HP Laptop — HP Envy');
  });

  it('names a unit by its product, then its model — never twice', () => {
    expect(unitTitle('HP Laptop', 'HP Envy')).toBe('HP Laptop — HP Envy');
    expect(unitTitle('HP Laptop', null)).toBe('HP Laptop');
    expect(unitTitle('HP Laptop', ' hp laptop ')).toBe('HP Laptop');
  });
});
