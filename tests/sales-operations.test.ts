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
  /** GHS 600, GHS 120 deposit, twelve weekly GHS 40 instalments, started three weeks ago. */
  async function sale(opts: { createdById?: string; requiresApproval?: boolean; startDaysAgo?: number } = {}) {
    const createdById = opts.createdById ?? adminId;
    return createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: (await customer(createdById)).id, inventoryItemId: (await unit()).id, branchId, createdById,
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
});
