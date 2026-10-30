/**
 * The sales side's rules (docs: sales, inventory and agent operations):
 * how a payment is applied and when a contract completes, who may approve a
 * sale, and what stops an agent's next sale.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { enableOptionalContractTypes, freshPhone, setSaleRules } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { createContract, approveContract } from '@/lib/services/contractService';
import { postPayment, amountOwedNow } from '@/lib/services/paymentService';
import { fileRemittance, confirmRemittance, ledgerBalance } from '@/lib/services/agentLedgerService';
import { assignStock } from '@/lib/services/stockAssignmentService';
import { applyStockMovement } from '@/lib/services/inventoryService';
import { makeRequest } from './helpers';
import { GET as inventoryGET } from '@/app/api/inventory/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as approvalsGET } from '@/app/api/contracts/approvals/route';
import { evaluateSaleChecks } from '@/lib/services/saleChecksService';
import { getAgentPortfolioRisk } from '@/lib/services/portfolioRiskService';
import { getCommissionSettings, updateCommissionSettings } from '@/lib/services/commissionSettingsService';
import { listCompletionCommissions, markCompletionCommissionPaid, undoCompletionCommissionPaid, agentCompletionSummary } from '@/lib/services/completionCommissionService';
import { cancelContract } from '@/lib/services/contractService';

const runId = Date.now().toString().slice(-7) + Math.floor(Math.random() * 100);
let counter = 0;
const DAY = 24 * 60 * 60 * 1000;

beforeAll(enableOptionalContractTypes);

describe('Sales operations', () => {
  let branchId: string;
  let adminId: string;
  let agentId: string;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
    agentId = (await prisma.user.findFirstOrThrow({ where: { email: 'agent@example.test' } })).id;
    await prisma.user.update({ where: { id: agentId }, data: { branchId } });
  });
  afterAll(() => setSaleRules({ blockSalesWhileDepositsUnremitted: false, parBlockEnabled: false }));

  async function customer(createdById = adminId) {
    return prisma.customer.create({ data: { membershipId: `SO-${runId}-${++counter}`, firstName: 'Kwesi', lastName: `Arthur${counter}`, phone: await freshPhone(), branchId, createdById } });
  }
  async function unit() {
    const product = await prisma.product.create({ data: { sku: `SO-${runId}-${++counter}`, name: 'Samsung A06', cashPriceMinor: 60000 } });
    return prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `SO-SN-${runId}-${counter}` } });
  }
  /** A new agent in the main branch, with nothing sold yet. */
  async function newAgent() {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'AGENT' } });
    return prisma.user.create({ data: { email: `so-agent-${runId}-${++counter}@example.test`, passwordHash: 'x', firstName: 'Ama', lastName: `Field${counter}`, roleId: role.id, branchId } });
  }
  /** GHS 600, GHS 120 deposit, twelve weekly GHS 40 instalments, started three weeks ago. An agent's unit is assigned to them. */
  async function sale(opts: { createdById?: string; requiresApproval?: boolean; startDaysAgo?: number; inventoryItemId?: string } = {}) {
    const createdById = opts.createdById ?? adminId;
    let inventoryItemId = opts.inventoryItemId;
    if (!inventoryItemId) {
      inventoryItemId = (await unit()).id;
      const seller = await prisma.user.findUniqueOrThrow({ where: { id: createdById }, select: { role: { select: { name: true } } } });
      if (seller.role.name === 'AGENT') await assignStock({ inventoryItemIds: [inventoryItemId], agentId: createdById, actor: { id: adminId, branchId: null } });
    }
    return createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: (await customer(createdById)).id, inventoryItemId, branchId, createdById,
      requiresApproval: opts.requiresApproval, totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY',
      startDate: new Date(Date.now() - (opts.startDaysAgo ?? 22) * DAY),
    });
  }
  const pay = (contractId: string, amountMinor: number, extra: { collectedByAgentId?: string; createdById?: string } = {}) =>
    postPayment({ contractId, amountMinor, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: extra.createdById ?? adminId, ...extra });
  const fresh = (id: string) => prisma.contract.findUniqueOrThrow({ where: { id } });

  describe('applying a payment', () => {
    it('clears overdue instalments before late charges, so paying exactly the arrears clears them', async () => {
      const c = await sale();
      await pay(c.id, 12000); // the deposit
      const overdue = await prisma.instalment.findMany({ where: { contractId: c.id, dueDate: { lt: new Date() } }, orderBy: { instalmentNo: 'asc' } });
      expect(overdue.length).toBeGreaterThanOrEqual(2);
      await prisma.penalty.create({ data: { contractId: c.id, instalmentId: overdue[0].id, amountMinor: 500, reason: 'LATE_PENALTY' } });

      await pay(c.id, overdue.length * 4000);
      const after = await prisma.instalment.findMany({ where: { id: { in: overdue.map((i) => i.id) } } });
      expect(after.every((i) => i.status === 'PAID')).toBe(true);
      expect(await prisma.penalty.count({ where: { contractId: c.id, isPaid: false } })).toBe(1);
    });

    it('money paid to late charges never reduces the price owed, and a contract only completes once they are paid too', async () => {
      const c = await sale({ startDaysAgo: 100 }); // every instalment overdue
      await pay(c.id, 12000);
      const first = await prisma.instalment.findFirstOrThrow({ where: { contractId: c.id, instalmentNo: 1 } });
      await prisma.penalty.create({ data: { contractId: c.id, instalmentId: first.id, amountMinor: 500, reason: 'LATE_PENALTY' } });

      // Every instalment, all overdue, so all of it goes to them: the charge is still owed.
      await pay(c.id, 48000);
      let contract = await fresh(c.id);
      expect(contract.totalPaidMinor).toBe(60000);
      expect(contract.balanceMinor).toBe(0);
      expect(contract.status).toBe('ACTIVE'); // the charge is still owed
      expect(await amountOwedNow(c.id)).toBe(500);

      await pay(c.id, 500);
      contract = await fresh(c.id);
      expect(contract.status).toBe('COMPLETED');
      expect(contract.totalPaidMinor).toBe(60000); // the charge is not part of the price
    });

    it('a payment on a contract partly behind pays the arrears, then the charge, then upcoming instalments', async () => {
      const c = await sale();
      await pay(c.id, 12000);
      await prisma.penalty.create({ data: { contractId: c.id, amountMinor: 500, reason: 'LATE_PENALTY' } });
      await pay(c.id, 48000);
      const contract = await fresh(c.id);
      expect(await prisma.penalty.count({ where: { contractId: c.id, isPaid: false } })).toBe(0);
      expect(contract.totalPaidMinor).toBe(59500); // GHS 5.00 went to the charge, so GHS 5.00 of the price is still owed
      expect(contract.status).toBe('ACTIVE');
      expect(await amountOwedNow(c.id)).toBe(500);
    });

    it('a charge too big for what is left is skipped, and the rest goes on to upcoming instalments', async () => {
      const c = await sale({ startDaysAgo: 2 }); // nothing overdue yet
      await pay(c.id, 12000);
      await prisma.penalty.create({ data: { contractId: c.id, amountMinor: 5000, reason: 'LATE_PENALTY' } });
      await pay(c.id, 4000); // less than the GHS 50.00 charge
      const first = await prisma.instalment.findFirstOrThrow({ where: { contractId: c.id, instalmentNo: 1 } });
      expect(first.amountPaidMinor).toBe(4000);
      expect(await prisma.penalty.count({ where: { contractId: c.id, isPaid: false } })).toBe(1);
    });
  });

  describe('approval', () => {
    it('nobody approves their own sale, except a Super Admin', async () => {
      const own = await sale({ requiresApproval: true });
      await expect(approveContract({ contractId: own.id, approvedById: adminId })).rejects.toThrow(/cannot approve a sale you made yourself/);
      const approved = await approveContract({ contractId: own.id, approvedById: adminId, allowOwnSale: true });
      expect(approved.status).toBe('PENDING_DEPOSIT');
    });
  });

  describe("an agent's next sale", () => {
    it('is refused while they hold deposit cash not yet remitted, and allowed once it is', async () => {
      await setSaleRules({ blockSalesWhileDepositsUnremitted: true });
      // Settle anything an earlier test left this agent holding.
      for (const e of await prisma.agentDepositLedger.findMany({ where: { agentId } })) {
        if (ledgerBalance(e) > 0) await prisma.agentDepositLedger.update({ where: { id: e.id }, data: { amountRemittedMinor: { increment: ledgerBalance(e) } } });
      }

      const first = await sale({ createdById: agentId, requiresApproval: true });
      await approveContract({ contractId: first.id, approvedById: adminId });
      await pay(first.id, 12000, { createdById: agentId, collectedByAgentId: agentId });
      const ledger = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { contractId: first.id } });
      expect(ledgerBalance(ledger)).toBeGreaterThan(0);

      await expect(sale({ createdById: agentId, requiresApproval: true })).rejects.toThrow(/deposit cash not yet remitted, on 1 contract/);

      const remittance = await fileRemittance({ ledgerId: ledger.id, agentId, amountMinor: ledgerBalance(ledger), method: 'CASH' });
      await confirmRemittance({ remittanceId: remittance.id, confirmedById: adminId, confirmerBranchId: null });
      await expect(sale({ createdById: agentId, requiresApproval: true })).resolves.toMatchObject({ status: 'PENDING_APPROVAL' });
    });

    it('is not refused for that when the rule is switched off', async () => {
      await setSaleRules({ blockSalesWhileDepositsUnremitted: false });
      const first = await sale({ createdById: agentId, requiresApproval: true });
      await approveContract({ contractId: first.id, approvedById: adminId });
      await pay(first.id, 12000, { createdById: agentId, collectedByAgentId: agentId });
      await expect(sale({ createdById: agentId, requiresApproval: true })).resolves.toMatchObject({ status: 'PENDING_APPROVAL' });
    });
  });

  describe('stock held by agents', () => {
    it('an agent sells only the units assigned to them; other staff may sell any unit in the branch', async () => {
      const mine = await unit();
      const shop = await unit();
      await assignStock({ inventoryItemIds: [mine.id], agentId, reason: 'Market day', actor: { id: adminId, branchId: null } });

      await expect(sale({ createdById: agentId, requiresApproval: true, inventoryItemId: shop.id })).rejects.toThrow(/not assigned to you/);
      await expect(sale({ createdById: agentId, requiresApproval: true, inventoryItemId: mine.id })).resolves.toMatchObject({ status: 'PENDING_APPROVAL' });
      await expect(sale({ inventoryItemId: shop.id })).resolves.toMatchObject({ status: 'PENDING_DEPOSIT' });

      const history = await prisma.inventoryAssignment.findMany({ where: { inventoryItemId: mine.id } });
      expect(history).toMatchObject([{ fromAgentId: null, toAgentId: agentId, assignedById: adminId, reason: 'Market day' }]);
    });

    it('an agent sees only their own stock in the inventory list', async () => {
      const mine = await unit();
      const other = await unit();
      await assignStock({ inventoryItemIds: [mine.id], agentId, actor: { id: adminId, branchId: null } });
      const token = (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email: 'agent@example.test', password: 'Passw0rd!123' } }))).json()).token;
      const ids = ((await (await inventoryGET(makeRequest('GET', '/api/inventory?status=AVAILABLE', { token }))).json()).items as { id: string }[]).map((i) => i.id);
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(other.id);
    });

    it("a unit on a customer's contract can't be moved, nor given to an agent in another branch", async () => {
      const reserved = await unit();
      await sale({ inventoryItemId: reserved.id });
      await expect(assignStock({ inventoryItemIds: [reserved.id], agentId, actor: { id: adminId, branchId: null } })).rejects.toThrow(/on a customer's contract/);

      const otherBranch = await prisma.branch.create({ data: { name: `zz Other ${runId}-${++counter}`, code: `O${runId}${counter}`.slice(0, 10) } });
      const far = await unit();
      await prisma.inventoryItem.update({ where: { id: far.id }, data: { branchId: otherBranch.id } });
      await expect(assignStock({ inventoryItemIds: [far.id], agentId, actor: { id: adminId, branchId: null } })).rejects.toThrow(/another branch/);
    });

    it('moving a unit to another branch takes it back from its agent', async () => {
      const u = await unit();
      await assignStock({ inventoryItemIds: [u.id], agentId, actor: { id: adminId, branchId: null } });
      const otherBranch = await prisma.branch.create({ data: { name: `zz Far ${runId}-${++counter}`, code: `F${runId}${counter}`.slice(0, 10) } });
      await applyStockMovement({ inventoryItemId: u.id, type: 'TRANSFER', toBranchId: otherBranch.id, createdById: adminId });
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: u.id } })).assignedAgentId).toBeNull();
      expect(await prisma.inventoryAssignment.findFirst({ where: { inventoryItemId: u.id, toAgentId: null, fromAgentId: agentId } })).not.toBeNull();
    });
  });

  describe('checks before a sale, and in the approval queue', () => {
    it('warns the approver of a low deposit and a large amount financed, and sets the priority and time to decide', async () => {
      const low = await evaluateSaleChecks({ createdById: adminId, creatorRole: 'ADMIN', totalPayableMinor: 60000, depositAmountMinor: 5000, termWeeks: 12 });
      expect(low.warnings.map((w) => w.code)).toEqual(['LOW_DEPOSIT_RATIO']);
      expect(low).toMatchObject({ priority: 'MEDIUM', riskScore: 12, suggestedSlaHours: 12, blockers: [] });

      const big = await evaluateSaleChecks({ createdById: adminId, creatorRole: 'ADMIN', totalPayableMinor: 900000, depositAmountMinor: 150000, termWeeks: 20 });
      expect(big.warnings.map((w) => w.code)).toEqual(['HIGH_FINANCE_AMOUNT', 'LONG_TENOR']);
      expect(big).toMatchObject({ priority: 'HIGH', riskScore: 26, suggestedSlaHours: 6 });
    });

    it('refuses a second sale of the same product to a customer while the first is under review', async () => {
      const agent = await newAgent();
      const first = await sale({ createdById: agent.id, requiresApproval: true });
      const item = await prisma.inventoryItem.create({ data: { productId: first.productId!, branchId, serialNumber: `SO-SN-${runId}-${++counter}`, assignedAgentId: agent.id } });
      await expect(createContract({
        contractType: 'DEPOSIT_INSTALMENT', customerId: first.customerId, inventoryItemId: item.id, branchId, createdById: agent.id, requiresApproval: true,
        totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY',
      })).rejects.toThrow(/already has a sale of this product waiting for approval/);
    });

    it('the queue gives each pending sale its checks, and marks the approver\'s own sale', async () => {
      const agent = await newAgent();
      const theirs = await sale({ createdById: agent.id, requiresApproval: true });
      const mine = await sale({ requiresApproval: true });
      const token = (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email: 'admin@example.test', password: 'Passw0rd!123' } }))).json()).token;
      const rows = (await (await approvalsGET(makeRequest('GET', '/api/contracts/approvals', { token }))).json()).contracts as Array<{ id: string; ownSale: boolean; checks: { priority: string } }>;
      expect(rows.find((r) => r.id === theirs.id)).toMatchObject({ ownSale: false, checks: { priority: expect.any(String) } });
      expect(rows.find((r) => r.id === mine.id)).toMatchObject({ ownSale: true });
    });
  });

  describe('portfolio at risk', () => {
    it('counts what is owed on contracts more than 30 days behind, against the whole book', async () => {
      const agent = await newAgent();
      const behind = await sale({ createdById: agent.id, requiresApproval: true, startDaysAgo: 100 });
      const current = await sale({ createdById: agent.id, requiresApproval: true, startDaysAgo: 3 });
      for (const c of [behind, current]) {
        await approveContract({ contractId: c.id, approvedById: adminId });
        await pay(c.id, 12000);
      }
      const [risk] = await getAgentPortfolioRisk({ agentIds: [agent.id] });
      expect(risk).toMatchObject({ contracts: 2, outstandingMinor: 96000, par30Contracts: 1, par30Minor: 48000, par30Percent: 50 });
    });

    it("stops an agent's sales over the PAR limit, and lifts once they collect", async () => {
      const agent = await newAgent();
      const behind = await sale({ createdById: agent.id, requiresApproval: true, startDaysAgo: 100 });
      await approveContract({ contractId: behind.id, approvedById: adminId });
      await pay(behind.id, 12000);
      await setSaleRules({ parBlockEnabled: true, parBlockThresholdPercent: 20, parBlockMinContracts: 1 });
      try {
        await expect(sale({ createdById: agent.id, requiresApproval: true })).rejects.toThrow(/100% of what your customers owe .* is more than 30 days behind, over the 20% limit/);
        await pay(behind.id, 48000); // collected in full
        await expect(sale({ createdById: agent.id, requiresApproval: true })).resolves.toMatchObject({ status: 'PENDING_APPROVAL' });
      } finally {
        await setSaleRules({ parBlockEnabled: false });
      }
    });
  });

  describe('commission paid on completion', () => {
    let saved: Awaited<ReturnType<typeof getCommissionSettings>>;
    beforeAll(async () => {
      saved = await getCommissionSettings();
      await updateCommissionSettings({ fixedCommissionMinor: saved.fixedCommissionMinor, deferredCommissionMinor: 1500, completionBonusMinor: 1000, updatedById: adminId });
    });
    afterAll(() => updateCommissionSettings({ fixedCommissionMinor: saved.fixedCommissionMinor, deferredCommissionMinor: saved.deferredCommissionMinor, completionBonusMinor: saved.completionBonusMinor, updatedById: adminId }));

    async function approvedAgentSale(agent: { id: string }) {
      const c = await sale({ createdById: agent.id, requiresApproval: true });
      await approveContract({ contractId: c.id, approvedById: adminId });
      return c;
    }
    const rowFor = async (agentId: string, contractId: string) =>
      (await listCompletionCommissions({ agentId })).rows.find((r) => r.contractId === contractId)!;

    it('is fixed on the sale at approval, and payable only once the customer completes', async () => {
      const agent = await newAgent();
      const c = await approvedAgentSale(agent);
      let row = await rowFor(agent.id, c.id);
      expect(row).toMatchObject({ deferredMinor: 1500, bonusMinor: 1000, totalMinor: 2500, status: 'PENDING' });
      await expect(markCompletionCommissionPaid(row.id, 'MM-1', adminId)).rejects.toThrow(/Only a payable commission/);

      // A rate change later re-prices nothing already approved.
      await updateCommissionSettings({ fixedCommissionMinor: saved.fixedCommissionMinor, deferredCommissionMinor: 9900, completionBonusMinor: 1000, updatedById: adminId });
      try {
        await pay(c.id, 60000);
        expect((await fresh(c.id)).status).toBe('COMPLETED');
        row = await rowFor(agent.id, c.id);
        expect(row).toMatchObject({ totalMinor: 2500, status: 'PAYABLE' });
        expect(await agentCompletionSummary(agent.id)).toMatchObject({ payable: { count: 1, totalMinor: 2500 }, dueOnCompletion: { count: 0 } });
      } finally {
        await updateCommissionSettings({ fixedCommissionMinor: saved.fixedCommissionMinor, deferredCommissionMinor: 1500, completionBonusMinor: 1000, updatedById: adminId });
      }

      await expect(markCompletionCommissionPaid(row.id, '  ', adminId)).rejects.toThrow(/payment reference/);
      await markCompletionCommissionPaid(row.id, 'MM-123', adminId);
      expect(await rowFor(agent.id, c.id)).toMatchObject({ status: 'PAID', reference: 'MM-123', needsReview: false });
      await expect(markCompletionCommissionPaid(row.id, 'MM-124', adminId)).rejects.toThrow(/this one is paid/);

      await undoCompletionCommissionPaid(row.id, adminId);
      expect(await rowFor(agent.id, c.id)).toMatchObject({ status: 'PAYABLE', reference: null });
    });

    it('is held while the contract is defaulted, and lost if the sale is cancelled', async () => {
      const agent = await newAgent();
      const defaulted = await approvedAgentSale(agent);
      await prisma.contract.update({ where: { id: defaulted.id }, data: { status: 'DEFAULTED' } });
      expect((await rowFor(agent.id, defaulted.id)).status).toBe('ON_HOLD');

      const cancelled = await approvedAgentSale(agent);
      await cancelContract({ contractId: cancelled.id, reason: 'Customer changed their mind', userId: adminId });
      expect((await rowFor(agent.id, cancelled.id)).status).toBe('FORFEITED');
      expect(await agentCompletionSummary(agent.id)).toMatchObject({ dueOnCompletion: { count: 1, totalMinor: 2500 } });
    });

    it("is not recorded for staff sales, or when nothing is held back", async () => {
      const staff = await sale({ requiresApproval: true });
      await approveContract({ contractId: staff.id, approvedById: adminId, allowOwnSale: true });
      expect(await prisma.agentCompletionCommission.count({ where: { contractId: staff.id } })).toBe(0);

      await updateCommissionSettings({ fixedCommissionMinor: saved.fixedCommissionMinor, deferredCommissionMinor: 0, completionBonusMinor: 0, updatedById: adminId });
      try {
        const c = await approvedAgentSale(await newAgent());
        expect(await prisma.agentCompletionCommission.count({ where: { contractId: c.id } })).toBe(0);
      } finally {
        await updateCommissionSettings({ fixedCommissionMinor: saved.fixedCommissionMinor, deferredCommissionMinor: 1500, completionBonusMinor: 1000, updatedById: adminId });
      }
    });
  });
});
