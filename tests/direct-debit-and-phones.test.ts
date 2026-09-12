/**
 * Coverage for:
 *  - Customer registration with three phone slots, at least one required,
 *    unique across every slot of every customer (not just same-column).
 *  - USSD/SMS/direct-debit treating any registered slot as reachable, not just `phone`.
 *  - Hubtel mobile-money verification (mock mode): fails open, never blocks.
 *  - Hubtel Direct Debit: mandate initiation/reuse, eligibility (DEPOSIT_INSTALMENT
 *    only — SAVE_TO_OWN has no due schedule, and DEVICE_LOAN's self-directed
 *    interest/principal choice has no "auto-charge the due amount" equivalent —
 *    see DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES), charging, and the proactive
 *    collections run.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { makeRequest } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { POST as verifyPhonePOST } from '@/app/api/customers/verify-phone/route';
import { createContract, ContractError } from '@/lib/services/contractService';
import { postPayment } from '@/lib/services/paymentService';
import { verifyMobileMoneyNumber } from '@/lib/services/hubtelVerificationService';
import {
  initiatePreapproval, enableDirectDebit, disableDirectDebit, chargeDirectDebit,
  processDirectDebitCallback, retryFailedDirectDebits, PreapprovalError,
} from '@/lib/services/hubtelPreapprovalService';
import { runDirectDebitCollections } from '@/lib/services/collectionsService';
import { updateOperatingSettings } from '@/lib/services/operatingSettingsService';
import { applyLatePenalties } from '@/lib/services/overdueService';

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
    cashier = await login('cashier@zple.test');
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
    cashier = await login('cashier@zple.test');
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

  it('POST /api/customers/verify-phone accepts AirtelTigo — this is a lookup, not a direct-debit mandate, so it is not limited to DIRECT_DEBIT_NETWORKS', async () => {
    const res = await verifyPhonePOST(makeRequest('POST', '/api/customers/verify-phone', {
      token: cashier, body: { phone: uniquePhone(), network: 'AIRTELTIGO' },
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).verified).toBe(true);
  });

  it('POST /api/customers/verify-phone still rejects a genuinely unknown network', async () => {
    const res = await verifyPhonePOST(makeRequest('POST', '/api/customers/verify-phone', {
      token: cashier, body: { phone: uniquePhone(), network: 'GLO' },
    }));
    expect(res.status).toBe(400);
  });
});

describe('Hubtel Direct Debit', () => {
  let branchId: string;
  let adminUserId: string;

  beforeAll(async () => {
    const branch = await prisma.branch.findFirstOrThrow();
    branchId = branch.id;
    const admin = await prisma.user.findFirstOrThrow({ where: { email: 'admin@zple.test' } });
    adminUserId = admin.id;
    // runDirectDebitCollections is a no-op on a non-working day
    // (collectionsService.ts), so without this the collection tests below
    // would pass Mon-Fri and fail every Saturday/Sunday. Marking both weekend
    // days as working makes them depend only on what they actually assert.
    await updateOperatingSettings({ worksSaturday: true, worksSunday: true, updatedById: adminUserId });
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

  // SAVE_TO_OWN/DEVICE_LOAN need no product/inventory item at all (contractService.ts).
  async function makeCustomer(label: string) {
    const customer = await prisma.customer.create({
      data: {
        membershipId: `DD-MEM-${label}-${runId}`, firstName: 'DD', lastName: label,
        phone: `025${runId}${label}`, branchId, createdById: adminUserId,
      },
    });
    return { customerId: customer.id, msisdn: customer.phone as string };
  }

  /** DEPOSIT_INSTALMENT's terms are entered directly now — no price chart lookup at creation. */
  async function makeDepositInstalment(label: string, overrides: Record<string, unknown> = {}) {
    const productId = await makeProduct(label);
    const { customerId, inventoryItemId, msisdn } = await makeCustomerAndItem(productId, label);
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
      totalPayableMinor: 120000, depositAmountMinor: 0, termWeeks: 6, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
      ...overrides,
    });
    return { contract, customerId, inventoryItemId, msisdn };
  }

  it('createContract rejects DIRECT_DEBIT/BOTH without a network+number', async () => {
    const productId = await makeProduct('NODD');
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'NODD');
    await expect(createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId, branchId, createdById: adminUserId, paymentMethod: 'BOTH',
      totalPayableMinor: 120000, depositAmountMinor: 0, termWeeks: 6,
    })).rejects.toThrow(ContractError);
  });

  it('createContract rejects DIRECT_DEBIT/BOTH for DEVICE_LOAN — its self-directed interest/principal choice has no due amount to auto-charge', async () => {
    const { customerId, msisdn } = await makeCustomer('DLNODD');
    // directDebitNetwork+Msisdn given without an explicit paymentMethod is
    // inferred as DIRECT_DEBIT (contractService.ts) — DEVICE_LOAN rejects it
    // outright, the same as it would an explicit paymentMethod.
    await expect(createContract({
      contractType: 'DEVICE_LOAN', customerId, loanAmountMinor: 100000, branchId, createdById: adminUserId,
      directDebitNetwork: 'MTN', directDebitMsisdn: msisdn,
    })).rejects.toThrow(ContractError);
  });

  it('initiatePreapproval stores whichever verificationType Hubtel decides on (USSD vs OTP is never something this app requests)', async () => {
    const { customerId, msisdn } = await makeCustomer('VERIFTYPE');

    const originalMode = process.env.HUBTEL_PAYMENTS_MODE;
    const originalSalesId = process.env.HUBTEL_POS_SALES_ID;
    const originalKey = process.env.HUBTEL_API_KEY;
    const originalSecret = process.env.HUBTEL_API_SECRET;
    process.env.HUBTEL_PAYMENTS_MODE = 'live';
    process.env.HUBTEL_POS_SALES_ID = 'TEST-SALES-ID';
    process.env.HUBTEL_API_KEY = 'test-key';
    process.env.HUBTEL_API_SECRET = 'test-secret';

    const guardedFetch = globalThis.fetch;
    // Hubtel decided this number needs OTP (already preapproved with another
    // merchant) — the request never asked for this, it's purely their response.
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({
      message: 'Request received! Pending preapproval',
      responseCode: '2000',
      data: {
        hubtelPreApprovalId: 'HPA-VERIFTYPE-1', clientReferenceId: 'whatever',
        verificationType: 'OTP', otpPrefix: 'HNRM', preapprovalStatus: 'PENDING',
      },
    }), { status: 200 }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
      expect(preapproval.verificationType).toBe('OTP');
      expect(preapproval.status).toBe('PENDING');

      const stored = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: preapproval.id } });
      expect(stored.verificationType).toBe('OTP');

      // Settings > Hubtel Diagnostics sources its outbound "sample payloads"
      // straight from the real call this server sent Hubtel — captured at the
      // single choke point (hubtelClient.ts), not fabricated.
      const sample = await prisma.hubtelSampleLog.findUnique({ where: { kind: 'PREAPPROVAL_INITIATE' } });
      expect(sample).not.toBeNull();
      expect(JSON.parse(sample!.requestPayload as string)).toMatchObject({ channel: 'mtn-gh-direct-debit' });
      expect(JSON.parse(sample!.responsePayload as string)).toMatchObject({ responseCode: '2000' });
    } finally {
      globalThis.fetch = guardedFetch;
      process.env.HUBTEL_PAYMENTS_MODE = originalMode;
      process.env.HUBTEL_POS_SALES_ID = originalSalesId;
      process.env.HUBTEL_API_KEY = originalKey;
      process.env.HUBTEL_API_SECRET = originalSecret;
    }
  });

  it('createContract rejects DIRECT_DEBIT/BOTH for SAVE_TO_OWN — no due schedule to auto-collect against', async () => {
    const { customerId, msisdn } = await makeCustomer('STONODD');
    await expect(createContract({
      contractType: 'SAVE_TO_OWN', customerId, branchId, createdById: adminUserId,
      paymentMethod: 'DIRECT_DEBIT', directDebitNetwork: 'MTN', directDebitMsisdn: msisdn,
    })).rejects.toThrow(ContractError);
  });

  it('rejects AirtelTigo — that network has no Hubtel direct-debit product', async () => {
    const { customerId } = await makeCustomer('AT');
    await expect(initiatePreapproval({ customerId, msisdn: '020' + runId, network: 'AIRTELTIGO', createdById: adminUserId }))
      .rejects.toThrow(PreapprovalError);
  });

  it('a mandate is auto-approved in mock mode and reused for the same customer+number+network', async () => {
    const { customerId, msisdn } = await makeCustomer('REUSE');

    const first = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    expect(first.preapproval.status).toBe('APPROVED');
    expect(first.reused).toBe(false);

    const second = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    expect(second.reused).toBe(true);
    expect(second.preapproval.id).toBe(first.preapproval.id);
  });

  it('SAVE_TO_OWN contracts are never eligible for direct debit', async () => {
    const { customerId, msisdn } = await makeCustomer('STO');
    const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId, branchId, createdById: adminUserId });

    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    await expect(enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId }))
      .rejects.toThrow(/no due schedule/i);
  });

  it('a DEVICE_LOAN contract is never eligible for direct debit, regardless of status', async () => {
    const { customerId, msisdn } = await makeCustomer('DLWO');
    const contract = await createContract({ contractType: 'DEVICE_LOAN', customerId, loanAmountMinor: 100000, branchId, createdById: adminUserId });
    expect(contract.status).toBe('ACTIVE');

    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    await expect(enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId }))
      .rejects.toThrow(/no due schedule/i);
  });

  it('a DEPOSIT_INSTALMENT contract not in ACTIVE/PENDING_DEPOSIT is ineligible for direct debit', async () => {
    const { contract, customerId, msisdn } = await makeDepositInstalment('DINOTACTIVE');
    await prisma.contract.update({ where: { id: contract.id }, data: { status: 'CANCELLED' } });

    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    await expect(enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId }))
      .rejects.toThrow(/ACTIVE/);
  });

  it('once ACTIVE, enabling direct debit lets a manual charge post a real payment', async () => {
    const { contract, customerId, msisdn } = await makeDepositInstalment('CHARGE');
    // 0% deposit — any payment clears the gate immediately.
    await postPayment({ contractId: contract.id, amountMinor: 1, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });
    const active = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(active.status).toBe('ACTIVE');

    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    const withDirectDebit = await enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId });
    expect(withDirectDebit.hubtelPreapprovalId).toBe(preapproval.id);

    const txn = await chargeDirectDebit({ contractId: contract.id, amountMinor: 5000 });
    expect(txn.status).toBe('SUCCESS');
    expect(txn.channel).toBe('DIRECT_DEBIT');

    const updated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(updated.totalPaidMinor).toBe(1 + 5000);

    const payment = await prisma.payment.findFirstOrThrow({ where: { contractId: contract.id, channel: 'DIRECT_DEBIT' } });
    expect(payment.channel).toBe('DIRECT_DEBIT');

    // Disabling direct debit detaches it from the contract without touching the mandate itself.
    const disabled = await disableDirectDebit({ contractId: contract.id, userId: adminUserId });
    expect(disabled.hubtelPreapprovalId).toBeNull();
    const stillApproved = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: preapproval.id } });
    expect(stillApproved.status).toBe('APPROVED');
  });

  it('a failed charge schedules a retry, and retryFailedDirectDebits re-attempts it', async () => {
    const { contract, customerId, msisdn } = await makeDepositInstalment('RETRY', { totalPayableMinor: 60000, depositAmountMinor: 0, termWeeks: 6 });
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

  it('the collections run charges every ACTIVE contract with an approved mandate and a due instalment, and never double-charges', async () => {
    const { contract, customerId, msisdn } = await makeDepositInstalment('COLLECT');
    await postPayment({ contractId: contract.id, amountMinor: 1, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });

    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    await enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId, paymentMethod: 'DIRECT_DEBIT' });

    // Force the first still-due instalment's due date into the past so the collections run picks it up today.
    const nextDue = await prisma.instalment.findFirstOrThrow({ where: { contractId: contract.id, status: { in: ['PENDING', 'PARTIAL'] } }, orderBy: { instalmentNo: 'asc' } });
    await prisma.instalment.update({ where: { id: nextDue.id }, data: { dueDate: new Date(Date.now() - 24 * 60 * 60_000) } });

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

  it('BOTH mode: an instalment due but not yet OVERDUE is left for the customer to pay themselves', async () => {
    const productId = await makeProduct('BOTHDUE');
    const { customerId, inventoryItemId, msisdn } = await makeCustomerAndItem(productId, 'BOTHDUE');
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
      totalPayableMinor: 120000, depositAmountMinor: 0, termWeeks: 6, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
      paymentMethod: 'BOTH', directDebitNetwork: 'MTN', directDebitMsisdn: msisdn,
    });
    expect(contract.paymentMethod).toBe('BOTH');
    // 0% deposit — activates immediately so there's a real due instalment to test.
    await postPayment({ contractId: contract.id, amountMinor: 1, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });

    // Due date is in the past (so it clears the "due" filter) but status is
    // still PENDING — simulates "due today, the daily overdue sweep hasn't
    // flipped it to OVERDUE yet" (see overdueService.markOverdueInstalments,
    // which normally does that flip before collections runs in the same cron).
    await prisma.instalment.updateMany({
      where: { contractId: contract.id, instalmentNo: 1 },
      data: { dueDate: new Date(Date.now() - 60_000), status: 'PENDING' },
    });

    const paidBefore = await prisma.payment.count({ where: { contractId: contract.id } });
    const charged = await runDirectDebitCollections();
    expect(charged).toBe(0);
    const afterRun = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(paidBefore);
    expect(afterRun.totalPaidMinor).toBe(1);
  });

  it('BOTH mode: once an instalment is actually OVERDUE (the customer defaulted), direct debit charges it', async () => {
    const productId = await makeProduct('BOTHOD');
    const { customerId, inventoryItemId, msisdn } = await makeCustomerAndItem(productId, 'BOTHOD');
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
      totalPayableMinor: 120000, depositAmountMinor: 0, termWeeks: 6, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
      paymentMethod: 'BOTH', directDebitNetwork: 'MTN', directDebitMsisdn: msisdn,
    });
    await postPayment({ contractId: contract.id, amountMinor: 1, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });

    await prisma.instalment.updateMany({
      where: { contractId: contract.id, instalmentNo: 1 },
      data: { dueDate: new Date(Date.now() - 24 * 60 * 60_000), status: 'OVERDUE' },
    });

    const charged = await runDirectDebitCollections();
    expect(charged).toBe(1);
    const afterRun = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(afterRun.totalPaidMinor).toBeGreaterThan(1);
  });

  it('CUSTOMER_INITIATED contracts are never touched by the collections run, even with an approved mandate attached', async () => {
    const { contract, customerId, msisdn } = await makeDepositInstalment('CUSTONLY');
    await postPayment({ contractId: contract.id, amountMinor: 1, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });
    expect(contract.paymentMethod).toBe('CUSTOMER_INITIATED');

    // Attach a mandate directly (bypassing enableDirectDebit's paymentMethod
    // param) to prove the collections filter itself, not just the setup path,
    // is what keeps a CUSTOMER_INITIATED contract untouched.
    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    await prisma.contract.update({ where: { id: contract.id }, data: { hubtelPreapprovalId: preapproval.id } });
    await prisma.instalment.updateMany({
      where: { contractId: contract.id, instalmentNo: 1 },
      data: { dueDate: new Date(Date.now() - 24 * 60 * 60_000), status: 'OVERDUE' },
    });

    const charged = await runDirectDebitCollections();
    expect(charged).toBe(0);
  });

  it('a DEPOSIT_INSTALMENT contract initiates the mandate immediately at creation, while still PENDING_DEPOSIT — no re-asking the customer once the deposit clears', async () => {
    const productId = await makeProduct('DIEAGER');
    const { customerId, inventoryItemId, msisdn } = await makeCustomerAndItem(productId, 'DIEAGER');

    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
      totalPayableMinor: 100000, depositAmountMinor: 50000, termWeeks: 6, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
      directDebitNetwork: 'MTN', directDebitMsisdn: msisdn,
    });
    expect(contract.status).toBe('PENDING_DEPOSIT');
    // Requested right away — the customer is still at the counter, not only
    // after they've paid the deposit and possibly left.
    expect(contract.hubtelPreapprovalId).not.toBeNull();
    expect(contract.pendingDirectDebitNetwork).toBe('MTN');

    const mandateId = contract.hubtelPreapprovalId;
    const mandateCountBefore = await prisma.hubtelPreapproval.count({ where: { customerId, network: 'MTN' } });
    expect(mandateCountBefore).toBe(1);

    await postPayment({ contractId: contract.id, amountMinor: 50000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });

    const activated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(activated.status).toBe('ACTIVE');
    // Same mandate carried through activation — the deposit-clearing fallback
    // (paymentService.advanceContractStatus) must not fire a second Hubtel
    // prompt for a mandate that's already attached.
    expect(activated.hubtelPreapprovalId).toBe(mandateId);
    const mandateCountAfter = await prisma.hubtelPreapproval.count({ where: { customerId, network: 'MTN' } });
    expect(mandateCountAfter).toBe(1);
  });

  it('a DEPOSIT_INSTALMENT contract created without direct debit still gets the deposit-clearing fallback', async () => {
    const productId = await makeProduct('DIDEFER');
    const { customerId, inventoryItemId, msisdn } = await makeCustomerAndItem(productId, 'DIDEFER');

    // No direct-debit network/msisdn at creation — nothing requested yet.
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
      totalPayableMinor: 100000, depositAmountMinor: 50000, termWeeks: 6, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
    });
    expect(contract.status).toBe('PENDING_DEPOSIT');
    expect(contract.hubtelPreapprovalId).toBeNull();

    // Staff sets it up manually before the deposit is paid — enableDirectDebit
    // now accepts PENDING_DEPOSIT for this contract type.
    const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'MTN', createdById: adminUserId });
    const withMandate = await enableDirectDebit({ contractId: contract.id, preapprovalId: preapproval.id, userId: adminUserId, paymentMethod: 'DIRECT_DEBIT' });
    expect(withMandate.hubtelPreapprovalId).toBe(preapproval.id);

    // Charging before the deposit clears (contract still PENDING_DEPOSIT) is refused —
    // the up-front deposit itself is never auto-debited, even once a mandate is attached.
    await expect(chargeDirectDebit({ contractId: contract.id, amountMinor: 8333 })).rejects.toThrow(/ACTIVE contract/);

    await postPayment({ contractId: contract.id, amountMinor: 50000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });
    const activated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(activated.status).toBe('ACTIVE');
    expect(activated.hubtelPreapprovalId).toBe(preapproval.id); // unchanged — no duplicate initiated by the fallback
  });

  it('gracePeriodDays and penaltyRateBps default to 7/0 and can be set explicitly at creation', async () => {
    const productId = await makeProduct('GRACEDEFAULT');
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'GRACEDEFAULT');
    const defaults = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
      totalPayableMinor: 60000, depositAmountMinor: 0, termWeeks: 6, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
    });
    expect(defaults.gracePeriodDays).toBe(7);
    expect(defaults.penaltyRateBps).toBe(0);

    const productId2 = await makeProduct('GRACECUSTOM');
    const { customerId: customerId2, inventoryItemId: inventoryItemId2 } = await makeCustomerAndItem(productId2, 'GRACECUSTOM');
    const custom = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: customerId2, inventoryItemId: inventoryItemId2,
      totalPayableMinor: 60000, depositAmountMinor: 0, termWeeks: 6, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
      gracePeriodDays: 3, penaltyRateBps: 500, // 5%
    });
    expect(custom.gracePeriodDays).toBe(3);
    expect(custom.penaltyRateBps).toBe(500);
  });

  it('applyLatePenalties charges a one-time late fee once an OVERDUE instalment passes its contract\'s grace period, and never double-charges', async () => {
    const productId = await makeProduct('PENALTY');
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'PENALTY');
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
      totalPayableMinor: 60000, depositAmountMinor: 0, termWeeks: 6, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
      gracePeriodDays: 2, penaltyRateBps: 1000, // 10%
    });
    // 0% deposit — any payment clears the gate immediately.
    await postPayment({ contractId: contract.id, amountMinor: 1, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });

    // Push the first instalment 3 days past due (grace is 2) and mark it OVERDUE, same as the daily sweep would.
    await prisma.instalment.updateMany({
      where: { contractId: contract.id, instalmentNo: 1 },
      data: { dueDate: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000), status: 'OVERDUE' },
    });

    const applied = await applyLatePenalties();
    expect(applied).toBeGreaterThanOrEqual(1);

    const penalty = await prisma.penalty.findFirstOrThrow({ where: { contractId: contract.id, reason: 'LATE_PENALTY' } });
    expect(penalty.amountMinor).toBe(1000); // 10% of the 10000-pesewa instalment

    // Running it again must not create a second penalty for the same lapse.
    await applyLatePenalties();
    const penaltyCount = await prisma.penalty.count({ where: { contractId: contract.id, reason: 'LATE_PENALTY' } });
    expect(penaltyCount).toBe(1);
  });

  it('applyLatePenalties is a no-op for a contract with penaltyRateBps 0 (the default) even when badly overdue', async () => {
    const productId = await makeProduct('NOPENALTY');
    const { customerId, inventoryItemId } = await makeCustomerAndItem(productId, 'NOPENALTY');
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
      totalPayableMinor: 60000, depositAmountMinor: 0, termWeeks: 6, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId,
    });
    await postPayment({ contractId: contract.id, amountMinor: 1, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });

    await prisma.instalment.updateMany({
      where: { contractId: contract.id, instalmentNo: 1 },
      data: { dueDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), status: 'OVERDUE' },
    });

    await applyLatePenalties();
    const penaltyCount = await prisma.penalty.count({ where: { contractId: contract.id } });
    expect(penaltyCount).toBe(0);
  });
});
