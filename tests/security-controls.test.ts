/**
 * The controls around who gets in and who can take money off the books:
 * sign-in attempt limits, staff passwords (change, reset, forced change),
 * one-time portal passwords, a second person for reversals, write-offs and
 * paid-up cancellations, and what registration refuses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { makeRequest, makeParams, enableOptionalContractTypes, registrationFields, freshPhone, setSecondApproval } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as meGET } from '@/app/api/auth/me/route';
import { POST as passwordPOST } from '@/app/api/auth/password/route';
import { GET as usersGET, POST as usersPOST } from '@/app/api/users/route';
import { POST as resetPasswordPOST } from '@/app/api/users/[id]/reset-password/route';
import { POST as portalLoginPOST } from '@/app/api/portal/auth/login/route';
import { GET as customersGET, POST as customersPOST } from '@/app/api/customers/route';
import { PATCH as customerPATCH } from '@/app/api/customers/[id]/route';
import { POST as portalPasswordIssuePOST } from '@/app/api/customers/[id]/portal-password/route';
import { POST as reversePOST } from '@/app/api/payments/[id]/reverse/route';
import { POST as writeoffPOST } from '@/app/api/contracts/[id]/writeoff/route';
import { POST as cancelPOST } from '@/app/api/contracts/[id]/cancel/route';
import { GET as contractGET } from '@/app/api/contracts/[id]/route';
import { GET as approvalsGET } from '@/app/api/approvals/route';
import { POST as approvalDecidePOST } from '@/app/api/approvals/[id]/route';
import { createContract } from '@/lib/services/contractService';
import { postPayment } from '@/lib/services/paymentService';
import { issuePortalPassword } from '@/lib/services/customerPortalService';
import { hashPassword } from '@/lib/services/authService';
import { MAX_ACCOUNT_FAILURES } from '@/lib/auth/loginThrottle';

const PASSWORD = 'Passw0rd!123';
const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
const unique = () => `${runId}${++counter}`;

async function attempt(email: string, password: string) {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password } }));
  return { status: res.status, body: await res.json() };
}
const login = async (email: string, password = PASSWORD) => (await attempt(email, password)).body.token as string;

/** A staff account of its own, so locking it out or changing its password touches no other test. */
async function makeStaff(roleName: string, extra: { mustChangePassword?: boolean } = {}) {
  const role = await prisma.role.findUniqueOrThrow({ where: { name: roleName } });
  const branch = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } });
  return prisma.user.create({
    data: {
      email: `sec-${unique()}@example.test`, passwordHash: await hashPassword(PASSWORD), firstName: 'Sec', lastName: roleName,
      roleId: role.id, branchId: roleName === 'BRANCH_MANAGER' || roleName === 'CASHIER' ? branch.id : null, ...extra,
    },
  });
}

beforeAll(enableOptionalContractTypes);

describe('Sign-in attempt limits', () => {
  it('locks a staff account after repeated wrong passwords — the right one included — and says for how long', async () => {
    const user = await makeStaff('CASHIER');
    for (let i = 0; i < MAX_ACCOUNT_FAILURES; i++) expect((await attempt(user.email, 'wrong-password')).status).toBe(401);

    const locked = await attempt(user.email, PASSWORD);
    expect(locked.status).toBe(429);
    expect(locked.body.error).toMatch(/Too many failed sign-in attempts. Try again in 15 minutes/);

    // Once the lock has run out, the right password works and the count starts again.
    await prisma.loginThrottle.update({ where: { key: `staff:${user.email}` }, data: { lockedUntil: new Date(Date.now() - 1000), firstFailureAt: new Date(Date.now() - 16 * 60_000) } });
    expect((await attempt(user.email, PASSWORD)).status).toBe(200);
    expect(await prisma.loginThrottle.findUnique({ where: { key: `staff:${user.email}` } })).toBeNull();
  });

  it('a few slips followed by the right password are forgotten, and an unknown address is limited just the same', async () => {
    const user = await makeStaff('CASHIER');
    for (let i = 0; i < MAX_ACCOUNT_FAILURES - 1; i++) await attempt(user.email, 'wrong-password');
    expect((await attempt(user.email, PASSWORD)).status).toBe(200);
    for (let i = 0; i < MAX_ACCOUNT_FAILURES - 1; i++) expect((await attempt(user.email, 'wrong-password')).status).toBe(401);
    expect((await attempt(user.email, PASSWORD)).status).toBe(200);

    // Nothing about the limit tells a stranger which addresses have accounts.
    const nobody = `nobody-${unique()}@example.test`;
    for (let i = 0; i < MAX_ACCOUNT_FAILURES; i++) expect((await attempt(nobody, 'guess')).status).toBe(401);
    expect((await attempt(nobody, 'guess')).status).toBe(429);
  });

  it('limits guesses at a customer portal password the same way, however the number is written', async () => {
    const branch = await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } });
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } });
    const phone = await freshPhone();
    const customer = await prisma.customer.create({
      data: { membershipId: `SEC-${unique()}`, firstName: 'Locky', lastName: 'Portal', phone, branchId: branch.id, createdById: admin.id },
    });
    const password = await issuePortalPassword(customer.id);
    const signIn = async (number: string, pw: string) =>
      (await portalLoginPOST(makeRequest('POST', '/api/portal/auth/login', { body: { phone: number, password: pw } }))).status;

    const spellings = [phone, `233${phone.slice(1)}`, `+233${phone.slice(1)}`, `${phone.slice(0, 3)} ${phone.slice(3)}`, phone];
    for (const number of spellings) expect(await signIn(number, '000000')).toBe(401);
    expect(await signIn(phone, password)).toBe(429);

    // A new one-time password from staff also lifts the lock.
    const token = await login('cashier@example.test');
    const issued = await portalPasswordIssuePOST(makeRequest('POST', `/api/customers/${customer.id}/portal-password`, { token }), makeParams({ id: customer.id }));
    const { portalPassword } = await issued.json();
    expect(await signIn(phone, password)).toBe(401); // the old one is gone
    expect(await signIn(phone, portalPassword)).toBe(200);
  });
});

describe('Staff passwords', () => {
  const changePassword = (token: string, currentPassword: string, newPassword: string) =>
    passwordPOST(makeRequest('POST', '/api/auth/password', { token, body: { currentPassword, newPassword } }));

  it('a member of staff changes their own password, and every earlier sign-in stops working', async () => {
    const user = await makeStaff('CASHIER');
    const token = await login(user.email);
    // A token from a sign-in ten seconds ago — on another device, or stolen.
    const older = jwt.sign({ sub: user.id, iat: Math.floor(Date.now() / 1000) - 10 }, process.env.JWT_SECRET!);
    expect((await meGET(makeRequest('GET', '/api/auth/me', { token: older }))).status).toBe(200);

    expect((await changePassword(token, 'not-the-current-one', 'Another1Password')).status).toBe(400);
    expect((await changePassword(token, PASSWORD, 'short1')).status).toBe(400);
    expect((await changePassword(token, PASSWORD, 'nodigitsatall')).status).toBe(400);
    expect((await changePassword(token, PASSWORD, PASSWORD)).status).toBe(400);

    const changed = await changePassword(token, PASSWORD, 'Another1Password');
    expect(changed.status).toBe(200);
    const fresh = (await changed.json()).token as string;

    expect((await meGET(makeRequest('GET', '/api/auth/me', { token: older }))).status).toBe(401);
    expect((await meGET(makeRequest('GET', '/api/auth/me', { token: fresh }))).status).toBe(200);
    expect((await attempt(user.email, PASSWORD)).status).toBe(401);
    expect((await attempt(user.email, 'Another1Password')).status).toBe(200);
  });

  it('an administrator resets a password to a one-time one that opens nothing until it is replaced', async () => {
    const superadmin = await login('superadmin@example.test');
    const user = await makeStaff('CASHIER');
    const reset = (token: string, id: string) =>
      resetPasswordPOST(makeRequest('POST', `/api/users/${id}/reset-password`, { token }), makeParams({ id }));

    // Not without user.manage, and not on yourself.
    expect((await reset(await login('admin@example.test'), user.id)).status).toBe(403);
    const self = await prisma.user.findUniqueOrThrow({ where: { email: 'superadmin@example.test' } });
    expect((await reset(superadmin, self.id)).status).toBe(400);

    const res = await reset(superadmin, user.id);
    expect(res.status).toBe(200);
    const { temporaryPassword } = await res.json();
    expect(temporaryPassword).toMatch(/^[a-zA-Z0-9]{10}$/);
    expect((await attempt(user.email, PASSWORD)).status).toBe(401);

    const session = await attempt(user.email, temporaryPassword);
    expect(session.body.user.mustChangePassword).toBe(true);
    const token = session.body.token as string;

    // The server refuses everything else, whatever the screen shows.
    const blocked = await customersGET(makeRequest('GET', '/api/customers', { token }));
    expect(blocked.status).toBe(403);
    expect((await blocked.json()).code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await meGET(makeRequest('GET', '/api/auth/me', { token }))).status).toBe(200);

    const changed = await changePassword(token, temporaryPassword, 'MyOwn1Password');
    expect(changed.status).toBe(200);
    const fresh = (await changed.json()).token as string;
    expect((await customersGET(makeRequest('GET', '/api/customers', { token: fresh }))).status).toBe(200);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).mustChangePassword).toBe(false);
  });

  it('a new account starts on a password its creator chose, so it too must be replaced; only a super admin resets a super admin', async () => {
    const superadmin = await login('superadmin@example.test');
    const email = `sec-new-${unique()}@example.test`;
    const weak = await usersPOST(makeRequest('POST', '/api/users', { token: superadmin, body: { email, password: 'allletters', firstName: 'New', lastName: 'Hire', role: 'CASHIER' } }));
    expect(weak.status).toBe(400);
    const created = await usersPOST(makeRequest('POST', '/api/users', { token: superadmin, body: { email, password: PASSWORD, firstName: 'New', lastName: 'Hire', role: 'CASHIER' } }));
    expect(created.status).toBe(201);
    expect((await created.json()).user.mustChangePassword).toBe(true);
    expect((await attempt(email, PASSWORD)).body.user.mustChangePassword).toBe(true);
    const listed = (await (await usersGET(makeRequest('GET', '/api/users', { token: superadmin }))).json()).users as { email: string; mustChangePassword: boolean }[];
    expect(listed.find((u) => u.email === email)?.mustChangePassword).toBe(true);

    // A custom role with user.manage cannot use a reset to take over a super admin.
    const role = await prisma.role.create({ data: { name: `USER_ADMIN_${unique()}`, permissions: { connect: [{ name: 'user.manage' }] } } });
    const helpdesk = await prisma.user.create({ data: { email: `sec-helpdesk-${unique()}@example.test`, passwordHash: await hashPassword(PASSWORD), firstName: 'Help', lastName: 'Desk', roleId: role.id } });
    const target = await makeStaff('SUPER_ADMIN');
    const res = await resetPasswordPOST(makeRequest('POST', `/api/users/${target.id}/reset-password`, { token: await login(helpdesk.email) }), makeParams({ id: target.id }));
    expect(res.status).toBe(403);
    expect((await attempt(target.email, PASSWORD)).status).toBe(200);
  });
});

describe('Registration checks', () => {
  let cashier: string;
  beforeAll(async () => { cashier = await login('cashier@example.test'); });

  const register = async (body: Record<string, unknown>) => {
    const res = await customersPOST(makeRequest('POST', '/api/customers', { token: cashier, body: { ...registrationFields(), firstName: 'Reg', lastName: `Check${unique()}`, ...body } }));
    return { status: res.status, body: await res.json() };
  };

  it('refuses a number that is not a Ghana mobile number, and stores a good one in one form however it was typed', async () => {
    for (const bad of ['12345', '024123456', '02412345678', '0301234567', '0991234567', 'not a number', '+44 7911 123456']) {
      const res = await register({ phone: bad });
      expect(res.status, bad).toBe(400);
      expect(res.body.error).toMatch(/not a valid Ghana mobile number/);
    }

    const phone = await freshPhone('054');
    const typed = `+233 ${phone.slice(1, 3)} ${phone.slice(3, 6)}-${phone.slice(6)}`;
    const ok = await register({ phone: typed });
    expect(ok.status).toBe(201);
    expect(ok.body.customer.phone).toBe(phone);

    // The same number in any other spelling is the same number.
    expect((await register({ phone })).status).toBe(409);
    expect((await register({ phone: `233${phone.slice(1)}` })).status).toBe(409);
  });

  it('gives each new customer a one-time portal password, shown once and never stored in the clear', async () => {
    const phone = await freshPhone();
    const res = await register({ phone });
    expect(res.body.portalPassword).toMatch(/^\d{6}$/);
    expect(res.body.customer).not.toHaveProperty('passwordHash');
    const stored = await prisma.customer.findUniqueOrThrow({ where: { id: res.body.customer.id } });
    expect(stored.passwordHash).not.toContain(res.body.portalPassword);
    expect(stored.mustChangePassword).toBe(true);

    const signIn = await portalLoginPOST(makeRequest('POST', '/api/portal/auth/login', { body: { phone, password: res.body.portalPassword } }));
    expect(signIn.status).toBe(200);
  });

  it('refuses a National ID already on file, whatever its case or spacing, at registration and on edit', async () => {
    const id = `GHA-${unique()}-7`;
    const first = await register({ phone: await freshPhone(), nationalId: id });
    expect(first.status).toBe(201);
    expect(first.body.customer.nationalId).toBe(id);

    const again = await register({ phone: await freshPhone(), nationalId: ` ${id.toLowerCase().replace('-', ' -')} ` });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain(first.body.customer.membershipId);

    const other = await register({ phone: await freshPhone(), nationalId: `GHA-${unique()}-1` });
    const manager = await login('branchmanager@example.test');
    const patch = (body: Record<string, unknown>) =>
      customerPATCH(makeRequest('PATCH', `/api/customers/${other.body.customer.id}`, { token: manager, body }), makeParams({ id: other.body.customer.id }));
    expect((await patch({ nationalId: id.toLowerCase() })).status).toBe(409);
    expect((await patch({ phone: '0301234567' })).status).toBe(400);
    expect((await patch({ guarantorPhone: '12' })).status).toBe(400);
    // Saving the form back unchanged, own ID included, is not a clash.
    const same = await patch({ nationalId: other.body.customer.nationalId, guarantorPhone: '030 222 3333', occupation: 'Tailor' });
    expect(same.status).toBe(200);
    expect((await same.json()).customer.guarantorPhone).toBe('0302223333');
  });
});

describe('A second person for reversals, write-offs and paid-up cancellations', () => {
  let branchId: string;
  let adminUserId: string;
  let manager: string; // asks
  let admin: string;   // a different person, who approves
  let cashier: string; // holds none of the permissions

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
    manager = await login('branchmanager@example.test');
    admin = await login('admin@example.test');
    cashier = await login('cashier@example.test');
    await setSecondApproval(true);
  });
  afterAll(() => setSecondApproval(false));

  async function makeCustomer() {
    return prisma.customer.create({
      data: { membershipId: `APR-${unique()}`, firstName: 'Appro', lastName: `Val${unique()}`, phone: await freshPhone(), branchId, createdById: adminUserId },
    });
  }
  async function saverWithPayment(amountMinor: number) {
    const customer = await makeCustomer();
    const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId: customer.id, branchId, createdById: adminUserId });
    const { payment } = await postPayment({ contractId: contract.id, amountMinor, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
    return { contract, payment };
  }
  const reverse = (token: string, paymentId: string, reason = 'Entered against the wrong customer') =>
    reversePOST(makeRequest('POST', `/api/payments/${paymentId}/reverse`, { token, body: { reason } }), makeParams({ id: paymentId }));
  const decide = (token: string, id: string, decision: string, note?: string) =>
    approvalDecidePOST(makeRequest('POST', `/api/approvals/${id}`, { token, body: { decision, note } }), makeParams({ id }));
  const pending = async (token: string) =>
    (await (await approvalsGET(makeRequest('GET', '/api/approvals', { token }))).json()).approvals as { id: string; kind: string; amountMinor: number | null; mine: boolean }[];
  const paid = async (contractId: string) => (await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).totalPaidMinor;

  it('a reversal is only a request until someone else approves it — never the person who asked', async () => {
    const { contract, payment } = await saverWithPayment(9000);

    const asked = await reverse(manager, payment.id);
    expect(asked.status).toBe(202);
    const { approval, pendingApproval } = await asked.json();
    expect(pendingApproval).toBe(true);
    expect(await paid(contract.id)).toBe(9000);                    // nothing has happened yet
    expect((await reverse(manager, payment.id)).status).toBe(409); // and it cannot be asked for twice

    // The contract shows what is waiting; so does the approver's list, with the amount at stake.
    const shown = await (await contractGET(makeRequest('GET', `/api/contracts/${contract.id}`, { token: manager }), makeParams({ id: contract.id }))).json();
    expect(shown.contract.approvalRequests).toMatchObject([{ id: approval.id, kind: 'PAYMENT_REVERSAL', targetId: payment.id }]);
    expect((await pending(admin)).find((a) => a.id === approval.id)).toMatchObject({ kind: 'PAYMENT_REVERSAL', amountMinor: 9000, mine: false });
    expect((await pending(manager)).find((a) => a.id === approval.id)?.mine).toBe(true);

    expect((await approvalsGET(makeRequest('GET', '/api/approvals', { token: cashier }))).status).toBe(403);
    expect((await decide(cashier, approval.id, 'APPROVE')).status).toBe(403);
    const own = await decide(manager, approval.id, 'APPROVE');
    expect(own.status).toBe(403);
    expect((await own.json()).error).toMatch(/different person/);
    expect(await paid(contract.id)).toBe(9000);

    const approved = await decide(admin, approval.id, 'APPROVE');
    expect(approved.status).toBe(200);
    expect((await approved.json()).approval).toMatchObject({ status: 'APPROVED', decidedBy: { firstName: 'System' } });
    expect(await paid(contract.id)).toBe(0);
    // Recorded against the person who asked, with who approved it.
    const audit = await prisma.auditLog.findFirst({ where: { action: 'PAYMENT_REVERSE', entityId: payment.id } });
    expect(JSON.parse(audit!.newValues!)).toMatchObject({ approvedById: adminUserId, approvalRequestId: approval.id });
    expect((await decide(admin, approval.id, 'APPROVE')).status).toBe(409); // decided is decided
  });

  it('a rejection needs a reason and changes nothing; the person who asked may withdraw their own request', async () => {
    const { contract, payment } = await saverWithPayment(4000);
    const first = (await (await reverse(manager, payment.id)).json()).approval;
    expect((await decide(admin, first.id, 'REJECT')).status).toBe(400);
    expect((await decide(admin, first.id, 'REJECT', 'The receipt matches the cash book')).status).toBe(200);
    expect(await paid(contract.id)).toBe(4000);

    // Rejected, so it can be asked for again — and withdrawn by whoever asked.
    const second = (await (await reverse(manager, payment.id)).json()).approval;
    expect((await decide(manager, second.id, 'REJECT')).status).toBe(200);
    expect(await paid(contract.id)).toBe(4000);
    expect((await decide(admin, second.id, 'SOMETHING')).status).toBe(400);
  });

  it('a request that can no longer be carried out stays open rather than being marked approved', async () => {
    const { contract, payment } = await saverWithPayment(2500);
    const approval = (await (await reverse(manager, payment.id)).json()).approval;
    await prisma.contract.update({ where: { id: contract.id }, data: { status: 'ACTIVE' } });
    await prisma.payment.update({ where: { id: payment.id }, data: { status: 'FAILED' } });

    const res = await decide(admin, approval.id, 'APPROVE');
    expect(res.status).toBe(400);
    expect((await prisma.approvalRequest.findUniqueOrThrow({ where: { id: approval.id } })).status).toBe('PENDING');
    // And asking again is refused outright, since it could never be done, rather than queued.
    await decide(manager, approval.id, 'REJECT');
    expect((await reverse(manager, payment.id)).status).toBe(400);
  });

  it('writing off a live loan waits for a second person; turning down an unapproved submission does not', async () => {
    const customer = await makeCustomer();
    const loan = await createContract({ contractType: 'DEVICE_LOAN', customerId: customer.id, branchId, createdById: adminUserId, loanAmountMinor: 60000 });
    const writeoff = (token: string, id: string) =>
      writeoffPOST(makeRequest('POST', `/api/contracts/${id}/writeoff`, { token, body: { reason: 'Customer cannot be traced' } }), makeParams({ id }));

    const asked = await writeoff(manager, loan.id);
    expect(asked.status).toBe(202);
    const { approval } = await asked.json();
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: loan.id } })).status).toBe('ACTIVE');
    expect((await decide(manager, approval.id, 'APPROVE')).status).toBe(403);
    expect((await decide(admin, approval.id, 'APPROVE')).status).toBe(200);
    const written = await prisma.contract.findUniqueOrThrow({ where: { id: loan.id } });
    expect(written).toMatchObject({ status: 'WRITTEN_OFF', writeOffReason: 'Customer cannot be traced' });

    // No money can have moved on a contract nobody has approved yet.
    const submitted = await createContract({ contractType: 'DEVICE_LOAN', customerId: (await makeCustomer()).id, branchId, createdById: adminUserId, loanAmountMinor: 30000 });
    await prisma.contract.update({ where: { id: submitted.id }, data: { status: 'PENDING_APPROVAL' } });
    expect((await writeoff(manager, submitted.id)).status).toBe(200);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: submitted.id } })).status).toBe('WRITTEN_OFF');
  });

  it('cancelling a contract with money on it waits for a second person and records the refund owed; one with none is cancelled at once', async () => {
    const cancel = (token: string, id: string) =>
      cancelPOST(makeRequest('POST', `/api/contracts/${id}/cancel`, { token, body: { reason: 'Customer changed their mind' } }), makeParams({ id }));

    const empty = await createContract({ contractType: 'SAVE_TO_OWN', customerId: (await makeCustomer()).id, branchId, createdById: adminUserId });
    expect((await cancel(manager, empty.id)).status).toBe(200);
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: empty.id } })).refundDueMinor).toBeNull();

    const { contract } = await saverWithPayment(12000);
    const asked = await cancel(manager, contract.id);
    expect(asked.status).toBe(202);
    const { approval } = await asked.json();
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('ACTIVE');
    expect((await pending(admin)).find((a) => a.id === approval.id)).toMatchObject({ kind: 'CONTRACT_CANCEL', amountMinor: 12000 });

    expect((await decide(admin, approval.id, 'APPROVE')).status).toBe(200);
    const cancelled = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(cancelled).toMatchObject({ status: 'CANCELLED', totalPaidMinor: 0, refundDueMinor: 12000, refundedAt: null });
  });

  it('with the control switched off, one person is enough', async () => {
    await setSecondApproval(false);
    try {
      const { contract, payment } = await saverWithPayment(3000);
      expect((await reverse(manager, payment.id)).status).toBe(201);
      expect(await paid(contract.id)).toBe(0);
    } finally {
      await setSecondApproval(true);
    }
  });
});
