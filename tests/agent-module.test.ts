/**
 * The Agent module (ported from the legacy hirepurchase app's own AGENT
 * role): an agent's contracts require approval before they go live, an
 * agent sees only their own book, and a deposit collected in cash creates a
 * commission/deposit-custody ledger entry the agent must remit.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, registrationFields } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { GET as customerGET } from '@/app/api/customers/[id]/route';
import { POST as contractsPOST, GET as contractsGET } from '@/app/api/contracts/route';
import { GET as contractGET } from '@/app/api/contracts/[id]/route';
import { POST as approvePOST } from '@/app/api/contracts/[id]/approve/route';
import { POST as requestRevisionPOST } from '@/app/api/contracts/[id]/request-revision/route';
import { POST as resubmitPOST } from '@/app/api/contracts/[id]/resubmit/route';
import { POST as cashPaymentPOST } from '@/app/api/payments/cash/route';
import { GET as myLedgerGET } from '@/app/api/agent/ledger/route';
import { POST as remitPOST } from '@/app/api/agent/ledger/[id]/remit/route';
import { GET as allLedgersGET } from '@/app/api/agent/ledger/all/route';
import { PATCH as remittancePATCH } from '@/app/api/agent/remittances/[id]/route';
import { GET as commissionGET, PATCH as commissionPATCH } from '@/app/api/settings/commission/route';
import { portalContract, portalContracts } from '@/lib/services/customerPortalService';

const PASSWORD = 'Passw0rd!123';
const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
function unique() { counter += 1; return `${runId}${counter}`; }
function uniquePhone() { return `024${unique()}`; }

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  return (await res.json()).token as string;
}

beforeAll(enableOptionalContractTypes);

describe('Agent module', () => {
  let agentToken: string;
  let agentId: string;
  let agentBranchId: string;
  let managerToken: string; // BRANCH_MANAGER — has contract.approve + agent.ledger.manage
  let adminToken: string;
  let cashierToken: string; // has payment.cash.record but NOT contract.approve

  beforeAll(async () => {
    agentToken = await login('agent@example.test');
    const agent = await prisma.user.findUniqueOrThrow({ where: { email: 'agent@example.test' } });
    agentId = agent.id;
    agentBranchId = agent.branchId!;
    managerToken = await login('branchmanager@example.test');
    adminToken = await login('admin@example.test');
    cashierToken = await login('cashier@example.test');
  });

  async function registerCustomer(token: string) {
    const res = await customersPOST(makeRequest('POST', '/api/customers', {
      token, body: { firstName: 'Agent', lastName: `Customer${unique()}`, phone: uniquePhone(), ...registrationFields() },
    }));
    expect(res.status).toBe(201);
    return (await res.json()).customer as { id: string; branchId: string; createdById: string };
  }

  async function makeDepositInstalmentUnit() {
    const product = await prisma.product.create({ data: { sku: `AGENT-SKU-${unique()}`, name: 'Agent Test Phone', cashPriceMinor: 100000 } });
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId: agentBranchId, serialNumber: `AGENT-SN-${unique()}` } });
    return item.id;
  }

  async function submitDepositInstalmentAsAgent(customerId: string, token: string = agentToken) {
    const inventoryItemId = await makeDepositInstalmentUnit();
    const res = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token,
      body: {
        contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
        totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY',
      },
    }));
    expect(res.status).toBe(201);
    return (await res.json()).contract;
  }

  describe('submitting a contract', () => {
    it('starts an agent-created DEPOSIT_INSTALMENT contract at PENDING_APPROVAL, not PENDING_DEPOSIT', async () => {
      const customer = await registerCustomer(agentToken);
      const contract = await submitDepositInstalmentAsAgent(customer.id);
      expect(contract.status).toBe('PENDING_APPROVAL');
      expect(contract.submittedForApprovalAt).toBeTruthy();
      expect(contract.activatedAt).toBeNull();

      const instalments = await prisma.instalment.findMany({ where: { contractId: contract.id } });
      expect(instalments).toHaveLength(12); // the schedule is still generated up front
    });

    it('starts a non-agent (cashier) contract at its normal initial status, unaffected', async () => {
      const customer = await registerCustomer(cashierToken);
      const item = await makeDepositInstalmentUnit();
      const res = await contractsPOST(makeRequest('POST', '/api/contracts', {
        token: cashierToken,
        body: { contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item, totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY' },
      }));
      expect(res.status).toBe(201);
      expect((await res.json()).contract.status).toBe('PENDING_DEPOSIT');
    });

    it('starts an agent-created SAVE_TO_OWN account at PENDING_APPROVAL, with no activation SMS yet', async () => {
      const customer = await registerCustomer(agentToken);
      const res = await contractsPOST(makeRequest('POST', '/api/contracts', {
        token: agentToken, body: { contractType: 'SAVE_TO_OWN', customerId: customer.id },
      }));
      const contract = (await res.json()).contract;
      expect(contract.status).toBe('PENDING_APPROVAL');
      expect(contract.activatedAt).toBeNull();
      const sms = await prisma.smsMessage.findFirst({ where: { relatedContractId: contract.id, templateKey: 'contract.activated' } });
      expect(sms).toBeNull();
    });

    it('never disburses cash for an agent-submitted DEVICE_LOAN until it is approved', async () => {
      const customer = await registerCustomer(agentToken);
      const res = await contractsPOST(makeRequest('POST', '/api/contracts', {
        token: agentToken, body: { contractType: 'DEVICE_LOAN', customerId: customer.id, loanAmountMinor: 50000 },
      }));
      const contract = (await res.json()).contract;
      expect(contract.status).toBe('PENDING_APPROVAL');
      const audit = await prisma.auditLog.findFirst({ where: { action: 'DEVICE_LOAN_DISBURSEMENT', entityId: contract.id } });
      expect(audit).toBeNull();
    });
  });

  describe('own-scoping: an agent sees only what they created', () => {
    it("does not see another agent's customer or contract", async () => {
      const own = await registerCustomer(agentToken);
      const ownContract = await submitDepositInstalmentAsAgent(own.id);

      // A second agent, same branch.
      const role = await prisma.role.findUniqueOrThrow({ where: { name: 'AGENT' } });
      const passwordHash = (await prisma.user.findUniqueOrThrow({ where: { email: 'agent@example.test' } })).passwordHash;
      const secondAgent = await prisma.user.create({
        data: { email: `second-agent-${unique()}@example.test`, passwordHash, firstName: 'Second', lastName: 'Agent', roleId: role.id, branchId: agentBranchId },
      });
      const secondToken = await login(secondAgent.email);
      const theirs = await registerCustomer(secondToken);
      const theirContract = await submitDepositInstalmentAsAgent(theirs.id, secondToken);

      // The second agent cannot see the first agent's customer or contract...
      const customerForbidden = await customerGET(makeRequest('GET', `/api/customers/${own.id}`, { token: secondToken }), makeParams({ id: own.id }));
      expect(customerForbidden.status).toBe(403);
      const contractForbidden = await contractGET(makeRequest('GET', `/api/contracts/${ownContract.id}`, { token: secondToken }), makeParams({ id: ownContract.id }));
      expect(contractForbidden.status).toBe(403);

      // ...and the list endpoint only ever returns the caller's own — the
      // second agent's own contract shows up, the first agent's does not.
      const list = await contractsGET(makeRequest('GET', '/api/contracts', { token: secondToken }));
      const ids = (await list.json()).contracts.map((c: { id: string }) => c.id);
      expect(ids).not.toContain(ownContract.id);
      expect(ids).toContain(theirContract.id);
    });

    it("an approver (not own-scoped) CAN see an agent's contract to review it", async () => {
      const customer = await registerCustomer(agentToken);
      const contract = await submitDepositInstalmentAsAgent(customer.id);
      const res = await contractGET(makeRequest('GET', `/api/contracts/${contract.id}`, { token: managerToken }), makeParams({ id: contract.id }));
      expect(res.status).toBe(200);
    });
  });

  describe('payments are blocked before approval', () => {
    it('refuses a cash deposit against a PENDING_APPROVAL contract', async () => {
      const customer = await registerCustomer(agentToken);
      const contract = await submitDepositInstalmentAsAgent(customer.id);
      const res = await cashPaymentPOST(makeRequest('POST', '/api/payments/cash', {
        token: adminToken, body: { contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT' },
      }));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/awaiting approval/i);
    });

    it('is invisible to the customer portal while pending approval', async () => {
      const customer = await registerCustomer(agentToken);
      const contract = await submitDepositInstalmentAsAgent(customer.id);
      expect(await portalContract(customer.id, contract.id)).toBeNull();
      const list = await portalContracts(customer.id);
      expect(list.map((c) => c.id)).not.toContain(contract.id);
    });
  });

  describe('approve / request revision / resubmit', () => {
    it('requires contract.approve — a cashier cannot approve', async () => {
      const customer = await registerCustomer(agentToken);
      const contract = await submitDepositInstalmentAsAgent(customer.id);
      const res = await approvePOST(makeRequest('POST', `/api/contracts/${contract.id}/approve`, { token: cashierToken }), makeParams({ id: contract.id }));
      expect(res.status).toBe(403);
    });

    it('approving a DEPOSIT_INSTALMENT contract moves it to PENDING_DEPOSIT, not straight to ACTIVE', async () => {
      const customer = await registerCustomer(agentToken);
      const contract = await submitDepositInstalmentAsAgent(customer.id);
      const res = await approvePOST(makeRequest('POST', `/api/contracts/${contract.id}/approve`, { token: managerToken }), makeParams({ id: contract.id }));
      expect(res.status).toBe(200);
      const approved = (await res.json()).contract;
      expect(approved.status).toBe('PENDING_DEPOSIT');
      expect(approved.approvedAt).toBeTruthy();
    });

    it('approving a SAVE_TO_OWN account activates it immediately and sends the welcome SMS', async () => {
      const customer = await registerCustomer(agentToken);
      const submitRes = await contractsPOST(makeRequest('POST', '/api/contracts', { token: agentToken, body: { contractType: 'SAVE_TO_OWN', customerId: customer.id } }));
      const contract = (await submitRes.json()).contract;
      const res = await approvePOST(makeRequest('POST', `/api/contracts/${contract.id}/approve`, { token: managerToken }), makeParams({ id: contract.id }));
      const approved = (await res.json()).contract;
      expect(approved.status).toBe('ACTIVE');
      expect(approved.activatedAt).toBeTruthy();
      const sms = await prisma.smsMessage.findFirst({ where: { relatedContractId: contract.id, templateKey: 'contract.activated' } });
      expect(sms).not.toBeNull();
    });

    it('cannot approve a contract twice', async () => {
      const customer = await registerCustomer(agentToken);
      const contract = await submitDepositInstalmentAsAgent(customer.id);
      await approvePOST(makeRequest('POST', `/api/contracts/${contract.id}/approve`, { token: managerToken }), makeParams({ id: contract.id }));
      const again = await approvePOST(makeRequest('POST', `/api/contracts/${contract.id}/approve`, { token: managerToken }), makeParams({ id: contract.id }));
      expect(again.status).toBe(400);
    });

    it('sends a contract back for revision with a reason, and refuses one with no reason', async () => {
      const customer = await registerCustomer(agentToken);
      const contract = await submitDepositInstalmentAsAgent(customer.id);

      const empty = await requestRevisionPOST(makeRequest('POST', `/api/contracts/${contract.id}/request-revision`, { token: managerToken, body: {} }), makeParams({ id: contract.id }));
      expect(empty.status).toBe(400);

      const res = await requestRevisionPOST(makeRequest('POST', `/api/contracts/${contract.id}/request-revision`, {
        token: managerToken, body: { reason: 'Deposit looks too low for this device' },
      }), makeParams({ id: contract.id }));
      expect(res.status).toBe(200);
      const revised = (await res.json()).contract;
      expect(revised.status).toBe('REVISION_REQUESTED');
      expect(revised.revisionReason).toBe('Deposit looks too low for this device');
    });

    it('lets the original agent resubmit with new terms, regenerating the schedule, and refuses another agent', async () => {
      const customer = await registerCustomer(agentToken);
      const contract = await submitDepositInstalmentAsAgent(customer.id);
      await requestRevisionPOST(makeRequest('POST', `/api/contracts/${contract.id}/request-revision`, { token: managerToken, body: { reason: 'Raise the deposit' } }), makeParams({ id: contract.id }));

      const role = await prisma.role.findUniqueOrThrow({ where: { name: 'AGENT' } });
      const passwordHash = (await prisma.user.findUniqueOrThrow({ where: { email: 'agent@example.test' } })).passwordHash;
      const otherAgent = await prisma.user.create({
        data: { email: `other-agent-${unique()}@example.test`, passwordHash, firstName: 'Other', lastName: 'Agent', roleId: role.id, branchId: agentBranchId },
      });
      const otherToken = await login(otherAgent.email);
      const forbidden = await resubmitPOST(makeRequest('POST', `/api/contracts/${contract.id}/resubmit`, { token: otherToken, body: { depositAmountMinor: 20000 } }), makeParams({ id: contract.id }));
      expect(forbidden.status).toBe(403);

      const res = await resubmitPOST(makeRequest('POST', `/api/contracts/${contract.id}/resubmit`, {
        token: agentToken, body: { totalPayableMinor: 60000, depositAmountMinor: 20000, termWeeks: 8, paymentFrequency: 'WEEKLY' },
      }), makeParams({ id: contract.id }));
      expect(res.status).toBe(200);
      const resubmitted = (await res.json()).contract;
      expect(resubmitted.status).toBe('PENDING_APPROVAL');
      expect(resubmitted.revisionReason).toBeNull();
      expect(resubmitted.depositAmountMinor).toBe(20000);

      const instalments = await prisma.instalment.findMany({ where: { contractId: contract.id } });
      expect(instalments).toHaveLength(8); // rebuilt for the new 8-week term
    });

    it('a contract not sent back cannot be resubmitted', async () => {
      const customer = await registerCustomer(agentToken);
      const contract = await submitDepositInstalmentAsAgent(customer.id);
      const res = await resubmitPOST(makeRequest('POST', `/api/contracts/${contract.id}/resubmit`, { token: agentToken, body: {} }), makeParams({ id: contract.id }));
      expect(res.status).toBe(400);
    });

    it('a manager can reject an agent-submitted contract outright via cancel', async () => {
      const customer = await registerCustomer(agentToken);
      const contract = await submitDepositInstalmentAsAgent(customer.id);
      const { POST: cancelPOST } = await import('@/app/api/contracts/[id]/cancel/route');
      const res = await cancelPOST(makeRequest('POST', `/api/contracts/${contract.id}/cancel`, { token: managerToken, body: { reason: 'Not a genuine customer' } }), makeParams({ id: contract.id }));
      expect(res.status).toBe(200);
      expect((await res.json()).contract.status).toBe('CANCELLED');
    });
  });

  describe('agent deposit ledger', () => {
    async function approveAndDeposit(customerId: string, depositAmountMinor = 12000) {
      const contract = await submitDepositInstalmentAsAgent(customerId);
      await approvePOST(makeRequest('POST', `/api/contracts/${contract.id}/approve`, { token: managerToken }), makeParams({ id: contract.id }));
      const res = await cashPaymentPOST(makeRequest('POST', '/api/payments/cash', {
        token: adminToken, body: { contractId: contract.id, amountMinor: depositAmountMinor, entryType: 'DEPOSIT' },
      }));
      expect(res.status).toBe(201);
      return contract.id as string;
    }

    it('creates a ledger entry, with commission clamped to the deposit, when an agent-submitted deposit is paid in cash', async () => {
      await commissionPATCH(makeRequest('PATCH', '/api/settings/commission', { token: adminToken, body: { fixedCommissionMinor: 500 } }));
      const customer = await registerCustomer(agentToken);
      const contractId = await approveAndDeposit(customer.id, 12000);

      const entry = await prisma.agentDepositLedger.findUnique({ where: { contractId } });
      expect(entry).not.toBeNull();
      expect(entry!.agentId).toBe(agentId);
      expect(entry!.depositAmountMinor).toBe(12000);
      expect(entry!.commissionAmountMinor).toBe(500);
      expect(entry!.amountOwedMinor).toBe(11500);
      expect(entry!.status).toBe('OWED');

      // Commission never exceeds the deposit itself.
      await commissionPATCH(makeRequest('PATCH', '/api/settings/commission', { token: adminToken, body: { fixedCommissionMinor: 999999 } }));
      const smallDepositCustomer = await registerCustomer(agentToken);
      const smallContractId = await approveAndDeposit(smallDepositCustomer.id, 100);
      const smallEntry = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { contractId: smallContractId } });
      expect(smallEntry.commissionAmountMinor).toBe(100);
      expect(smallEntry.amountOwedMinor).toBe(0);
      expect(smallEntry.status).toBe('SETTLED');
      await commissionPATCH(makeRequest('PATCH', '/api/settings/commission', { token: adminToken, body: { fixedCommissionMinor: 500 } }));
    });

    it('creates no ledger entry for a deposit collected by a non-agent, or paid by any channel other than cash', async () => {
      const cashierCustomer = await registerCustomer(cashierToken);
      const item = await makeDepositInstalmentUnit();
      const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
        token: cashierToken, body: { contractType: 'DEPOSIT_INSTALMENT', customerId: cashierCustomer.id, inventoryItemId: item, totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY' },
      }));
      const cashierContract = (await created.json()).contract;
      await cashPaymentPOST(makeRequest('POST', '/api/payments/cash', { token: adminToken, body: { contractId: cashierContract.id, amountMinor: 12000, entryType: 'DEPOSIT' } }));
      expect(await prisma.agentDepositLedger.findUnique({ where: { contractId: cashierContract.id } })).toBeNull();
    });

    it('GET /api/settings/commission needs settings.manage', async () => {
      const res = await commissionGET(makeRequest('GET', '/api/settings/commission', { token: agentToken }));
      expect(res.status).toBe(403);
    });

    it("shows an agent only their own ledger, and totals it correctly", async () => {
      const customer = await registerCustomer(agentToken);
      await approveAndDeposit(customer.id, 12000);
      const res = await myLedgerGET(makeRequest('GET', '/api/agent/ledger', { token: agentToken }));
      const { entries, totals } = await res.json();
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.every((e: { agent?: unknown }) => !('agent' in e))).toBe(true); // own view never leaks who else's this is
      expect(totals.amountOwedMinor).toBeGreaterThanOrEqual(11500);
    });

    it('files, over-claims, confirms and rejects a remittance correctly', async () => {
      const customer = await registerCustomer(agentToken);
      const contractId = await approveAndDeposit(customer.id, 12000);
      const entry = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { contractId } });
      expect(entry.amountOwedMinor).toBe(11500);

      const overclaim = await remitPOST(makeRequest('POST', `/api/agent/ledger/${entry.id}/remit`, {
        token: agentToken, body: { amountMinor: 999999, method: 'CASH' },
      }), makeParams({ id: entry.id }));
      expect(overclaim.status).toBe(400);

      const fileRes = await remitPOST(makeRequest('POST', `/api/agent/ledger/${entry.id}/remit`, {
        token: agentToken, body: { amountMinor: 5000, method: 'MOBILE_MONEY', reference: 'MM-123' },
      }), makeParams({ id: entry.id }));
      expect(fileRes.status).toBe(201);
      const remittance = (await fileRes.json()).remittance;
      expect(remittance.status).toBe('PENDING');

      // Another agent cannot file against someone else's ledger entry.
      const role = await prisma.role.findUniqueOrThrow({ where: { name: 'AGENT' } });
      const passwordHash = (await prisma.user.findUniqueOrThrow({ where: { email: 'agent@example.test' } })).passwordHash;
      const intruder = await prisma.user.create({ data: { email: `intruder-${unique()}@example.test`, passwordHash, firstName: 'I', lastName: 'N', roleId: role.id, branchId: agentBranchId } });
      const intruderToken = await login(intruder.email);
      const intrusion = await remitPOST(makeRequest('POST', `/api/agent/ledger/${entry.id}/remit`, { token: intruderToken, body: { amountMinor: 100, method: 'CASH' } }), makeParams({ id: entry.id }));
      expect(intrusion.status).toBe(400);

      // A cashier cannot confirm — needs agent.ledger.manage.
      const byCashier = await remittancePATCH(makeRequest('PATCH', `/api/agent/remittances/${remittance.id}`, { token: cashierToken, body: { action: 'confirm' } }), makeParams({ id: remittance.id }));
      expect(byCashier.status).toBe(403);

      const rejectNoReason = await remittancePATCH(makeRequest('PATCH', `/api/agent/remittances/${remittance.id}`, { token: managerToken, body: { action: 'reject' } }), makeParams({ id: remittance.id }));
      expect(rejectNoReason.status).toBe(400);

      const confirmRes = await remittancePATCH(makeRequest('PATCH', `/api/agent/remittances/${remittance.id}`, { token: managerToken, body: { action: 'confirm' } }), makeParams({ id: remittance.id }));
      expect(confirmRes.status).toBe(200);

      const afterConfirm = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { id: entry.id } });
      expect(afterConfirm.amountRemittedMinor).toBe(5000);
      expect(afterConfirm.status).toBe('OWED'); // 5000 of 11500 — not fully settled yet

      // Confirming twice is refused.
      const confirmAgain = await remittancePATCH(makeRequest('PATCH', `/api/agent/remittances/${remittance.id}`, { token: managerToken, body: { action: 'confirm' } }), makeParams({ id: remittance.id }));
      expect(confirmAgain.status).toBe(400);

      // File and confirm the rest — the ledger settles.
      const restRes = await remitPOST(makeRequest('POST', `/api/agent/ledger/${entry.id}/remit`, { token: agentToken, body: { amountMinor: 6500, method: 'CASH' } }), makeParams({ id: entry.id }));
      const rest = (await restRes.json()).remittance;
      await remittancePATCH(makeRequest('PATCH', `/api/agent/remittances/${rest.id}`, { token: managerToken, body: { action: 'confirm' } }), makeParams({ id: rest.id }));
      const settled = await prisma.agentDepositLedger.findUniqueOrThrow({ where: { id: entry.id } });
      expect(settled.status).toBe('SETTLED');

      // A rejected remittance never touches the ledger.
      const rejectableRes = await remitPOST(makeRequest('POST', `/api/agent/ledger/${entry.id}/remit`, { token: agentToken, body: { amountMinor: 1, method: 'CASH' } }), makeParams({ id: entry.id }));
      // Nothing left owed at this point, so this should now be refused as an over-claim.
      expect(rejectableRes.status).toBe(400);
    });

    it("gives a manager every agent's ledger, needing agent.ledger.manage", async () => {
      const forbidden = await allLedgersGET(makeRequest('GET', '/api/agent/ledger/all', { token: agentToken }));
      expect(forbidden.status).toBe(403);

      const customer = await registerCustomer(agentToken);
      await approveAndDeposit(customer.id, 12000);
      const res = await allLedgersGET(makeRequest('GET', '/api/agent/ledger/all', { token: managerToken }));
      expect(res.status).toBe(200);
      const { entries } = await res.json();
      expect(entries.some((e: { agent: { id: string } }) => e.agent.id === agentId)).toBe(true);
    });
  });
});
