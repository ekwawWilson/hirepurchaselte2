/**
 * Hubtel's Direct Debit Preapproval API, end to end against a contract:
 *  - the two ways a mandate gets approved — a USSD prompt, or an OTP staff
 *    enter — and the callback that settles either;
 *  - a number already preapproved, which Hubtel approves with no callback;
 *  - the Preapproval Status Check, for a callback that never arrived;
 *  - Cancel and Reactivate;
 *  - who may see an approval through at the counter.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, withLiveHubtel, type HubtelCall } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as contractsPOST } from '@/app/api/contracts/route';
import { POST as verifyOtpPOST } from '@/app/api/contracts/[id]/direct-debit/verify-otp/route';
import { POST as statusPOST } from '@/app/api/contracts/[id]/direct-debit/status/route';
import { POST as cancelPOST } from '@/app/api/contracts/[id]/direct-debit/cancel/route';
import { POST as reactivatePOST } from '@/app/api/contracts/[id]/direct-debit/reactivate/route';
import { createContract } from '@/lib/services/contractService';
import { postPayment } from '@/lib/services/paymentService';
import {
  initiatePreapproval, submitPreapprovalOtp, processPreapprovalCallback, checkPreapprovalStatus,
  reconcilePendingPreapprovals, cancelPreapproval, reactivatePreapproval, disableDirectDebit, PreapprovalError,
} from '@/lib/services/hubtelPreapprovalService';

const PASSWORD = 'Passw0rd!123';
const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  return (await res.json()).token as string;
}

/** Hubtel's documented answer to an initiate or a reactivate. */
function requestAccepted(id: string, verificationType: 'USSD' | 'OTP', otpPrefix: string | null = null, clientReferenceId = 'echoed') {
  return {
    message: 'Request received! Pending preapproval', responseCode: '2000',
    data: { hubtelPreApprovalId: id, clientReferenceId, verificationType, otpPrefix, preapprovalStatus: 'PENDING' },
  };
}

describe('Direct debit mandate approval', () => {
  let branchId: string;
  let adminUserId: string;
  let counter = 0;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
  });

  async function makeCustomer(label: string) {
    counter += 1;
    const customer = await prisma.customer.create({
      data: {
        membershipId: `DDA-${label}-${runId}`, firstName: 'Mandate', lastName: label,
        phone: `020${runId}${counter}`, branchId, createdById: adminUserId,
      },
    });
    return { customerId: customer.id, msisdn: customer.phone as string };
  }

  async function makeItem(label: string) {
    const product = await prisma.product.create({
      data: { sku: `DDA-SKU-${label}-${runId}`, name: `Mandate Phone ${label}`, cashPriceMinor: 120000 },
    });
    return (await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `IMEI-DDA-${label}-${runId}` } })).id;
  }

  /** A contract created with direct debit, as the wizard does, while Hubtel answers `respond`. */
  async function makeContractWithMandate(label: string, respond: (call: HubtelCall) => unknown, overrides: Record<string, unknown> = {}) {
    const { customerId, msisdn } = await makeCustomer(label);
    const inventoryItemId = await makeItem(label);
    let contractId = '';
    await withLiveHubtel(respond, async () => {
      const contract = await createContract({
        contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
        totalPayableMinor: 120000, depositAmountMinor: 0, termWeeks: 6, paymentFrequency: 'WEEKLY',
        branchId, createdById: adminUserId, directDebitNetwork: 'TELECEL', directDebitMsisdn: msisdn,
        ...overrides,
      });
      contractId = contract.id;
    });
    const contract = await prisma.contract.findUniqueOrThrow({ where: { id: contractId }, include: { hubtelPreapproval: true } });
    return { contract, mandate: contract.hubtelPreapproval!, customerId, msisdn };
  }

  it('USSD: the customer approves the prompt on their phone, and the callback approves the mandate', async () => {
    const { mandate } = await makeContractWithMandate('USSD', () => requestAccepted(`HPA-USSD-${runId}`, 'USSD'));
    expect(mandate.status).toBe('PENDING');
    expect(mandate.verificationType).toBe('USSD');
    expect(mandate.otpPrefix).toBeNull();

    // An OTP has no meaning for a prompt-approved mandate.
    await expect(submitPreapprovalOtp({ preapprovalId: mandate.id, otpCode: '1234' })).rejects.toThrow(PreapprovalError);

    await processPreapprovalCallback({
      CustomerMsisdn: '233200000000', VerificationType: 'USSD', PreapprovalStatus: 'APPROVED',
      HubtelPreapprovalId: `HPA-USSD-${runId}`, ClientReferenceId: mandate.clientReferenceId, CreatedAt: '2022-11-14T21:08:16.7533466Z',
    });
    const approved = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: mandate.id } });
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedAt).not.toBeNull();
  });

  it('OTP: staff submit the code Hubtel texted the customer, and the callback approves the mandate', async () => {
    let mandateId = '';
    const calls = await withLiveHubtel(
      (call) => call.url.endsWith('/preapproval/verifyotp')
        ? { message: 'OTP Verified! Pending preapproval', responseCode: '2000', data: { hubtelPreApprovalId: `HPA-OTP-${runId}`, preapprovalStatus: 'PENDING' } }
        : requestAccepted(`HPA-OTP-${runId}`, 'OTP', 'HNRM'),
      async () => {
        const { customerId, msisdn } = await makeCustomer('OTP');
        const { preapproval } = await initiatePreapproval({ customerId, msisdn, network: 'TELECEL', createdById: adminUserId });
        mandateId = preapproval.id;
        expect(preapproval).toMatchObject({ status: 'PENDING', verificationType: 'OTP', otpPrefix: 'HNRM' });

        const afterOtp = await submitPreapprovalOtp({ preapprovalId: preapproval.id, otpCode: '8852' });
        expect(afterOtp.status).toBe('PENDING'); // the code is accepted; the callback still decides
      },
    );

    const [initiate, verify] = calls;
    // Telecel still rides Hubtel's vodafone channel, and numbers go out in 233 form.
    expect(initiate.url).toBe('https://preapproval.hubtel.com/api/v2/merchant/11684/preapproval/initiate');
    expect(initiate.body).toMatchObject({ channel: 'vodafone-gh-direct-debit' });
    expect(String(initiate.body!.customerMsisdn)).toMatch(/^233/);
    expect(verify.url).toBe('https://preapproval.hubtel.com/api/v2/merchant/11684/preapproval/verifyotp');
    expect(verify.body).toMatchObject({ hubtelPreApprovalId: `HPA-OTP-${runId}`, otpCode: 'HNRM-8852' });

    const mandate = await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: mandateId } });
    await processPreapprovalCallback({
      VerificationType: 'OTP', PreapprovalStatus: 'APPROVED', HubtelPreapprovalId: `HPA-OTP-${runId}`, ClientReferenceId: mandate.clientReferenceId,
    });
    expect((await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: mandateId } })).status).toBe('APPROVED');
  });

  it('a failed callback fails the mandate, whichever way it was being verified', async () => {
    const { mandate } = await makeContractWithMandate('CBFAIL', () => requestAccepted(`HPA-CBFAIL-${runId}`, 'OTP', 'GNCC'));
    await processPreapprovalCallback({
      VerificationType: 'OTP', PreapprovalStatus: 'FAILED', HubtelPreapprovalId: `HPA-CBFAIL-${runId}`, ClientReferenceId: mandate.clientReferenceId,
    });
    expect((await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: mandate.id } })).status).toBe('FAILED');
  });

  it('a number already preapproved for this merchant is approved on the spot — no prompt is sent, so no callback will come', async () => {
    const { mandate } = await makeContractWithMandate('ALREADY', () => ({
      message: 'success, Customer is already preapproved', responseCode: '2000', data: null,
    }));
    expect(mandate.status).toBe('APPROVED');
    expect(mandate.approvedAt).not.toBeNull();
  });

  it('a request Hubtel rejects outright leaves no mandate behind, and the contract is still created', async () => {
    const { contract } = await makeContractWithMandate('REJECT', () => ({
      message: 'Preapproval request failed! Please try again.', responseCode: '4204', data: null,
    }));
    expect(contract.hubtelPreapprovalId).toBeNull();
    expect(await prisma.hubtelPreapproval.count({ where: { customerId: contract.customerId } })).toBe(0);
    // Still on file, so it can be asked for again.
    expect(contract.pendingDirectDebitNetwork).toBe('TELECEL');
  });

  it('the status check settles a mandate whose callback never arrived', async () => {
    const { mandate } = await makeContractWithMandate('LOSTCB', () => requestAccepted(`HPA-LOSTCB-${runId}`, 'USSD'));

    const calls = await withLiveHubtel(
      // Hubtel's own sample: `code`, not `responseCode`, and a differently-cased id.
      () => ({
        message: 'Success', code: '2000',
        data: { customerMsisdn: '233546335113', verificationType: 'USSD', preapprovalStatus: 'APPROVED', hubtelPreapprovalId: `HPA-LOSTCB-${runId}`, clientReferenceId: mandate.clientReferenceId },
      }),
      async () => {
        const checked = await checkPreapprovalStatus({ preapprovalId: mandate.id });
        expect(checked.status).toBe('APPROVED');
      },
    );
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `https://preapproval.hubtel.com/api/v2/merchant/11684/preapproval/${mandate.clientReferenceId}/status`,
    });
  });

  it('the scheduled sweep status-checks stale pending mandates: an expired request fails, a still-pending one is left alone', async () => {
    const expired = await makeContractWithMandate('SWEEPEXP', () => requestAccepted(`HPA-SWEEPEXP-${runId}`, 'USSD'));
    const waiting = await makeContractWithMandate('SWEEPWAIT', () => requestAccepted(`HPA-SWEEPWAIT-${runId}`, 'OTP', 'RTYE'));
    const fresh = await makeContractWithMandate('SWEEPNEW', () => requestAccepted(`HPA-SWEEPNEW-${runId}`, 'USSD'));
    // Requested ten minutes ago — past the five the docs say to wait for a callback.
    await prisma.hubtelPreapproval.updateMany({
      where: { id: { in: [expired.mandate.id, waiting.mandate.id] } },
      data: { updatedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const calls = await withLiveHubtel(
      (call) => ({
        message: 'Success', code: '2000',
        data: { preapprovalStatus: call.url.includes(expired.mandate.clientReferenceId) ? 'EXPIRED' : 'PENDING' },
      }),
      async () => { await reconcilePendingPreapprovals(); },
    );

    const urls = calls.map((c) => c.url).join(' ');
    expect(urls).toContain(expired.mandate.clientReferenceId);
    expect(urls).toContain(waiting.mandate.clientReferenceId);
    expect(urls).not.toContain(fresh.mandate.clientReferenceId); // too recent — its callback may still be on the way

    const status = async (id: string) => (await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id } })).status;
    expect(await status(expired.mandate.id)).toBe('FAILED');
    expect(await status(waiting.mandate.id)).toBe('PENDING');
  });

  it('cancel revokes the mandate at Hubtel by wallet number; reactivate sends it back through approval', async () => {
    const { mandate, contract } = await makeContractWithMandate('CANCEL', () => ({
      message: 'success, Customer is already preapproved', responseCode: '2000', data: null,
    }));

    // Hubtel declining to cancel must not be recorded as cancelled.
    await withLiveHubtel(
      () => ({ message: 'No preapproval found', responseCode: '2001', data: false }),
      async () => { await expect(cancelPreapproval({ preapprovalId: mandate.id })).rejects.toThrow(PreapprovalError); },
    );
    expect((await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: mandate.id } })).status).toBe('APPROVED');

    const cancelCalls = await withLiveHubtel(
      () => ({ message: 'Successfully cancelled preapproval for customer 233548359582 and business gershon', responseCode: '2000', data: true }),
      async () => { expect((await cancelPreapproval({ preapprovalId: mandate.id })).status).toBe('CANCELLED'); },
    );
    expect(cancelCalls[0].method).toBe('GET');
    expect(cancelCalls[0].url).toMatch(/\/merchant\/11684\/preapproval\/233\d+\/cancel$/);
    // The contract keeps the (now unusable) mandate, so it can be reactivated in place.
    expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).hubtelPreapprovalId).toBe(mandate.id);

    // Hubtel answers a reactivation like a new request — here asking for an
    // OTP, under a reference of its own rather than the one this app issued.
    const reactivateCalls = await withLiveHubtel(
      () => requestAccepted(`HPA-REACTIVATED-${runId}`, 'OTP', 'GNCC', `hubtel-ref-${runId}`),
      async () => {
        const reactivated = await reactivatePreapproval({ preapprovalId: mandate.id });
        expect(reactivated).toMatchObject({ status: 'PENDING', verificationType: 'OTP', otpPrefix: 'GNCC', hubtelPreapprovalId: `HPA-REACTIVATED-${runId}`, cancelledAt: null });
      },
    );
    expect(reactivateCalls[0].url).toBe('https://preapproval.hubtel.com/api/v2/merchant/11684/preapproval/reactivate');
    expect(Object.keys(reactivateCalls[0].body!).sort()).toEqual(['callbackUrl', 'customerMsisdn']);

    // A callback naming a reference this app has never seen still finds the
    // mandate, by Hubtel's own id.
    await processPreapprovalCallback({ PreapprovalStatus: 'APPROVED', HubtelPreapprovalId: `HPA-REACTIVATED-${runId}`, ClientReferenceId: 'never-issued-here' });
    expect((await prisma.hubtelPreapproval.findUniqueOrThrow({ where: { id: mandate.id } })).status).toBe('APPROVED');
  });

  it('only a cancelled mandate can be reactivated', async () => {
    const { mandate } = await makeContractWithMandate('NOREACT', () => requestAccepted(`HPA-NOREACT-${runId}`, 'USSD'));
    await expect(reactivatePreapproval({ preapprovalId: mandate.id })).rejects.toThrow(PreapprovalError);
  });

  it('disabling direct debit before the deposit is paid stays disabled — the deposit clearing does not prompt the customer again', async () => {
    const { contract, customerId } = await makeContractWithMandate(
      'DISABLE', () => requestAccepted(`HPA-DISABLE-${runId}`, 'USSD'), { depositAmountMinor: 20000 },
    );
    expect(contract.status).toBe('PENDING_DEPOSIT');

    await disableDirectDebit({ contractId: contract.id, userId: adminUserId });
    await postPayment({ contractId: contract.id, amountMinor: 20000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });

    const activated = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
    expect(activated.status).toBe('ACTIVE');
    expect(activated.hubtelPreapprovalId).toBeNull();
    expect(await prisma.hubtelPreapproval.count({ where: { customerId } })).toBe(1); // only the one that was disabled
  });

  describe('at the counter', () => {
    let cashier: string;
    let cashierUserId: string;

    beforeAll(async () => {
      cashier = await login('cashier@example.test');
      const user = await prisma.user.findUniqueOrThrow({ where: { email: 'cashier@example.test' } });
      cashierUserId = user.id;
      branchId = user.branchId!;
    });

    it('creating a contract with direct debit reports how the mandate request went', async () => {
      const { customerId, msisdn } = await makeCustomer('WIZARD');
      const inventoryItemId = await makeItem('WIZARD');
      await withLiveHubtel(() => requestAccepted(`HPA-WIZARD-${runId}`, 'OTP', 'HNRM'), async () => {
        const res = await contractsPOST(makeRequest('POST', '/api/contracts', {
          token: cashier,
          body: {
            contractType: 'DEPOSIT_INSTALMENT', customerId, inventoryItemId,
            totalPayableMinor: 120000, depositAmountMinor: 20000, termWeeks: 6, paymentFrequency: 'WEEKLY',
            paymentMethod: 'DIRECT_DEBIT', directDebitNetwork: 'MTN', directDebitMsisdn: msisdn,
          },
        }));
        expect(res.status).toBe(201);
        const { directDebit } = await res.json();
        expect(directDebit).toEqual({ mandate: { status: 'PENDING', verificationType: 'OTP' } });
      });
    });

    it('whoever can create a contract can see its approval through, but not revoke or reactivate a mandate', async () => {
      const { contract } = await makeContractWithMandate('COUNTER', () => requestAccepted(`HPA-COUNTER-${runId}`, 'OTP', 'HNRM'), { createdById: cashierUserId });
      const params = () => makeParams({ id: contract.id });
      const path = (action: string) => `/api/contracts/${contract.id}/direct-debit/${action}`;

      await withLiveHubtel(
        (call) => call.url.endsWith('/verifyotp')
          ? { message: 'OTP Verified! Pending preapproval', responseCode: '2000', data: { hubtelPreApprovalId: `HPA-COUNTER-${runId}`, preapprovalStatus: 'PENDING' } }
          : { message: 'Success', code: '2000', data: { preapprovalStatus: 'APPROVED' } },
        async () => {
          const otp = await verifyOtpPOST(makeRequest('POST', path('verify-otp'), { token: cashier, body: { otpCode: '4411' } }), params());
          expect(otp.status).toBe(200);

          const wrong = await verifyOtpPOST(makeRequest('POST', path('verify-otp'), { token: cashier, body: { otpCode: '44' } }), params());
          expect(wrong.status).toBe(400);

          const status = await statusPOST(makeRequest('POST', path('status'), { token: cashier }), params());
          expect(status.status).toBe(200);
          expect((await status.json()).preapproval.status).toBe('APPROVED');
        },
      );

      expect((await cancelPOST(makeRequest('POST', path('cancel'), { token: cashier }), params())).status).toBe(403);
      expect((await reactivatePOST(makeRequest('POST', path('reactivate'), { token: cashier }), params())).status).toBe(403);
    });

    it('an agent cannot verify a mandate on a contract that is not their own', async () => {
      const agent = await login('agent@example.test');
      const { contract } = await makeContractWithMandate('NOTMINE', () => requestAccepted(`HPA-NOTMINE-${runId}`, 'OTP', 'HNRM'));
      const res = await verifyOtpPOST(
        makeRequest('POST', `/api/contracts/${contract.id}/direct-debit/verify-otp`, { token: agent, body: { otpCode: '4411' } }),
        makeParams({ id: contract.id }),
      );
      expect(res.status).toBe(403);
    });
  });
});
