/**
 * Device Financing phones kept apart from other products: their own models
 * with plans, and their own stock by IMEI, enrolled with PayTrigger on receipt.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeRequest, makeParams } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as phonesGET, POST as phonesPOST } from '@/app/api/device-financing/phones/route';
import { PATCH as phonePATCH } from '@/app/api/device-financing/phones/[id]/route';
import { GET as stockGET, POST as stockPOST } from '@/app/api/device-financing/stock/route';
import { GET as productsGET } from '@/app/api/products/route';
import { hashPassword } from '@/lib/services/authService';
import { parseImeis } from '@/lib/services/phoneStockService';

const runId = Date.now().toString().slice(-7) + Math.floor(Math.random() * 100);
let counter = 0;
const unique = () => `${runId}${++counter}`;
const PASSWORD = 'Passw0rd!123';
const login = async (email: string) => (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }))).json()).token as string;
const imei = () => `35${unique().padStart(13, '0').slice(-13)}`;
const PLANS = [{ months: 3, totalPriceMinor: 228500, depositMinor: 32500 }, { months: 4, totalPriceMinor: 245500, depositMinor: 35000 }];
const saved = { key: process.env.PAYTRIGGER_API_KEY, dry: process.env.PAYTRIGGER_DRY_RUN };

describe('Device Financing phones and stock', () => {
  let admin: string;
  let branchId: string;

  beforeAll(async () => {
    process.env.PAYTRIGGER_API_KEY = 'test-paytrigger-key-0000000000000';
    process.env.PAYTRIGGER_DRY_RUN = 'true';
    admin = await login('admin@example.test');
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
  });
  afterAll(() => {
    if (saved.key === undefined) delete process.env.PAYTRIGGER_API_KEY; else process.env.PAYTRIGGER_API_KEY = saved.key;
    if (saved.dry === undefined) delete process.env.PAYTRIGGER_DRY_RUN; else process.env.PAYTRIGGER_DRY_RUN = saved.dry;
  });

  const newPhone = (body: Record<string, unknown>, token = admin) => phonesPOST(makeRequest('POST', '/api/device-financing/phones', { token, body: { brand: 'TECNO', cashPriceMinor: 200000, plans: PLANS, ...body } }));
  const receive = (body: Record<string, unknown>, token = admin) => stockPOST(makeRequest('POST', '/api/device-financing/stock', { token, body: { branchId, ...body } }));
  const stock = async (query: string, token = admin) => (await stockGET(makeRequest('GET', `/api/device-financing/stock?${query}`, { token }))).json();

  it('adds a phone model marked for PayTrigger with its plans, all at once, and refuses one that cannot be sold', async () => {
    const res = await newPhone({ name: `Tecno Pop 20 ${unique()}`, model: 'Pop 20' });
    expect(res.status).toBe(201);
    const { phone } = await res.json();
    expect(await prisma.payTriggerProduct.findUnique({ where: { productId: phone.id } })).toMatchObject({ brand: 'TECNO' });
    expect(await prisma.deviceFinancingPlan.count({ where: { productId: phone.id } })).toBe(2);

    expect((await newPhone({ name: `X ${unique()}`, brand: 'SAMSUNG' })).status).toBe(400);
    expect((await (await newPhone({ name: `X ${unique()}`, plans: [] })).json()).error).toMatch(/at least one plan/);
    expect((await (await newPhone({ name: `X ${unique()}`, plans: [{ months: 3, totalPriceMinor: 1000, depositMinor: 1000 }] })).json()).error).toMatch(/deposit must be less/);
    const same = await newPhone({ name: phone.name });
    expect((await same.json()).error).toMatch(/already exists/);
    // Prices are for those who price.
    expect((await newPhone({ name: `X ${unique()}` }, await login('storekeeper@example.test'))).status).toBe(403);
  });

  it('keeps phones off the ordinary product list, and lists them with their stock on their own', async () => {
    const { phone } = await (await newPhone({ name: `Infinix Smart ${unique()}`, brand: 'INFINIX' })).json();
    const regular = await (await productsGET(makeRequest('GET', '/api/products?financing=regular', { token: admin }))).json();
    expect(regular.products.some((p: { id: string }) => p.id === phone.id)).toBe(false);
    await receive({ productId: phone.id, imeis: [imei(), imei()] });
    const { phones } = await (await phonesGET(makeRequest('GET', '/api/device-financing/phones', { token: admin }))).json();
    expect(phones.find((p: { id: string }) => p.id === phone.id)).toMatchObject({ deviceFinancingBrand: 'INFINIX', stock: { total: 2, available: 2 } });
  });

  it('receives a batch by IMEI and enrols each, refusing the whole batch for one repeat or a bad IMEI', async () => {
    const { phone } = await (await newPhone({ name: `Tecno Spark ${unique()}` })).json();
    const a = imei(); const b = imei();
    expect(parseImeis(`${a}\n${a}, ${b}`)).toEqual({ imeis: [a, b], invalid: [] });

    const res = await receive({ productId: phone.id, imeis: `${a}\n${a}\n${b}`, description: '64 GB, 3 GB RAM' });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.received.map((r: { serialNumber: string }) => r.serialNumber).sort()).toEqual([a, b].sort());
    expect(body.enrolment.every((o: { ok: boolean; dryRun: boolean }) => o.ok && o.dryRun)).toBe(true);
    expect(await prisma.payTriggerDevice.count({ where: { imei: { in: [a, b] }, enrollmentStatus: 'QUEUED' } })).toBe(2);

    const c = imei();
    const repeat = await receive({ productId: phone.id, imeis: [c, a] });
    expect(repeat.status).toBe(409);
    expect(await repeat.json()).toMatchObject({ serials: [a] });
    const bad = await receive({ productId: phone.id, imeis: [c, '12345'] });
    expect((await bad.json()).error).toMatch(/Not a 15-digit IMEI: 12345/);
    expect(await prisma.inventoryItem.count({ where: { serialNumber: c } })).toBe(0); // nothing from either batch
  });

  it('can hand phones straight to an agent, who then sees only their own', async () => {
    const { phone } = await (await newPhone({ name: `itel A70 ${unique()}`, brand: 'ITEL' })).json();
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'AGENT' } });
    const agent = await prisma.user.create({ data: { email: `ps-agent-${unique()}@example.test`, passwordHash: await hashPassword(PASSWORD), firstName: 'Stock', lastName: 'Agent', roleId: role.id, branchId } });
    const mine = imei();
    await receive({ productId: phone.id, imeis: [mine], agentId: agent.id });
    await receive({ productId: phone.id, imeis: [imei()] });
    const seen = await stock(`productId=${phone.id}`, await login(agent.email));
    expect(seen.items.map((i: { serialNumber: string }) => i.serialNumber)).toEqual([mine]);
    expect(seen.items[0]).toMatchObject({ assignedAgent: { id: agent.id }, device: { enrollmentStatus: 'QUEUED' } });
  });

  it('finds phones not enrolled, and refuses stock for a model no longer sold', async () => {
    const { phone } = await (await newPhone({ name: `Tecno Camon ${unique()}` })).json();
    const enrolled = imei();
    await receive({ productId: phone.id, imeis: [enrolled] });
    const item = await prisma.inventoryItem.create({ data: { productId: phone.id, branchId, serialNumber: imei() } });
    const notEnrolled = await stock(`productId=${phone.id}&enrolment=NOT_ENROLLED`);
    expect(notEnrolled.items.map((i: { id: string }) => i.id)).toEqual([item.id]);
    expect((await stock(`productId=${phone.id}&enrolment=ENROLLED`)).items.map((i: { serialNumber: string }) => i.serialNumber)).toEqual([enrolled]);

    expect((await phonePATCH(makeRequest('PATCH', `/api/device-financing/phones/${phone.id}`, { token: admin, body: { isActive: false } }), makeParams({ id: phone.id }))).status).toBe(200);
    const refused = await receive({ productId: phone.id, imeis: [imei()] });
    expect((await refused.json()).error).toMatch(/no longer sold/);
  });
});
