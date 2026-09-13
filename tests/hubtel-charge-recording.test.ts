/**
 * A Hubtel charge that has already taken the customer's money must always
 * end up either on the ledger or flagged for staff — never silently dropped
 * (hubtelPaymentService.recordSuccessfulHubtelCharge).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { createContract, cancelContract } from '@/lib/services/contractService';
import { getDeviceLoanState } from '@/lib/services/paymentService';
import { processHubtelCallback, reconcilePendingHubtelTransactions } from '@/lib/services/hubtelPaymentService';
import { POST as hubtelCallbackPOST } from '@/app/api/payments/hubtel/callback/route';
import { enableOptionalContractTypes } from './helpers';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;

// Save to Own and Device Loan must be activated before they can be created.
beforeAll(enableOptionalContractTypes);

describe('Recording collected Hubtel charges', () => {
  let branchId: string;
  let adminUserId: string;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow()).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
  });

  async function makeCustomer() {
    counter += 1;
    const phone = `027${runId}${counter}`;
    const customer = await prisma.customer.create({
      data: {
        membershipId: `HCR-${runId}-${counter}`, firstName: 'Charge', lastName: 'Recorder', phone,
        branchId, createdById: adminUserId,
      },
    });
    return { customerId: customer.id, phone };
  }

  it('a charge the ledger refuses (contract cancelled meanwhile) becomes NEEDS_REVIEW with an audit entry, instead of vanishing', async () => {
    const { customerId, phone } = await makeCustomer();
    const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId, branchId, createdById: adminUserId });
    await cancelContract({ contractId: contract.id, reason: 'Customer changed mind', userId: adminUserId });

    const clientReference = `HCR-CANCELLED-${runId}`;
    await prisma.hubtelTransaction.create({
      data: { clientReference, contractId: contract.id, msisdn: phone, amountMinor: 5000, status: 'PENDING' },
    });

    const txn = await processHubtelCallback({ clientReference, status: 'SUCCESS', rawPayload: '{}' });
    expect(txn.status).toBe('NEEDS_REVIEW');
    expect(txn.paymentId).toBeNull();

    const audit = await prisma.auditLog.findFirst({ where: { action: 'HUBTEL_PAYMENT_UNRECORDED', entityId: txn.id } });
    expect(audit).not.toBeNull();
    expect(JSON.parse(audit!.newValues!).reason).toMatch(/CANCELLED/);

    // A replayed callback leaves it flagged, not reprocessed.
    const replay = await processHubtelCallback({ clientReference, status: 'SUCCESS', rawPayload: '{}' });
    expect(replay.status).toBe('NEEDS_REVIEW');
  });

  it('DEVICE_LOAN: interest that accrues between USSD confirm and the callback no longer loses the charge', async () => {
    const { customerId, phone } = await makeCustomer();
    const contract = await createContract({ contractType: 'DEVICE_LOAN', customerId, branchId, createdById: adminUserId, loanAmountMinor: 100000 });

    // The day the customer confirmed on their phone: GHS10 of interest owed.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await prisma.penalty.create({ data: { contractId: contract.id, amountMinor: 1000, reason: 'DAILY_LOAN_INTEREST', appliedDate: yesterday } });
    const clientReference = `HCR-LOAN-RACE-${runId}`;
    await prisma.hubtelTransaction.create({
      data: { clientReference, contractId: contract.id, msisdn: phone, amountMinor: 1000, status: 'PENDING' },
    });

    // Another day accrues before Hubtel's callback arrives.
    await prisma.penalty.create({ data: { contractId: contract.id, amountMinor: 1000, reason: 'DAILY_LOAN_INTEREST', appliedDate: new Date() } });

    const txn = await processHubtelCallback({ clientReference, status: 'SUCCESS', rawPayload: '{}' });
    expect(txn.status).toBe('SUCCESS');
    expect(txn.paymentId).not.toBeNull();

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: txn.paymentId! } });
    expect(payment.entryType).toBe('LOAN_INTEREST_PAYMENT');
    expect(payment.initiatedByCustomerId).toBe(customerId);

    // The older day is paid; the day that accrued afterwards is still owed.
    const state = await getDeviceLoanState(contract.id);
    expect(state.interestPaidMinor).toBe(1000);
    expect(state.accruedInterestMinor).toBe(1000);
  });

  it('reconciliation retries a SUCCESS charge whose ledger posting never completed', async () => {
    const { customerId, phone } = await makeCustomer();
    const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId, branchId, createdById: adminUserId });

    // Simulates a crash between marking the charge SUCCESS and posting it.
    const clientReference = `HCR-UNRECORDED-${runId}`;
    const created = await prisma.hubtelTransaction.create({
      data: { clientReference, contractId: contract.id, msisdn: phone, amountMinor: 7000, status: 'SUCCESS' },
    });
    await prisma.$executeRaw`UPDATE hubtel_transactions SET "updatedAt" = now() - interval '1 hour' WHERE id = ${created.id}`;

    await reconcilePendingHubtelTransactions();

    const txn = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: created.id } });
    expect(txn.status).toBe('SUCCESS');
    expect(txn.paymentId).not.toBeNull();
    const updated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(updated.totalPaidMinor).toBe(7000);

    // Running it again posts nothing twice.
    await reconcilePendingHubtelTransactions();
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).totalPaidMinor).toBe(7000);
  });

  it('the callback route answers a malformed body with 400, not a crash', async () => {
    const req = new NextRequest(new URL('http://localhost:3000/api/payments/hubtel/callback'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-webhook-token': process.env.WEBHOOK_SHARED_TOKEN ?? '' },
      body: 'not json{',
    });
    const res = await hubtelCallbackPOST(req);
    expect(res.status).toBe(400);
  });
});
