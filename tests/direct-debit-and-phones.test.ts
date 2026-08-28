/**
 * Coverage for:
 *  - Customer registration with three phone slots, at least one required,
 *    unique across every slot of every customer (not just same-column).
 *  - USSD/SMS/direct-debit treating any registered slot as reachable, not just `phone`.
 *  - Hubtel mobile-money verification (mock mode): fails open, never blocks.
 *  - Hubtel Direct Debit: mandate initiation/reuse, eligibility (no SAVE_TO_OWN,
 *    ACTIVE only), charging, and the proactive collections run.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { createContract } from '@/lib/services/contractService';
import { postPayment } from '@/lib/services/paymentService';
import { verifyMobileMoneyNumber } from '@/lib/services/hubtelVerificationService';
import {
  initiatePreapproval, enableDirectDebit, disableDirectDebit, chargeDirectDebit,
  processDirectDebitCallback, retryFailedDirectDebits, PreapprovalError,
} from '@/lib/services/hubtelPreapprovalService';
import { runDirectDebitCollections } from '@/lib/services/collectionsService';

const PASSWORD = 'Passw0rd!123';
const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
function uniquePhone() {
  counter += 1;
  return `024${runId}${counter}`;
}

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  return (await res.json()).token as string;
}

describe('Customer registration: three phone slots', () => {
  let cashier: string;

  beforeAll(async () => {
    cashier = await login('cashier@hplite.test');
  });

  it('rejects a customer with all three phone slots empty', async () => {
    const res = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { firstName: 'No', lastName: 'Phone' },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/at least one phone/i);
  });

  it('accepts a customer with only the second phone slot filled', async () => {
    const res = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { firstName: 'Only', lastName: 'Phone2', phone2: uniquePhone() },
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.customer.phone).toBeNull();
    expect(body.customer.phone2).toBeTruthy();
  });

  it('rejects a phone number already registered to another customer in a DIFFERENT slot', async () => {
    const sharedNumber = uniquePhone();
    const first = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { firstName: 'First', lastName: 'Holder', phone: sharedNumber },
    }));
    expect(first.status).toBe(201);

    // Same physical number, but offered as customer B's phone2/phone3 this time —
    // the schema's per-column @unique constraints alone wouldn't catch this.
    const second = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { firstName: 'Second', lastName: 'Claimant', phone2: sharedNumber },
    }));
    expect(second.status).toBe(409);
  });
});

describe('Hubtel mobile money verification (mock mode)', () => {
  let cashier: string;

  beforeAll(async () => {
    cashier = await login('cashier@hplite.test');
  });

  it('confirms a registered number and surfaces the account holder\'s name', async () => {
    const phone = uniquePhone();
    await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { firstName: 'Verify', lastName: 'Target', phone },
    }));

    const result = await verifyMobileMoneyNumber({ msisdn: phone, network: 'MTN', requestedById: 'test-user' });
    expect(result.verified).toBe(true);
    expect(result.accountName).toBe('VERIFY TARGET');
  });

  it('still resolves (fails open) for a number nobody has registered', async () => {
    const result = await verifyMobileMoneyNumber({ msisdn: uniquePhone(), network: 'MTN', requestedById: 'test-user' });
    expect(result.verified).toBe(true);
    expect(result.accountName).toBeNull();
  });
});

describe('Hubtel Direct Debit', () => {
  let branchId: string;
  let adminUserId: string;

  beforeAll(async () => {
    const branch = await prisma.branch.findFirstOrThrow();
    branchId = branch.id;
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@hplite.test' } });
    adminUserId = admin.id;
  });

  async function makeProduct(label: string) {
    const product = await prisma.product.create({
      data: { sku: `DD-SKU-${label}-${runId}`, name: `DD Phone ${label}`, cashPriceMinor: 120000 },
    });
    return product.id;
  }

  async function makeCustomerAndItem(productId: string, label: string) {
    const customer = await prisma.customer.create({
      data: {
        membershipId: `DD-MEM-${label}-${runId}`, firstName: 'DD', lastName: label,
        phone: `025${runId}${label}`, branchId, createdById: adminUserId,
      },
    });
    const item = await prisma.inventoryItem.create({
      data: { productId, branchId, serialNumber: `IMEI-DD-${label}-${runId}` },
    });
    return { customerId: customer.id, inventoryItemId: item.id, msisdn: customer.phone as string };
  }

  it('rejects AirtelTigo — that network has no Hubtel direct-debit product', async () => {
    const productId = await makeProduct('AT');
    const { customerId } = await makeCustomerAndItem(productId, 'AT');
    await expect(initiatePreapproval({ customerId, msisdn: '020' + runId, network: 'AIRTELTIGO', createdById: adminUserId }))
      .rejects.toThrow(PreapprovalError);
  });

  it('a mandate is auto-approved in mock mode and reused for the same customer+number+network', async () => {
    const productId = await makeProduct('REUSE');
    const { customerId, msisdn } = await makeCustomerAndItem(productId, 'REUSE');

    const first = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    expect(first.preapproval.status).toBe('APPROVED');
    expect(first.reused).toBe(false);

    const second = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    expect(second.reused).toBe(true);
    expect(second.preapproval.id).toBe(first.preapproval.id);
  });

  it('SAVE_TO_OWN contracts are never eligible for direct debit', async () => {
    await prisma.priceChartEntry.create({
      data: {
        productId: await makeProduct('STO'), contractType: 'SAVE_TO_OWN', termMonths: 6, depositPercentage: 0,
        totalPayableMinor: 60000, instalmentAmountMinor: 10000, createdById: adminUserId,
      },
    });
    const productId = (await prisma.priceChartEntry.findFirstOrThrow({ where: { contractType: 'SAVE_TO_OWN' }, orderBy: { createdAt: 'desc' } })).productId;
    const { customerId, inventoryItemId, msisdn } = await makeCustomerAndItem(productId, 'STO');
    const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId, inventoryItemId, termMonths: 6, branchId, createdById: adminUserId });

    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    await expect(enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId }))
      .rejects.toThrow(/no due schedule/i);
  });

  it('a DEPOSIT_INSTALMENT contract still PENDING_DEPOSIT is not eligible until it activates', async () => {
    const productId = await makeProduct('PD');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 6, depositPercentage: 50,
        totalPayableMinor: 100000, instalmentAmountMinor: 8333, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId, msisdn } = await makeCustomerAndItem(productId, 'PD');
    const contract = await createContract({ contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId, termMonths: 6, branchId, createdById: adminUserId });
    expect(contract.status).toBe('PENDING_DEPOSIT');

    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    await expect(enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId }))
      .rejects.toThrow(/ACTIVE/);
  });

  it('once ACTIVE, enabling direct debit lets a manual charge post a real payment', async () => {
    const productId = await makeProduct('CHARGE');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEVICE_LOAN', termMonths: 6, depositPercentage: 0,
        totalPayableMinor: 120000, instalmentAmountMinor: 20000, interestRateBps: 2400, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId, msisdn } = await makeCustomerAndItem(productId, 'CHARGE');
    const contract = await createContract({ contractType: 'DEVICE_LOAN', customerId, inventoryItemId, termMonths: 6, branchId, createdById: adminUserId });
    expect(contract.status).toBe('ACTIVE'); // DEVICE_LOAN is ACTIVE immediately, no deposit gate

    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    const withDirectDebit = await enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId });
    expect(withDirectDebit.hubtelPreapprovalId).toBe(preapproval.id);

    const txn = await chargeDirectDebit({ contractId: contract.id, amountMinor: 5000 });
    expect(txn.status).toBe('SUCCESS');
    expect(txn.channel).toBe('DIRECT_DEBIT');

    const updated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(updated.totalPaidMinor).toBe(5000);

    const payment = await prisma.payment.findFirstOrThrow({ where: { contractId: contract.id } });
    expect(payment.channel).toBe('DIRECT_DEBIT');

    // Disabling direct debit detaches it from the contract without touching the mandate itself.
    const disabled = await disableDirectDebit({ contractId: contract.id, userId: adminUserId });
    expect(disabled.hubtelPreapprovalId).toBeNull();
    const stillApproved = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: preapproval.id } });
    expect(stillApproved.status).toBe('APPROVED');
  });

  it('a failed charge schedules a retry, and retryFailedDirectDebits re-attempts it', async () => {
    const productId = await makeProduct('RETRY');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 6, depositPercentage: 0,
        totalPayableMinor: 60000, instalmentAmountMinor: 10000, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId, msisdn } = await makeCustomerAndItem(productId, 'RETRY');
    const contract = await createContract({ contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId, termMonths: 6, branchId, createdById: adminUserId });
    // 0% deposit clears the gate immediately with any positive payment.
    await postPayment({ contractId: contract.id, amountMinor: 1, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });

    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    await enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId });

    // Simulate a failed charge directly (mock chargeDirectDebit always succeeds — this
    // exercises the retry-scheduling path the same way the USSD reconciliation tests do).
    const clientReference = `TEST-DD-FAIL-${runId}`;
    await prisma.hubtelTransaction.create({
      data: { clientReference, contractId: contract.id, msisdn, amountMinor: 5000, status: 'PENDING', channel: 'DIRECT_DEBIT', preapprovalId: preapproval.id },
    });
    const failed = await processDirectDebitCallback({ clientReference, status: 'FAILED', rawPayload: '{}' });
    expect(failed.status).toBe('FAILED');
    expect(failed.retryCount).toBe(1);
    expect(failed.nextRetryAt).not.toBeNull();

    // Force the retry to be due now, then run the sweep.
    await prisma.hubtelTransaction.update({ where: { id: failed.id }, data: { nextRetryAt: new Date(Date.now() - 1000) } });
    const retried = await retryFailedDirectDebits();
    expect(retried).toBeGreaterThanOrEqual(1);

    const updated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(updated.totalPaidMinor).toBe(1 + 5000); // the 1-pesewa deposit plus the retried charge
  });

  it('the collections run charges every ACTIVE contract with an approved mandate and a due instalment, and never double-charges the same day', async () => {
    const productId = await makeProduct('COLLECT');
    await prisma.priceChartEntry.create({
      data: {
        productId, contractType: 'DEVICE_LOAN', termMonths: 6, depositPercentage: 0,
        totalPayableMinor: 120000, instalmentAmountMinor: 20000, interestRateBps: 2400, createdById: adminUserId,
      },
    });
    const { customerId, inventoryItemId, msisdn } = await makeCustomerAndItem(productId, 'COLLECT');
    const contract = await createContract({ contractType: 'DEVICE_LOAN', customerId, inventoryItemId, termMonths: 6, branchId, createdById: adminUserId });

    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    await enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId });

    // Force the first instalment's due date into the past so the collections run picks it up today.
    await prisma.instalment.updateMany({ where: { contractId: contract.id, instalmentNo: 1 }, data: { dueDate: new Date(Date.now() - 24 * 60 * 60_000) } });

    const charged = await runDirectDebitCollections();
    expect(charged).toBeGreaterThanOrEqual(1);
    const afterFirstRun = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(afterFirstRun.totalPaidMinor).toBeGreaterThan(0);

    // Running it again the same day must not charge this contract a second time —
    // its first due instalment is now PAID, so nothing is left to collect for it.
    const paidCount = await prisma.payment.count({ where: { contractId: contract.id } });
    await runDirectDebitCollections();
    const paidCountAfter = await prisma.payment.count({ where: { contractId: contract.id } });
    expect(paidCountAfter).toBe(paidCount);
  });
});
