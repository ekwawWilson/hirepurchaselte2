/**
 * An agent paying in the cash they hold by dialling the short code: settled
 * against their ledger when the money arrives, with no one confirming it,
 * and never recorded as a second payment from the customer.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, freshPhone, withLiveHubtel, hubtelHttp } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { PATCH as userPATCH } from '@/app/api/users/[id]/route';
import { GET as usersGET, POST as usersPOST } from '@/app/api/users/route';
import { GET as paymentPinGET } from '@/app/api/agent/payment-pin/route';
import { createContract, approveContract } from '@/lib/services/contractService';
import { postPayment } from '@/lib/services/paymentService';
import { handleUssdInput } from '@/lib/services/ussdService';
import { processHubtelCallback, reconcilePendingHubtelTransactions } from '@/lib/services/hubtelPaymentService';
import { processServiceFulfilment } from '@/lib/services/ussdCheckoutService';
import { agentDepositsToPay, fileRemittance, openUssdRemittance } from '@/lib/services/agentLedgerService';
import { hashPassword } from '@/lib/services/authService';
import { issueAgentPaymentPin } from '@/lib/services/agentPaymentPinService';
import { AGENT_DEPOSIT_CHANNEL } from '@/lib/constants/agents';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
const unique = () => `${runId}${++counter}`;
const PASSWORD = 'Passw0rd!123';

beforeAll(enableOptionalContractTypes);

describe('Agents paying in deposits on the short code', () => {
  let branchId: string;
  let managerId: string;
  let cashierId: string;

  beforeAll(async () => {
    const seededAgent = await prisma.user.findFirstOrThrow({ where: { email: 'agent@example.test' } });
    branchId = seededAgent.branchId!;
    managerId = (await prisma.user.findFirstOrThrow({ where: { email: 'branchmanager@example.test' } })).id;
    cashierId = (await prisma.user.findFirstOrThrow({ where: { email: 'cashier@example.test' } })).id;
    await prisma.commissionSettings.upsert({ where: { id: 'singleton' }, create: { id: 'singleton', fixedCommissionMinor: 500 }, update: { fixedCommissionMinor: 500 } });
  });

  async function makeAgent() {
    const role = await prisma.role.findUniqueOrThrow({ where: { name: 'AGENT' } });
    const phone = await freshPhone('054');
    const user = await prisma.user.create({
      data: { email: `agent-ussd-${unique()}@example.test`, phone, passwordHash: await hashPassword(PASSWORD), firstName: 'Ussd', lastName: `Agent${counter}`, roleId: role.id, branchId },
    });
    return { user, phone, pin: await issueAgentPaymentPin(user.id) };
  }

  /** An approved sale the agent took the GHS 120 deposit on: after GHS 5 commission they owe GHS 115. */
  async function owedSale(agentId: string, customerFirstName = 'Ama') {
    const product = await prisma.product.create({ data: { sku: `USSD-${unique()}`, name: 'Agent Phone', cashPriceMinor: 100000 } });
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `USSD-SN-${unique()}`, assignedAgentId: agentId } });
    const customer = await prisma.customer.create({
      data: { membershipId: `USSD-${unique()}`, firstName: customerFirstName, lastName: 'Mensah', phone: await freshPhone(), branchId, createdById: agentId },
    });
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item.id, branchId, createdById: agentId, requiresApproval: true,
      totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY',
    });
    await approveContract({ contractId: contract.id, approvedById: managerId });
    await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: cashierId, collectedByAgentId: agentId });
    return contract;
  }

  const ledgerOf = (contractId: string) => prisma.agentDepositLedger.findUniqueOrThrow({ where: { contractId } });
  const remittancesOf = (agentId: string) => prisma.agentRemittance.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } });

  async function dial(msisdn: string, ...inputs: string[]) {
    const sessionId = `agent-ussd-${unique()}`;
    let last = await handleUssdInput({ sessionId, msisdn, input: '', isNewSession: true });
    for (const input of inputs) last = await handleUssdInput({ sessionId, msisdn, input, isNewSession: false });
    return { last, sessionId };
  }

  const superAdminToken = async () => (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email: 'superadmin@example.test', password: PASSWORD } }))).json()).token as string;

  it('shows the option to everyone, but only an active agent\'s PIN gets past it', async () => {
    const { user, pin } = await makeAgent();
    await owedSale(user.id, 'Esi');
    const stranger = await freshPhone('055');

    expect((await dial(stranger)).last.message).toContain('3. Agent deposits');
    expect((await dial(stranger, '3')).last.message).toContain('Enter your agent payment PIN');
    expect((await dial(stranger, '3', '12')).last.message).toContain('Wrong PIN');
    expect((await dial(stranger, '3', '0')).last.message).toContain('1. Self payment');

    // Any phone will do once the PIN is right: this one is on no one's record.
    expect((await dial(stranger, '3', pin)).last.message).toContain('You owe GHS115.00 for Esi M');

    await prisma.user.update({ where: { id: user.id }, data: { isActive: false } });
    expect((await dial(stranger, '3', pin)).last.message).toContain('Wrong PIN');
    await prisma.user.update({ where: { id: user.id }, data: { isActive: true } });
  });

  it('stops a phone guessing PINs for an hour, and a right PIN clears earlier slips', async () => {
    const { user, pin } = await makeAgent();
    await owedSale(user.id);
    const guesser = await freshPhone('055');

    const slips = await dial(guesser, '3', '000001', '000002', '000003', '000004');
    expect(slips.last.message).toContain('Wrong PIN');
    expect((await dial(guesser, '3', pin)).last.message).toContain('You owe');
    expect(await prisma.agentPinFailure.count({ where: { msisdn: guesser } })).toBe(0);

    const blocked = await dial(guesser, '3', '000001', '000002', '000003', '000004', '000005');
    expect(blocked.last).toMatchObject({ continueSession: false });
    expect(blocked.last.message).toContain('Too many wrong PINs');
    // Even the right PIN is refused now, and the prompt is not offered.
    expect((await dial(guesser, '3')).last.message).toContain('Too many wrong PINs');

    await prisma.agentPinFailure.updateMany({ where: { msisdn: guesser }, data: { createdAt: new Date(Date.now() - 2 * 3_600_000) } });
    expect((await dial(guesser, '3', pin)).last.message).toContain('You owe');
  });

  it('tells a PIN holder with nothing to pay, and texts the paying phone when no number is on record', async () => {
    const { user, pin } = await makeAgent();
    const payer = await freshPhone('055');
    expect((await dial(payer, '3', pin)).last.message).toContain('nothing to pay in');

    await prisma.user.update({ where: { id: user.id }, data: { phone: null } });
    const contract = await owedSale(user.id, 'Abena');
    await dial(payer, '3', pin, '115', '1');
    expect(await ledgerOf(contract.id)).toMatchObject({ status: 'SETTLED' });
    expect(await prisma.smsMessage.count({ where: { recipient: payer, templateKey: 'agent.remittance_received' } })).toBe(1);
  });

  it('issues a unique PIN with a new agent or a move to agent, shows it only to its owner, and keeps it off the staff list', async () => {
    const token = await superAdminToken();
    const created = await usersPOST(makeRequest('POST', '/api/users', { token, body: { email: `pin-agent-${unique()}@example.test`, password: 'A-Long-Passw0rd!x', firstName: 'Pin', lastName: 'Agent', role: 'AGENT', branchId } }));
    expect(created.status).toBe(201);
    const { user: newAgent } = await created.json();
    expect(newAgent.paymentPin).toBeUndefined();
    const saved = await prisma.user.findUniqueOrThrow({ where: { id: newAgent.id } });
    expect(saved.paymentPin).toMatch(/^[1-9]\d{5}$/);

    const cashierRole = await prisma.role.findUniqueOrThrow({ where: { name: 'CASHIER' } });
    const clerk = await prisma.user.create({ data: { email: `pin-clerk-${unique()}@example.test`, passwordHash: await hashPassword(PASSWORD), firstName: 'Pin', lastName: 'Clerk', roleId: cashierRole.id, branchId } });
    expect(clerk.paymentPin).toBeNull();
    const moved = await userPATCH(makeRequest('PATCH', `/api/users/${clerk.id}`, { token, body: { role: 'AGENT' } }), makeParams({ id: clerk.id }));
    expect(moved.status).toBe(200);
    const clerkPin = (await prisma.user.findUniqueOrThrow({ where: { id: clerk.id } })).paymentPin;
    expect(clerkPin).toMatch(/^\d{6}$/);
    expect(clerkPin).not.toBe(saved.paymentPin);

    const staffList = await (await usersGET(makeRequest('GET', '/api/users', { token }))).text();
    expect(staffList).not.toContain('paymentPin');

    const { user: agent, pin } = await makeAgent();
    const agentToken = (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email: agent.email, password: PASSWORD } }))).json()).token as string;
    const own = await paymentPinGET(makeRequest('GET', '/api/agent/payment-pin', { token: agentToken }));
    expect(await own.json()).toEqual({ pin });
    expect((await paymentPinGET(makeRequest('GET', '/api/agent/payment-pin', { token }))).status).toBe(403);
  });

  it('credits the ledger when the money arrives, with no confirmation and no second customer payment', async () => {
    const { user, phone, pin } = await makeAgent();
    const contract = await owedSale(user.id, 'Efua');
    const before = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    const paymentsBefore = await prisma.payment.count({ where: { contractId: contract.id } });

    const amountScreen = await dial(phone, '3', pin);
    expect(amountScreen.last.message).toContain('You owe GHS115.00 for Efua M');
    const { last, sessionId } = await dial(phone, '3', pin, '115', '1');
    expect(last.message).toContain('Payment successful');
    expect(sessionId).toBeTruthy();

    expect(await ledgerOf(contract.id)).toMatchObject({ amountRemittedMinor: 11500, status: 'SETTLED' });
    expect(await remittancesOf(user.id)).toMatchObject([{ status: 'CONFIRMED', method: 'MOBILE_MONEY', amountMinor: 11500, confirmedById: null }]);

    const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(after.totalPaidMinor).toBe(before.totalPaidMinor);
    expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(paymentsBefore);
    const txn = await prisma.hubtelTransaction.findFirstOrThrow({ where: { contractId: contract.id, channel: AGENT_DEPOSIT_CHANNEL } });
    expect(txn).toMatchObject({ status: 'SUCCESS', paymentId: null });
    expect(txn.resolvedAt).not.toBeNull();

    // Nothing left to pay in.
    expect((await dial(phone, '3', pin)).last.message).toContain('nothing to pay in');
  });

  it('takes part of what is owed, and refuses more than is owed or a bad amount', async () => {
    const { user, phone, pin } = await makeAgent();
    const contract = await owedSale(user.id);

    expect((await dial(phone, '3', pin, '200')).last.message).toContain('That is more than you owe');
    expect((await dial(phone, '3', pin, '0.5')).last.message).toContain('The smallest payment');
    expect((await dial(phone, '3', pin, 'abc')).last.message).toContain('Enter the amount in cedis');
    expect((await dial(phone, '3', pin, '40', '2')).last.message).toBe('Payment cancelled.');
    expect(await remittancesOf(user.id)).toHaveLength(0);

    await dial(phone, '3', pin, '40', '1');
    expect(await ledgerOf(contract.id)).toMatchObject({ amountRemittedMinor: 4000, status: 'OWED' });
    expect((await dial(phone, '3', pin)).last.message).toContain('You owe GHS75.00');
  });

  it('pays all sales oldest first, or just the one chosen', async () => {
    const { user, phone, pin } = await makeAgent();
    const first = await owedSale(user.id, 'Akua');
    const second = await owedSale(user.id, 'Kojo');
    const third = await owedSale(user.id, 'Yaa');

    const list = await dial(phone, '3', pin);
    expect(list.last.message).toContain('You owe GHS345.00');
    expect(list.last.message).toContain('1. Pay all');
    expect(list.last.message).toContain('2. Akua M GHS115.00');
    expect(list.last.message).toContain('4. Yaa M GHS115.00');
    expect(list.last.message.length).toBeLessThanOrEqual(160);

    expect((await dial(phone, '3', pin, '9')).last.message).toContain('Not on the list');

    await dial(phone, '3', pin, '3', '115', '1'); // Kojo's only
    expect(await ledgerOf(second.id)).toMatchObject({ status: 'SETTLED' });
    expect(await ledgerOf(first.id)).toMatchObject({ amountRemittedMinor: 0 });

    await dial(phone, '3', pin, '1', '1'); // Pay all
    expect(await ledgerOf(first.id)).toMatchObject({ amountRemittedMinor: 11500, status: 'SETTLED' });
    expect(await ledgerOf(third.id)).toMatchObject({ amountRemittedMinor: 11500, status: 'SETTLED' });
  });

  it('credits nothing on a failed charge, makes it payable again, and still lands a late success once', async () => {
    const { user } = await makeAgent();
    const contract = await owedSale(user.id);
    const clientReference = `agent-charge-${unique()}`;
    await openUssdRemittance({ agentId: user.id, amountMinor: 11500, clientReference });
    await prisma.hubtelTransaction.create({ data: { clientReference, contractId: contract.id, msisdn: '0540000000', amountMinor: 11500, status: 'PENDING', channel: AGENT_DEPOSIT_CHANNEL } });

    // On its way: neither the short code nor a filed claim can pay it twice.
    expect(await agentDepositsToPay(user.id)).toHaveLength(0);
    const ledger = await ledgerOf(contract.id);
    await expect(fileRemittance({ ledgerId: ledger.id, agentId: user.id, amountMinor: 100, method: 'CASH' })).rejects.toThrow('You owe at most GHS 0.00');

    await processHubtelCallback({ clientReference, status: 'FAILED', rawPayload: '{}' });
    expect(await remittancesOf(user.id)).toMatchObject([{ status: 'PAYMENT_FAILED' }]);
    expect(await ledgerOf(contract.id)).toMatchObject({ amountRemittedMinor: 0, status: 'OWED' });
    expect(await agentDepositsToPay(user.id)).toMatchObject([{ payableMinor: 11500 }]);

    await processHubtelCallback({ clientReference, status: 'SUCCESS', rawPayload: '{}' });
    await processHubtelCallback({ clientReference, status: 'SUCCESS', rawPayload: '{}' });
    expect(await ledgerOf(contract.id)).toMatchObject({ amountRemittedMinor: 11500, status: 'SETTLED' });

    // The sweep that retries unposted charges leaves it alone.
    await prisma.hubtelTransaction.update({ where: { clientReference }, data: { updatedAt: new Date(Date.now() - 3_600_000) } });
    await reconcilePendingHubtelTransactions();
    expect(await ledgerOf(contract.id)).toMatchObject({ amountRemittedMinor: 11500 });
  });

  it('goes through Hubtel checkout on the live path, as a charge named for what it is', async () => {
    const { user, phone, pin } = await makeAgent();
    const contract = await owedSale(user.id);
    let sessionId = '';
    let checkout: { itemName: string; amountMinor: number } | undefined;
    await withLiveHubtel(() => hubtelHttp(200, {}), async () => {
      const result = await dial(phone, '3', pin, '115', '1');
      sessionId = result.sessionId;
      checkout = result.last.checkout;
    });
    expect(checkout).toEqual({ itemName: 'Agent deposit', amountMinor: 11500 });
    expect(await ledgerOf(contract.id)).toMatchObject({ amountRemittedMinor: 0 });

    await withLiveHubtel(() => hubtelHttp(200, {}), async () => {
      const outcome = await processServiceFulfilment({
        SessionId: sessionId, OrderId: `ORD-${unique()}`,
        OrderInfo: { Status: 'Paid', Payment: { IsSuccessful: true, AmountPaid: 115 }, Items: [{ UnitPrice: 115, Quantity: 1 }] },
      });
      expect(outcome).toEqual({ matched: true, serviceStatus: 'success' });
    });
    expect(await ledgerOf(contract.id)).toMatchObject({ amountRemittedMinor: 11500, status: 'SETTLED' });
  });

  it('keeps a usable, unique mobile number on the staff record', async () => {
    const token = await superAdminToken();
    const a = await makeAgent();
    const b = await makeAgent();
    const patch = (id: string, phone: string) => userPATCH(makeRequest('PATCH', `/api/users/${id}`, { token, body: { phone } }), makeParams({ id }));

    expect((await patch(b.user.id, 'not-a-number')).status).toBe(400);
    const taken = await patch(b.user.id, a.phone);
    expect(taken.status).toBe(400);
    expect((await taken.json()).error).toContain('already has this mobile number');

    const fresh = await freshPhone('024');
    const saved = await patch(b.user.id, fresh);
    expect(saved.status).toBe(200);
    expect((await saved.json()).user.phone).toBe(fresh);
    expect((await patch(b.user.id, '')).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: b.user.id } })).phone).toBeNull();
  });
});
