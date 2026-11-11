/**
 * Device Financing phones are sold on their price plans: one per length in
 * months, each a total price and a deposit, checked on the server, and a
 * sale's figures come from the plan unless the seller may override them.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, freshPhone } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as contractsPOST } from '@/app/api/contracts/route';
import { POST as preflightPOST } from '@/app/api/contracts/preflight/route';
import { POST as resubmitPOST } from '@/app/api/contracts/[id]/resubmit/route';
import { GET as plansGET, PATCH as plansPATCH } from '@/app/api/products/[id]/plans/route';
import { GET as priceListGET } from '@/app/api/price-chart/device-financing/route';
import { setProductBrand } from '@/lib/paytrigger/admin';
import { requestContractRevision } from '@/lib/services/contractService';
import { applyLatePenalties } from '@/lib/services/overdueService';
import { hashPassword } from '@/lib/services/authService';

const runId = Date.now().toString().slice(-7) + Math.floor(Math.random() * 100);
let counter = 0;
const unique = () => `${runId}${++counter}`;
const PASSWORD = 'Passw0rd!123';
const login = async (email: string) => (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }))).json()).token as string;
const PLANS = [
  { months: 3, totalPriceMinor: 228500, depositMinor: 32500 },
  { months: 4, totalPriceMinor: 245500, depositMinor: 35000 },
  { months: 5, totalPriceMinor: 265000, depositMinor: 40000 },
];

describe('Device Financing plans', () => {
  let branchId: string;
  let adminId: string;
  let admin: string;

  beforeAll(async () => {
    await enableOptionalContractTypes();
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
    admin = await login('admin@example.test');
  });

  async function phoneModel(mark = true) {
    const product = await prisma.product.create({ data: { sku: `DFP-${unique()}`, name: 'Tecno Pop 20', brand: 'TECNO', cashPriceMinor: 200000 } });
    if (mark) await setProductBrand(product.id, 'TECNO', adminId);
    return product;
  }
  const savePlans = (productId: string, plans: unknown[], token = admin) =>
    plansPATCH(makeRequest('PATCH', `/api/products/${productId}/plans`, { token, body: { plans } }), makeParams({ id: productId }));

  /** A phone of this model in stock, enrolled, for this seller. */
  async function unit(productId: string, agentId?: string) {
    const imei = `35${unique().padStart(13, '0').slice(-13)}`;
    const item = await prisma.inventoryItem.create({ data: { productId, branchId, serialNumber: imei, assignedAgentId: agentId ?? null } });
    await prisma.payTriggerDevice.create({ data: { inventoryItemId: item.id, imei, enrollmentStatus: 'QUEUED' } });
    return item;
  }
  const customer = async () => prisma.customer.create({ data: { membershipId: `DFP-${unique()}`, firstName: 'Ama', lastName: 'Plan', phone: await freshPhone(), branchId, createdById: adminId } });

  async function makeAgent() {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'AGENT' } });
    const user = await prisma.user.create({ data: { email: `dfp-agent-${unique()}@example.test`, passwordHash: await hashPassword(PASSWORD), firstName: 'Plan', lastName: 'Agent', roleId: role.id, branchId } });
    return { user, token: await login(user.email) };
  }
  const sell = (token: string, body: Record<string, unknown>) => contractsPOST(makeRequest('POST', '/api/contracts', { token, body: { contractType: 'DEVICE_FINANCING', paymentFrequency: 'DAILY', branchId, ...body } }));

  it('saves a phone\'s plans, refusing figures that cannot be sold, and removes a plan left out', async () => {
    const product = await phoneModel();
    expect((await savePlans(product.id, PLANS)).status).toBe(200);
    const listed = await (await plansGET(makeRequest('GET', `/api/products/${product.id}/plans`, { token: admin }), makeParams({ id: product.id }))).json();
    expect(listed.plans.map((p: { months: number }) => p.months)).toEqual([3, 4, 5]);

    const refused = async (plans: unknown[], message: RegExp) => {
      const res = await savePlans(product.id, plans);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(message);
    };
    await refused([{ months: 3, totalPriceMinor: 30000, depositMinor: 30000 }], /deposit must be less than its total price/);
    await refused([{ months: 3, totalPriceMinor: 0, depositMinor: 0 }], /total price above 0/);
    await refused([{ months: 13, totalPriceMinor: 30000, depositMinor: 1000 }], /1 to 12 months/);
    await refused([{ months: 3, totalPriceMinor: 30000, depositMinor: 1000 }, { months: 3, totalPriceMinor: 31000, depositMinor: 1000 }], /given twice/);
    await refused([{ months: 3, totalPriceMinor: 30000, depositMinor: 1000 }, { months: 4, totalPriceMinor: 29000, depositMinor: 1000 }], /cannot cost less/);

    expect((await savePlans(product.id, PLANS.slice(0, 2))).status).toBe(200);
    expect(await prisma.deviceFinancingPlan.count({ where: { productId: product.id } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { entityId: product.id, action: 'DEVICE_FINANCING_PLANS_UPDATE' } })).toBe(2);
  });

  it('gives plans only to Device Financing phones, and only those who price may set them', async () => {
    const plain = await phoneModel(false);
    const res = await savePlans(plain.id, PLANS);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Mark this product as a Device Financing phone/);
    const product = await phoneModel();
    expect((await savePlans(product.id, PLANS, await login('cashier@example.test'))).status).toBe(403);
  });

  it('sells at the plan\'s figures: months × 30 daily or × 4 weekly, with no grace period', async () => {
    const product = await phoneModel();
    await savePlans(product.id, PLANS);
    const res = await sell(admin, { customerId: (await customer()).id, inventoryItemId: (await unit(product.id)).id, planMonths: 3 });
    expect(res.status).toBe(201);
    const { contract } = await res.json();
    expect(contract).toMatchObject({ totalPayableMinor: 228500, depositAmountMinor: 32500, termMonths: 3, gracePeriodDays: 0 });
    const instalments = await prisma.instalment.findMany({ where: { contractId: contract.id }, orderBy: { instalmentNo: 'asc' } });
    expect(instalments).toHaveLength(90);
    expect(instalments[0].amountDueMinor).toBe(2178); // GHS 1,960 over 90 days, rounded up
    expect(instalments.reduce((s, i) => s + i.amountDueMinor, 0)).toBe(196000); // the last one takes what is left

    const weekly = await sell(admin, { customerId: (await customer()).id, inventoryItemId: (await unit(product.id)).id, planMonths: 4, paymentFrequency: 'WEEKLY' });
    expect(await prisma.instalment.count({ where: { contractId: (await weekly.json()).contract.id } })).toBe(16);
  });

  it('refuses a sale with no plan chosen, a plan the phone is not sold on, or a phone with no plans', async () => {
    const product = await phoneModel();
    await savePlans(product.id, PLANS);
    const noPlan = await sell(admin, { customerId: (await customer()).id, inventoryItemId: (await unit(product.id)).id });
    expect(noPlan.status).toBe(400);
    const wrong = await sell(admin, { customerId: (await customer()).id, inventoryItemId: (await unit(product.id)).id, planMonths: 6 });
    expect((await wrong.json()).error).toMatch(/no 6-month plan\. It is sold on 3, 4, 5 months/);
    const bare = await phoneModel();
    const none = await sell(admin, { customerId: (await customer()).id, inventoryItemId: (await unit(bare.id)).id, planMonths: 3 });
    expect((await none.json()).error).toMatch(/no price plans yet/);
  });

  it('an agent cannot change the plan\'s price or deposit; an administrator can', async () => {
    const product = await phoneModel();
    await savePlans(product.id, PLANS);
    const agent = await makeAgent();
    const cheaper = await sell(agent.token, { customerId: (await customer()).id, inventoryItemId: (await unit(product.id, agent.user.id)).id, planMonths: 3, totalPayableMinor: 200000, depositAmountMinor: 32500 });
    expect(cheaper.status).toBe(400);
    expect((await cheaper.json()).error).toMatch(/come from the 3-month plan: GHS 2285\.00 with a GHS 325\.00 deposit/);
    const asPlanned = await sell(agent.token, { customerId: (await customer()).id, inventoryItemId: (await unit(product.id, agent.user.id)).id, planMonths: 3 });
    expect(asPlanned.status).toBe(201);
    expect((await asPlanned.json()).contract).toMatchObject({ status: 'PENDING_APPROVAL', totalPayableMinor: 228500 });

    const overridden = await sell(admin, { customerId: (await customer()).id, inventoryItemId: (await unit(product.id)).id, planMonths: 3, totalPayableMinor: 220000, depositAmountMinor: 30000 });
    expect(overridden.status).toBe(201);
    expect((await overridden.json()).contract).toMatchObject({ totalPayableMinor: 220000, depositAmountMinor: 30000 });
  });

  it('checks a sale before it is made at the plan\'s figures', async () => {
    const product = await phoneModel();
    await savePlans(product.id, [{ months: 3, totalPriceMinor: 228500, depositMinor: 10000 }]);
    const res = await preflightPOST(makeRequest('POST', '/api/contracts/preflight', { token: admin, body: { contractType: 'DEVICE_FINANCING', customerId: (await customer()).id, inventoryItemId: (await unit(product.id)).id, planMonths: 3 } }));
    const { checks } = await res.json();
    expect(checks.warnings.map((w: { code: string }) => w.code)).toContain('LOW_DEPOSIT_RATIO');
  });

  it('a sale sent back is resubmitted on a plan, at that plan\'s figures', async () => {
    const product = await phoneModel();
    await savePlans(product.id, PLANS);
    const agent = await makeAgent();
    const { contract } = await (await sell(agent.token, { customerId: (await customer()).id, inventoryItemId: (await unit(product.id, agent.user.id)).id, planMonths: 3 })).json();
    await requestContractRevision({ contractId: contract.id, reason: 'Customer wants longer' });
    const res = await resubmitPOST(makeRequest('POST', `/api/contracts/${contract.id}/resubmit`, { token: agent.token, body: { planMonths: 5, totalPayableMinor: 1000 } }), makeParams({ id: contract.id }));
    expect(res.status).toBe(200);
    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after).toMatchObject({ status: 'PENDING_APPROVAL', totalPayableMinor: 265000, depositAmountMinor: 40000, termMonths: 5 });
    expect(await prisma.instalment.count({ where: { contractId: contract.id } })).toBe(150);
  });

  it('the price chart lists every phone\'s plans', async () => {
    const product = await phoneModel();
    await savePlans(product.id, PLANS);
    const { products } = await (await priceListGET(makeRequest('GET', '/api/price-chart/device-financing', { token: await login('agent@example.test') }))).json();
    expect(products.find((p: { id: string }) => p.id === product.id).financingPlans).toHaveLength(3);
  });
});

describe('The late-charge rate', () => {
  it('is refused above 50% at sale, and never charged above it whatever a contract carries', async () => {
    const admin = await login('admin@example.test');
    const res = await contractsPOST(makeRequest('POST', '/api/contracts', { token: admin, body: { contractType: 'DEPOSIT_INSTALMENT', customerId: 'x', inventoryItemId: 'y', totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 4, penaltyRateBps: 5100 } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/0% to 50%/);

    const contract = await prisma.contract.findFirstOrThrow({ where: { contractType: 'DEPOSIT_INSTALMENT', status: 'ACTIVE', instalments: { some: { status: { not: 'PAID' } } } }, include: { instalments: { where: { status: { not: 'PAID' } }, orderBy: { instalmentNo: 'asc' }, take: 1 } } });
    const inst = contract.instalments[0];
    await prisma.penalty.deleteMany({ where: { instalmentId: inst.id } });
    await prisma.contract.update({ where: { id: contract.id }, data: { penaltyRateBps: 2_000_000_000, gracePeriodDays: 0 } });
    await prisma.instalment.update({ where: { id: inst.id }, data: { status: 'OVERDUE', dueDate: new Date(Date.now() - 5 * 86_400_000) } });
    await applyLatePenalties();
    const charge = await prisma.penalty.findFirstOrThrow({ where: { instalmentId: inst.id, reason: 'LATE_PENALTY' } });
    expect(charge.amountMinor).toBe(Math.round(inst.amountDueMinor * 0.5));
  });
});
