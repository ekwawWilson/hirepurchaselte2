/**
 * The customer portal (/api/portal): a customer signs in with a phone
 * number, sees only their own contracts, and pays through the same Hubtel
 * pipeline the USSD menu uses.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { createContract } from '@/lib/services/contractService';
import { POST as portalLoginPOST } from '@/app/api/portal/auth/login/route';
import { GET as portalMeGET } from '@/app/api/portal/me/route';
import { POST as portalPasswordPOST } from '@/app/api/portal/me/password/route';
import { GET as portalContractsGET } from '@/app/api/portal/contracts/route';
import { GET as portalContractGET } from '@/app/api/portal/contracts/[id]/route';
import { POST as portalPayPOST } from '@/app/api/portal/pay/route';
import { GET as customersGET } from '@/app/api/customers/route';
import { POST as loginPOST } from '@/app/api/auth/login/route';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;

// Save to Own and Device Loan must be activated before they can be created.
beforeAll(enableOptionalContractTypes);

describe('Customer portal', () => {
  let branchId: string;
  let adminUserId: string;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow()).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
  });

  async function makeCustomer() {
    counter += 1;
    const phone = `024${runId}${counter}`;
    const customer = await prisma.customer.create({
      data: {
        membershipId: `PORTAL-${runId}-${counter}`, firstName: 'Portal', lastName: 'Tester',
        phone, branchId, createdById: adminUserId,
      },
    });
    return { customer, phone };
  }

  async function signIn(phone: string, password: string) {
    const res = await portalLoginPOST(makeRequest('POST', '/api/portal/auth/login', { body: { phone, password } }));
    return { status: res.status, body: await res.json() };
  }

  it('signs in with the phone number as the first password, and says a change is due', async () => {
    const { phone } = await makeCustomer();

    const wrong = await signIn(phone, 'not-my-password');
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toMatch(/Invalid phone number or password/);

    const ok = await signIn(phone, phone);
    expect(ok.status).toBe(200);
    expect(ok.body.customer.mustChangePassword).toBe(true);
    expect(ok.body.token).toBeTruthy();

    // The same number written the way Hubtel sends it also works.
    const intl = await signIn(`233${phone.slice(1)}`, phone);
    expect(intl.status).toBe(200);
  });

  it('changes the password, refuses the phone number as the new one, and then requires it', async () => {
    const { phone } = await makeCustomer();
    const { body: session } = await signIn(phone, phone);
    const token = session.token as string;

    const asPhone = await portalPasswordPOST(makeRequest('POST', '/api/portal/me/password', {
      token, body: { currentPassword: phone, newPassword: phone },
    }));
    expect(asPhone.status).toBe(400);

    const tooShort = await portalPasswordPOST(makeRequest('POST', '/api/portal/me/password', {
      token, body: { currentPassword: phone, newPassword: 'abc' },
    }));
    expect(tooShort.status).toBe(400);

    const changed = await portalPasswordPOST(makeRequest('POST', '/api/portal/me/password', {
      token, body: { currentPassword: phone, newPassword: 'my-own-passphrase' },
    }));
    expect(changed.status).toBe(200);

    expect((await signIn(phone, phone)).status).toBe(401); // the phone number no longer works
    const now = await signIn(phone, 'my-own-passphrase');
    expect(now.status).toBe(200);
    expect(now.body.customer.mustChangePassword).toBe(false);

    const me = await portalMeGET(makeRequest('GET', '/api/portal/me', { token: now.body.token }));
    expect((await me.json()).customer.membershipId).toMatch(/^PORTAL-/);
  });

  it('keeps customer and staff tokens apart', async () => {
    const { phone } = await makeCustomer();
    const { body: session } = await signIn(phone, phone);

    // A portal token is refused by a staff route...
    const staffRoute = await customersGET(makeRequest('GET', '/api/customers', { token: session.token }));
    expect(staffRoute.status).toBe(401);

    // ...and a staff token is refused by the portal.
    const staffLogin = await loginPOST(makeRequest('POST', '/api/auth/login', {
      body: { email: 'admin@example.test', password: 'Passw0rd!123' },
    }));
    const staffToken = (await staffLogin.json()).token;
    const portalRoute = await portalMeGET(makeRequest('GET', '/api/portal/me', { token: staffToken }));
    expect(portalRoute.status).toBe(401);
  });

  it('shows only the signed-in customer\'s own contracts', async () => {
    const mine = await makeCustomer();
    const theirs = await makeCustomer();

    const myContract = await createContract({
      contractType: 'SAVE_TO_OWN', customerId: mine.customer.id, branchId, createdById: adminUserId,
    });
    const theirContract = await createContract({
      contractType: 'SAVE_TO_OWN', customerId: theirs.customer.id, branchId, createdById: adminUserId,
    });

    const { body: session } = await signIn(mine.phone, mine.phone);
    const token = session.token as string;

    const list = await portalContractsGET(makeRequest('GET', '/api/portal/contracts', { token }));
    const { contracts } = await list.json();
    expect(contracts.map((c: { id: string }) => c.id)).toEqual([myContract.id]);

    const ownDetail = await portalContractGET(
      makeRequest('GET', `/api/portal/contracts/${myContract.id}`, { token }), makeParams({ id: myContract.id }));
    expect(ownDetail.status).toBe(200);

    // Someone else's contract reads as missing, not as forbidden.
    const otherDetail = await portalContractGET(
      makeRequest('GET', `/api/portal/contracts/${theirContract.id}`, { token }), makeParams({ id: theirContract.id }));
    expect(otherDetail.status).toBe(404);
  });

  it('pays a savings contract by mobile money, and refuses a contract that is not the customer\'s', async () => {
    const mine = await makeCustomer();
    const theirs = await makeCustomer();
    const contract = await createContract({
      contractType: 'SAVE_TO_OWN', customerId: mine.customer.id, branchId, createdById: adminUserId,
    });
    const notMine = await createContract({
      contractType: 'SAVE_TO_OWN', customerId: theirs.customer.id, branchId, createdById: adminUserId,
    });

    const { body: session } = await signIn(mine.phone, mine.phone);
    const token = session.token as string;

    const foreign = await portalPayPOST(makeRequest('POST', '/api/portal/pay', {
      token, body: { contractId: notMine.id, amountMinor: 5000, network: 'MTN', msisdn: mine.phone },
    }));
    expect(foreign.status).toBe(404);

    const bad = await portalPayPOST(makeRequest('POST', '/api/portal/pay', {
      token, body: { contractId: contract.id, amountMinor: 0, network: 'MTN', msisdn: mine.phone },
    }));
    expect(bad.status).toBe(400);

    // Mock mode settles the charge at once, so the ledger already has it.
    const paid = await portalPayPOST(makeRequest('POST', '/api/portal/pay', {
      token, body: { contractId: contract.id, amountMinor: 5000, network: 'MTN', msisdn: mine.phone },
    }));
    expect(paid.status).toBe(201);

    const updated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(updated.totalPaidMinor).toBe(5000);
  });

  it('takes only the two exact amounts a device loan allows', async () => {
    const { customer, phone } = await makeCustomer();
    const loan = await createContract({
      contractType: 'DEVICE_LOAN', customerId: customer.id, branchId, createdById: adminUserId, loanAmountMinor: 80000,
    });
    await prisma.penalty.create({
      data: { contractId: loan.id, amountMinor: 800, reason: 'DAILY_LOAN_INTEREST', appliedDate: new Date() },
    });

    const { body: session } = await signIn(phone, phone);
    const token = session.token as string;

    const odd = await portalPayPOST(makeRequest('POST', '/api/portal/pay', {
      token, body: { contractId: loan.id, amountMinor: 1234, network: 'MTN', msisdn: phone },
    }));
    expect(odd.status).toBe(400);
    expect((await odd.json()).error).toMatch(/interest owed or the full loan amount/);

    const interest = await portalPayPOST(makeRequest('POST', '/api/portal/pay', {
      token, body: { contractId: loan.id, amountMinor: 800, network: 'MTN', msisdn: phone },
    }));
    expect(interest.status).toBe(201);

    const paid = await prisma.payment.findFirst({ where: { contractId: loan.id, entryType: 'LOAN_INTEREST_PAYMENT' } });
    expect(paid?.amountMinor).toBe(800);
  });
});
