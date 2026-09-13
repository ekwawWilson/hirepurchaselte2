/**
 * Save to Own and Device Loan are only offered once activated in
 * Settings > Contract types. Deactivating a type stops new contracts of it,
 * never the contracts that already exist.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeRequest, enableOptionalContractTypes } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { POST as contractsPOST } from '@/app/api/contracts/route';
import { POST as paymentsCashPOST } from '@/app/api/payments/cash/route';
import { GET as contractTypesGET, PATCH as contractTypesPATCH } from '@/app/api/settings/contract-types/route';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!123' } }));
  return (await res.json()).token as string;
}

describe('Contract type activation', () => {
  let admin: string;
  let cashier: string;

  beforeAll(async () => {
    admin = await login('admin@example.test');
    cashier = await login('cashier@example.test');
  });

  // Other test files rely on both types being on.
  afterAll(enableOptionalContractTypes);

  async function setTypes(body: { saveToOwnEnabled: boolean; deviceLoanEnabled: boolean }) {
    const res = await contractTypesPATCH(makeRequest('PATCH', '/api/settings/contract-types', { token: admin, body }));
    expect(res.status).toBe(200);
  }

  async function makeCustomer() {
    counter += 1;
    const res = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { firstName: 'Type', lastName: 'Toggle', phone: `029${runId}${counter}` },
    }));
    return (await res.json()).customer.id as string;
  }

  it('both optional types are off before anyone has saved the setting', async () => {
    await prisma.contractTypeSettings.deleteMany({});
    const res = await contractTypesGET(makeRequest('GET', '/api/settings/contract-types', { token: cashier }));
    expect(res.status).toBe(200);
    expect((await res.json()).settings).toEqual({ saveToOwnEnabled: false, deviceLoanEnabled: false });
  });

  it('only settings.manage can change it, and the body is validated', async () => {
    const byCashier = await contractTypesPATCH(makeRequest('PATCH', '/api/settings/contract-types', {
      token: cashier, body: { saveToOwnEnabled: true, deviceLoanEnabled: true },
    }));
    expect(byCashier.status).toBe(403);

    const invalid = await contractTypesPATCH(makeRequest('PATCH', '/api/settings/contract-types', {
      token: admin, body: { saveToOwnEnabled: 'yes' },
    }));
    expect(invalid.status).toBe(400);
  });

  it('refuses to create an inactive type, and allows it once activated', async () => {
    const customerId = await makeCustomer();
    await setTypes({ saveToOwnEnabled: false, deviceLoanEnabled: false });

    const saveToOwn = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId },
    }));
    expect(saveToOwn.status).toBe(400);
    expect((await saveToOwn.json()).error).toMatch(/Save to Own is not activated/);

    const loan = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId, loanAmountMinor: 50000 },
    }));
    expect(loan.status).toBe(400);
    expect((await loan.json()).error).toMatch(/Device Loan is not activated/);

    // Each type is its own switch.
    await setTypes({ saveToOwnEnabled: true, deviceLoanEnabled: false });
    const allowed = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId },
    }));
    expect(allowed.status).toBe(201);
    const stillBlocked = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId, loanAmountMinor: 50000 },
    }));
    expect(stillBlocked.status).toBe(400);
  });

  it('deactivating a type leaves existing contracts of it taking payments', async () => {
    const customerId = await makeCustomer();
    await setTypes({ saveToOwnEnabled: true, deviceLoanEnabled: true });
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId },
    }));
    const contract = (await created.json()).contract;

    await setTypes({ saveToOwnEnabled: false, deviceLoanEnabled: false });
    const payment = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 2500, entryType: 'INSTALMENT_PAYMENT' },
    }));
    expect(payment.status).toBe(201);
  });
});
