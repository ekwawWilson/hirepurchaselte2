/**
 * The agent ledger kept true to the money: split deposits, reversals and
 * cancellations; who actually took the cash; commission earned however the
 * deposit is paid, and paid out when the office owes it; and the controls
 * and visibility around agents.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, freshPhone } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as cashPOST } from '@/app/api/payments/cash/route';
import { POST as applyPOST } from '@/app/api/mobile-money/[id]/apply/route';
import { POST as payCommissionPOST } from '@/app/api/agent/ledger/[id]/pay-commission/route';
import { POST as remitPOST } from '@/app/api/agent/ledger/[id]/remit/route';
import { PATCH as remittancePATCH } from '@/app/api/agent/remittances/[id]/route';
import { GET as attentionGET } from '@/app/api/attention/route';
import { PATCH as userPATCH } from '@/app/api/users/[id]/route';
import { GET as agentReportGET } from '@/app/api/reports/agent-performance/route';
import { createContract, approveContract, cancelContract, expireStaleSubmissions } from '@/lib/services/contractService';
import { postPayment, reversePayment } from '@/lib/services/paymentService';
import { alertLongHeldAgentCash } from '@/lib/services/agentLedgerService';
import { hashPassword } from '@/lib/services/authService';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
const unique = () => `${runId}${++counter}`;
const PASSWORD = 'Passw0rd!123';
const login = async (email: string) =>
  (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }))).json()).token as string;

beforeAll(enableOptionalContractTypes);

describe('Agents: ledger, commission and controls', () => {
  let branchId: string;
  let managerId: string;
  let cashierId: string;
  let manager: string;
  let cashier: string;
  let auditor: string;
  let superadmin: string;

  beforeAll(async () => {
    const seededAgent = await prisma.user.findFirstOrThrow({ where: { email: 'agent@example.test' } });
    branchId = seededAgent.branchId!;
    managerId = (await prisma.user.findFirstOrThrow({ where: { email: 'branchmanager@example.test' } })).id;
    cashierId = (await prisma.user.findFirstOrThrow({ where: { email: 'cashier@example.test' } })).id;
    manager = await login('branchmanager@example.test');
    cashier = await login('cashier@example.test');
    auditor = await login('auditor@example.test');
    superadmin = await login('superadmin@example.test');
    await prisma.commissionSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', fixedCommissionMinor: 500 }, update: { fixedCommissionMinor: 500 } });
  });

  /** An agent of their own, so balances in one test never touch another's. */
  async function makeAgent(inBranch = branchId) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'AGENT' } });
    const user = await prisma.user.create({
      data: { email: `agent-gap-${unique()}@example.test`, passwordHash: await hashPassword(PASSWORD), firstName: 'Gap', lastName: `Agent${counter}`, roleId: role.id, branchId: inBranch },
    });
    return { user, token: await login(user.email) };
  }

  /** An approved Deposit + Instalment contract the agent brought in: GHS 600, GHS 120 deposit. */
  async function agentContract(agentId: string) {
    const product = await prisma.product.create({ data: { sku: `GAP-${unique()}`, name: 'Gap Phone', cashPriceMinor: 100000 } });
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `GAP-SN-${unique()}`, assignedAgentId: agentId } });
    const customer = await prisma.customer.create({
      data: { membershipId: `GAP-${unique()}`, firstName: 'Gap', lastName: 'Customer', phone: await freshPhone(), branchId, createdById: agentId },
    });
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item.id, branchId, createdById: agentId, requiresApproval: true,
      totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY',
    });
    await approveContract({ contractId: contract.id, approvedById: managerId });
    return contract;
  }
  const ledgerOf = (contractId: string) => prisma.agentDepositLedger.findUnique({ where: { contractId } });
  const agentCash = (contractId: string, agentId: string, amountMinor: number, entryType: 'DEPOSIT' | 'INSTALMENT_PAYMENT' = 'DEPOSIT') =>
    postPayment({ contractId, amountMinor, entryType, channel: 'CASH', createdById: cashierId, collectedByAgentId: agentId });

  describe('the ledger follows the money', () => {
    it('a deposit paid in two cash parts is accepted, and the agent owes both less their commission', async () => {
      const { user } = await makeAgent();
      const contract = await agentContract(user.id);
      await agentCash(contract.id, user.id, 5000);
      expect(await ledgerOf(contract.id)).toMatchObject({ depositAmountMinor: 5000, commissionAmountMinor: 0, amountOwedMinor: 5000, status: 'OWED' });
      await agentCash(contract.id, user.id, 7000); // refused before: one ledger row per contract
      expect(await ledgerOf(contract.id)).toMatchObject({ depositAmountMinor: 12000, commissionAmountMinor: 500, amountOwedMinor: 11500, status: 'OWED' });
      expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('ACTIVE');
      // An instalment the agent also collects is cash in their hand too.
      await agentCash(contract.id, user.id, 4000, 'INSTALMENT_PAYMENT');
      expect(await ledgerOf(contract.id)).toMatchObject({ depositAmountMinor: 16000, amountOwedMinor: 15500 });
    });

    it('reversing the deposit takes it — and the commission it earned — back off the agent\'s ledger', async () => {
      const { user } = await makeAgent();
      const contract = await agentContract(user.id);
      const { payment } = await agentCash(contract.id, user.id, 12000);
      await reversePayment({ paymentId: payment.id, reason: 'Keyed against the wrong contract', reversedById: managerId });
      expect(await ledgerOf(contract.id)).toMatchObject({ depositAmountMinor: 0, commissionAmountMinor: 0, amountOwedMinor: 0, status: 'SETTLED' });
    });

    it('cancelling before the device is handed over unwinds the agent\'s ledger with the deposit', async () => {
      const { user } = await makeAgent();
      const product = await prisma.product.create({ data: { sku: `GAP-${unique()}`, name: 'Gap Phone', cashPriceMinor: 100000 } });
      const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `GAP-SN-${unique()}`, assignedAgentId: user.id } });
      const customer = await prisma.customer.create({ data: { membershipId: `GAP-${unique()}`, firstName: 'Gap', lastName: 'Withdrew', phone: await freshPhone(), branchId, createdById: user.id } });
      const contract = await createContract({
        contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item.id, branchId, createdById: user.id, requiresApproval: true,
        totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY',
      });
      await approveContract({ contractId: contract.id, approvedById: managerId });
      await agentCash(contract.id, user.id, 6000); // part of the deposit: device still reserved
      await cancelContract({ contractId: contract.id, reason: 'Customer withdrew', userId: managerId });
      expect(await ledgerOf(contract.id)).toMatchObject({ depositAmountMinor: 0, amountOwedMinor: 0, status: 'SETTLED' });
    });

    it('a cancellation after the device went out keeps the commission: the sale happened', async () => {
      const { user } = await makeAgent();
      const contract = await agentContract(user.id);
      await agentCash(contract.id, user.id, 12000);
      await cancelContract({ contractId: contract.id, reason: 'Returned later', userId: managerId });
      expect(await ledgerOf(contract.id)).toMatchObject({ depositAmountMinor: 12000, commissionAmountMinor: 500, amountOwedMinor: 11500 });
    });
  });

  describe('who took the cash, and commission however the deposit is paid', () => {
    it('a deposit paid at the counter puts no cash on the agent, and the office then owes them their commission', async () => {
      const { user, token } = await makeAgent();
      const contract = await agentContract(user.id);
      const res = await cashPOST(makeRequest('POST', '/api/payments/cash', { token: cashier, body: { contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT' } }));
      expect(res.status).toBe(201);
      expect((await res.json()).payment.collectedByAgentId).toBeNull();
      const entry = await ledgerOf(contract.id);
      expect(entry).toMatchObject({ depositAmountMinor: 0, commissionAmountMinor: 500, amountOwedMinor: -500, status: 'DUE_TO_AGENT' });

      // The agent can't "remit" what they don't owe.
      expect((await remitPOST(makeRequest('POST', `/api/agent/ledger/${entry!.id}/remit`, { token, body: { amountMinor: 100, method: 'CASH' } }), makeParams({ id: entry!.id }))).status).toBe(400);

      const pay = (tok: string, amountMinor: number) => payCommissionPOST(
        makeRequest('POST', `/api/agent/ledger/${entry!.id}/pay-commission`, { token: tok, body: { amountMinor, method: 'MOBILE_MONEY', reference: 'MM-77' } }), makeParams({ id: entry!.id }));
      expect((await pay(cashier, 500)).status).toBe(403);  // can't manage agent ledgers
      expect((await pay(auditor, 500)).status).toBe(403);  // reviews, doesn't pay out
      expect((await pay(manager, 600)).status).toBe(400);  // more than is owed
      expect((await pay(manager, 500)).status).toBe(201);
      expect(await ledgerOf(contract.id)).toMatchObject({ commissionPaidMinor: 500, status: 'SETTLED' });
      expect((await pay(manager, 1)).status).toBe(400);    // nothing left owed
    });

    it('a deposit paid by mobile money earns the commission too', async () => {
      const { user } = await makeAgent();
      const contract = await agentContract(user.id);
      await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'USSD' });
      expect(await ledgerOf(contract.id)).toMatchObject({ depositAmountMinor: 0, commissionAmountMinor: 500, status: 'DUE_TO_AGENT' });
    });

    it('an agent records the cash they collect, on their own contracts only, with a receipt — and owes it', async () => {
      const mine = await makeAgent();
      const other = await makeAgent();
      const contract = await agentContract(mine.user.id);
      const theirs = await agentContract(other.user.id);
      const record = (tok: string, contractId: string, body: Record<string, unknown> = {}) =>
        cashPOST(makeRequest('POST', '/api/payments/cash', { token: tok, body: { contractId, amountMinor: 12000, entryType: 'DEPOSIT', ...body } }));

      expect((await record(mine.token, theirs.id)).status).toBe(403);
      const res = await record(mine.token, contract.id, { collectedByAgent: false }); // an agent recording it took it, whatever they say
      expect(res.status).toBe(201);
      const { payment } = await res.json();
      expect(payment).toMatchObject({ collectedByAgentId: mine.user.id, createdById: mine.user.id, channel: 'CASH' });
      expect(payment.receiptNumber).toMatch(/\w/);
      expect(await ledgerOf(contract.id)).toMatchObject({ depositAmountMinor: 12000, amountOwedMinor: 11500, status: 'OWED' });

      // Cash can only be put on an agent if the contract is an agent's.
      const counterCustomer = await prisma.customer.create({ data: { membershipId: `GAP-${unique()}`, firstName: 'Counter', lastName: 'Only', phone: await freshPhone(), branchId, createdById: cashierId } });
      const saver = await createContract({ contractType: 'SAVE_TO_OWN', customerId: counterCustomer.id, branchId, createdById: cashierId });
      expect((await cashPOST(makeRequest('POST', '/api/payments/cash', { token: cashier, body: { contractId: saver.id, amountMinor: 1000, collectedByAgent: true } }))).status).toBe(400);

      // The review queue stays back-office work.
      const txn = await prisma.hubtelTransaction.create({ data: { clientReference: `GAP-NR-${unique()}`, contractId: contract.id, msisdn: '0240000000', amountMinor: 100, status: 'NEEDS_REVIEW' } });
      expect((await applyPOST(makeRequest('POST', `/api/mobile-money/${txn.id}/apply`, { token: mine.token }), makeParams({ id: txn.id }))).status).toBe(403);
    });
  });

  describe('controls', () => {
    it('only an approver in the agent\'s own branch may confirm or reject their payments-in', async () => {
      const { user, token } = await makeAgent();
      const contract = await agentContract(user.id);
      await agentCash(contract.id, user.id, 12000);
      const entry = (await ledgerOf(contract.id))!;
      const filed = await (await remitPOST(makeRequest('POST', `/api/agent/ledger/${entry.id}/remit`, { token, body: { amountMinor: 11500, method: 'CASH' } }), makeParams({ id: entry.id }))).json();

      const otherBranch = await prisma.branch.create({ data: { name: `Other ${unique()}`, code: `OB${unique()}` } });
      const role = await prisma.role.findUniqueOrThrow({ where: { name: 'BRANCH_MANAGER' } });
      const elsewhere = await prisma.user.create({ data: { email: `bm-${unique()}@example.test`, passwordHash: await hashPassword(PASSWORD), firstName: 'Else', lastName: 'Where', roleId: role.id, branchId: otherBranch.id } });
      const decide = (tok: string, body: Record<string, unknown>) =>
        remittancePATCH(makeRequest('PATCH', `/api/agent/remittances/${filed.remittance.id}`, { token: tok, body }), makeParams({ id: filed.remittance.id }));
      expect((await decide(await login(elsewhere.email), { action: 'confirm' })).status).toBe(400);
      expect((await decide(await login(elsewhere.email), { action: 'reject', reason: 'x' })).status).toBe(400);
      expect((await decide(manager, { action: 'confirm' })).status).toBe(200);
      expect(await ledgerOf(contract.id)).toMatchObject({ amountRemittedMinor: 11500, status: 'SETTLED' });
    });

    it('an agent who still owes or is owed money is not quietly deactivated or moved off the agent role', async () => {
      const { user } = await makeAgent();
      const contract = await agentContract(user.id);
      await agentCash(contract.id, user.id, 12000);
      const patch = (body: Record<string, unknown>) => userPATCH(makeRequest('PATCH', `/api/users/${user.id}`, { token: superadmin, body }), makeParams({ id: user.id }));

      const refused = await patch({ isActive: false });
      expect(refused.status).toBe(409);
      expect((await refused.json()).error).toMatch(/still owes GHS 115\.00/);
      expect((await patch({ role: 'CASHIER' })).status).toBe(409);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).isActive).toBe(true);
      expect((await patch({ isActive: false, acknowledgeOutstanding: true })).status).toBe(200);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).isActive).toBe(false);
    });

    it('an unapproved submission left untouched for 14 days is cancelled, and its unit goes back on the shelf', async () => {
      const { user } = await makeAgent();
      const product = await prisma.product.create({ data: { sku: `GAP-${unique()}`, name: 'Gap Phone', cashPriceMinor: 100000 } });
      const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `GAP-SN-${unique()}`, assignedAgentId: user.id } });
      const customer = await prisma.customer.create({ data: { membershipId: `GAP-${unique()}`, firstName: 'Gap', lastName: 'Stale', phone: await freshPhone(), branchId, createdById: user.id } });
      const make = () => createContract({
        contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item.id, branchId, createdById: user.id, requiresApproval: true,
        totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY',
      });
      const stale = await make();
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).status).toBe('RESERVED');

      await expireStaleSubmissions();
      expect((await prisma.contract.findUniqueOrThrow({ where: { id: stale.id } })).status).toBe('PENDING_APPROVAL'); // not old yet

      await prisma.$executeRaw`UPDATE contracts SET "updatedAt" = now() - interval '15 days' WHERE id = ${stale.id}`;
      expect(await expireStaleSubmissions()).toBeGreaterThanOrEqual(1);
      const cancelled = await prisma.contract.findUniqueOrThrow({ where: { id: stale.id } });
      expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelReason: 'Automatically cancelled: not approved within 14 days' });
      expect((await prisma.inventoryItem.findUniqueOrThrow({ where: { id: item.id } })).status).not.toBe('RESERVED');
    });
  });

  describe('visibility', () => {
    it('the dashboard tells an approver what agents are waiting on, and an agent where they stand', async () => {
      const { user, token } = await makeAgent();
      const owing = await agentContract(user.id);
      await agentCash(owing.id, user.id, 12000);
      const owed = await agentContract(user.id);
      await postPayment({ contractId: owed.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'USSD' });
      const sentBack = await agentContract(user.id);
      await prisma.contract.update({ where: { id: sentBack.id }, data: { status: 'REVISION_REQUESTED', revisionReason: 'Wrong deposit' } });
      const entry = (await ledgerOf(owing.id))!;
      await remitPOST(makeRequest('POST', `/api/agent/ledger/${entry.id}/remit`, { token, body: { amountMinor: 1000, method: 'CASH' } }), makeParams({ id: entry.id }));

      const forAgent = await (await attentionGET(makeRequest('GET', '/api/attention', { token }))).json();
      expect(forAgent).toMatchObject({ contractsSentBack: 1, cashToRemitMinor: 11500, commissionOwedToYouMinor: 500, contractsToApprove: 0, remittancesToConfirm: 0 });
      const forManager = await (await attentionGET(makeRequest('GET', '/api/attention', { token: manager }))).json();
      expect(forManager.remittancesToConfirm).toBeGreaterThanOrEqual(1);
      expect(forManager.contractsSentBack).toBe(0);
    });

    it('an agent holding cash too long raises one alert for them', async () => {
      const { user } = await makeAgent();
      const contract = await agentContract(user.id);
      const { payment } = await agentCash(contract.id, user.id, 12000);
      await alertLongHeldAgentCash();
      expect(await prisma.systemAlert.findUnique({ where: { dedupeKey: `agent-cash-held:${user.id}` } })).toBeNull();

      await prisma.payment.update({ where: { id: payment.id }, data: { receivedAt: new Date(Date.now() - 5 * 86_400_000) } });
      await alertLongHeldAgentCash();
      const alert = await prisma.systemAlert.findUnique({ where: { dedupeKey: `agent-cash-held:${user.id}` } });
      expect(alert?.message).toMatch(/held GHS 115\.00 of customers' cash for up to 5 days/);
    });

    it('the agent report shows each agent\'s sales, cash, commission and arrears', async () => {
      const { user } = await makeAgent();
      const a = await agentContract(user.id);
      await agentCash(a.id, user.id, 12000);
      const b = await agentContract(user.id);
      await postPayment({ contractId: b.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'USSD' });
      const today = new Date().toISOString().slice(0, 10);

      expect((await agentReportGET(makeRequest('GET', `/api/reports/agent-performance?from=${today}&to=${today}`, { token: await login('sales@example.test') }))).status).toBe(403);
      const report = await (await agentReportGET(makeRequest('GET', `/api/reports/agent-performance?from=${today}&to=${today}`, { token: manager }))).json();
      const row = report.rows.find((r: { agentId: string }) => r.agentId === user.id);
      expect(row).toMatchObject({
        submitted: 2, approved: 2, cashCollectedMinor: 12000, commissionEarnedMinor: 1000,
        agentOwesMinor: 11500, owedToAgentMinor: 500, liveContracts: 2, longestHeldDays: 0,
      });
    });
  });
});
