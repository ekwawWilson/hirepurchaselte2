import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, registrationFields } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { accrueDailyLoanInterest } from '@/lib/services/loanService';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as branchesGET } from '@/app/api/branches/route';
import { POST as productsPOST } from '@/app/api/products/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { POST as inventoryPOST, GET as inventoryGET } from '@/app/api/inventory/route';
import { POST as contractsPOST } from '@/app/api/contracts/route';
import { GET as contractGET } from '@/app/api/contracts/[id]/route';
import { POST as contractReleasePOST } from '@/app/api/contracts/[id]/release/route';
import { POST as paymentsCashPOST } from '@/app/api/payments/cash/route';
import { POST as deviceLoanPaymentsPOST } from '@/app/api/payments/device-loan/route';
import { GET as paymentsGET } from '@/app/api/payments/route';
import { POST as paymentReversePOST } from '@/app/api/payments/[id]/reverse/route';
import { POST as withdrawPOST } from '@/app/api/payments/withdraw/route';

const PASSWORD = 'Passw0rd!123';

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.token as string;
}

const runId = Date.now().toString().slice(-8);
let counter = 0;
function uniquePhone() {
  counter += 1;
  return `020${runId}${counter}`;
}
function uniqueSerial(label: string) {
  return `IMEI-${label}-${runId}`;
}

// Save to Own and Device Loan must be activated before they can be created.
beforeAll(enableOptionalContractTypes);

describe('Contracts + payments: full lifecycle across all three types', () => {
  let admin: string;
  let cashier: string;
  let sales: string;
  let branchId: string;
  let productId: string;

  beforeAll(async () => {
    admin = await login('admin@example.test');
    cashier = await login('cashier@example.test');
    sales = await login('sales@example.test');

    const branchesRes = await branchesGET(makeRequest('GET', '/api/branches', { token: admin }));
    const branchesBody = await branchesRes.json();
    branchId = branchesBody.branches[0].id;

    const productRes = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { sku: `TEST-SKU-${runId}`, name: 'Test Phone', cashPriceMinor: 250000 },
    }));
    expect(productRes.status).toBe(201);
    const productBody = await productRes.json();
    productId = productBody.product.id;
  });

  async function makeCustomer(label: string) {
    const res = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { ...registrationFields(), firstName: 'Test', lastName: label, phone: uniquePhone() },
    }));
    expect(res.status).toBe(201);
    return (await res.json()).customer.id as string;
  }

  async function receiveItem(label: string) {
    const res = await inventoryPOST(makeRequest('POST', '/api/inventory', {
      token: admin, body: { productId, serialNumber: uniqueSerial(label), branchId },
    }));
    expect(res.status).toBe(201);
    return (await res.json()).item.id as string;
  }

  async function getItemStatus(itemId: string) {
    const res = await inventoryGET(makeRequest('GET', `/api/inventory?productId=${productId}`, { token: admin }));
    const body = await res.json();
    return body.items.find((i: { id: string; status: string }) => i.id === itemId).status;
  }

  async function getContract(contractId: string, token: string) {
    const res = await contractGET(makeRequest('GET', `/api/contracts/${contractId}`, { token }), makeParams({ id: contractId }));
    expect(res.status).toBe(200);
    return (await res.json()).contract;
  }

  /** Total price/deposit/term are entered directly now — no price chart lookup at all (contractService.ts). */
  async function makeDepositInstalment(token: string, custId: string, itemId: string, overrides: Record<string, unknown> = {}) {
    return contractsPOST(makeRequest('POST', '/api/contracts', {
      token,
      body: {
        contractType: 'DEPOSIT_INSTALMENT', customerId: custId, inventoryItemId: itemId,
        totalPayableMinor: 300000, depositAmountMinor: 60000, termWeeks: 6, paymentFrequency: 'WEEKLY',
        ...overrides,
      },
    }));
  }

  it('SAVE_TO_OWN: open-ended savings — no product, no target, deposits accumulate, and it never auto-completes', async () => {
    const custId = await makeCustomer('SaveToOwn');

    // No inventoryItemId, no productId, no term — SAVE_TO_OWN needs none of
    // them (contractService.ts).
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId: custId },
    }));
    expect(created.status).toBe(201);
    const contract = (await created.json()).contract;
    expect(contract.status).toBe('ACTIVE');
    expect(contract.productId).toBeNull();
    expect(contract.inventoryItemId).toBeNull();
    expect(contract.totalPayableMinor).toBeNull();
    expect(contract.balanceMinor).toBeNull();

    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 200000, entryType: 'INSTALMENT_PAYMENT', notes: 'Counter cash deposit' },
    }));
    let detail = await getContract(contract.id, cashier);
    expect(detail.totalPaidMinor).toBe(200000);
    expect(detail.balanceMinor).toBeNull();
    expect(detail.status).toBe('ACTIVE');
    expect(detail.payments[0].notes).toBe('Counter cash deposit');

    // A further, larger deposit — still nothing to "complete" against.
    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 400000, entryType: 'INSTALMENT_PAYMENT' },
    }));
    detail = await getContract(contract.id, cashier);
    expect(detail.totalPaidMinor).toBe(600000);
    expect(detail.balanceMinor).toBeNull();
    expect(detail.status).toBe('ACTIVE'); // never auto-completes — no target to reach
    expect(detail.instalments).toHaveLength(0);

    // No device was ever reserved, so release (which requires an inventory
    // item and a COMPLETED status neither of which this account has) is refused.
    const released = await contractReleasePOST(makeRequest('POST', `/api/contracts/${contract.id}/release`, { token: admin }), makeParams({ id: contract.id }));
    expect(released.status).toBe(400);
  });

  it('SAVE_TO_OWN: customer can withdraw part of their savings, capped at what they saved, and reversing it restores the total', async () => {
    const custId = await makeCustomer('Withdraw');
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId: custId },
    }));
    const contract = (await created.json()).contract;

    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 100000, entryType: 'INSTALMENT_PAYMENT' },
    }));

    // Can't withdraw more than has actually been saved.
    const overWithdraw = await withdrawPOST(makeRequest('POST', '/api/payments/withdraw', {
      token: admin, body: { contractId: contract.id, amountMinor: 100001 },
    }));
    expect(overWithdraw.status).toBe(400);

    // A cashier (payment.cash.record only, no payment.reverse) can record money in but not pay it back out.
    const forbidden = await withdrawPOST(makeRequest('POST', '/api/payments/withdraw', {
      token: cashier, body: { contractId: contract.id, amountMinor: 10000 },
    }));
    expect(forbidden.status).toBe(403);

    const withdrawn = await withdrawPOST(makeRequest('POST', '/api/payments/withdraw', {
      token: admin, body: { contractId: contract.id, amountMinor: 30000, notes: 'Emergency withdrawal' },
    }));
    expect(withdrawn.status).toBe(201);
    const withdrawal = (await withdrawn.json()).payment;
    expect(withdrawal.entryType).toBe('WITHDRAWAL');
    expect(withdrawal.notes).toBe('Emergency withdrawal');

    let detail = await getContract(contract.id, admin);
    expect(detail.totalPaidMinor).toBe(70000);
    expect(detail.balanceMinor).toBeNull(); // SAVE_TO_OWN never has a balance to speak of

    // Reversing the withdrawal — same reversal mechanism as any other payment — restores it.
    const reversed = await paymentReversePOST(
      makeRequest('POST', `/api/payments/${withdrawal.id}/reverse`, { token: admin, body: { reason: 'test reversal' } }),
      makeParams({ id: withdrawal.id }),
    );
    expect(reversed.status).toBe(201);
    detail = await getContract(contract.id, admin);
    expect(detail.totalPaidMinor).toBe(100000);
    expect(detail.balanceMinor).toBeNull();
  });

  it('withdrawals are only available on SAVE_TO_OWN contracts', async () => {
    const custId = await makeCustomer('NoWithdraw');
    const itemId = await receiveItem('NW');
    const created = await makeDepositInstalment(cashier, custId, itemId);
    const contract = (await created.json()).contract;

    const res = await withdrawPOST(makeRequest('POST', '/api/payments/withdraw', {
      token: admin, body: { contractId: contract.id, amountMinor: 10000 },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/only available on save to own/i);
  });

  it('DEPOSIT_INSTALMENT: total price, deposit, and term are entered directly, and WEEKLY term weeks map 1:1 to instalments', async () => {
    const custId = await makeCustomer('DirectTerms');
    const itemId = await receiveItem('DT');

    const created = await makeDepositInstalment(admin, custId, itemId, { branchId, totalPayableMinor: 280000, depositAmountMinor: 50000, termWeeks: 5, paymentFrequency: 'WEEKLY' });
    expect(created.status).toBe(201);
    const contract = (await created.json()).contract;
    expect(contract.totalPayableMinor).toBe(280000);
    expect(contract.depositAmountMinor).toBe(50000);
    expect(contract.termWeeks).toBe(5);
    expect(contract.balanceMinor).toBe(280000);
    expect(contract.instalmentAmountMinor).toBe(Math.ceil((280000 - 50000) / 5));

    const detail = await getContract(contract.id, admin);
    expect(detail.instalments).toHaveLength(5); // WEEKLY: one instalment per week
    const scheduledTotal = detail.instalments.reduce((s: number, i: { amountDueMinor: number }) => s + i.amountDueMinor, 0);
    expect(scheduledTotal).toBe(280000 - 50000);
  });

  it('DEPOSIT_INSTALMENT: DAILY frequency expands term weeks into 7x as many instalments', async () => {
    const custId = await makeCustomer('DailyTerms');
    const itemId = await receiveItem('DLY');

    const created = await makeDepositInstalment(admin, custId, itemId, { branchId, totalPayableMinor: 210000, depositAmountMinor: 30000, termWeeks: 3, paymentFrequency: 'DAILY' });
    expect(created.status).toBe(201);
    const contract = (await created.json()).contract;
    expect(contract.termWeeks).toBe(3);
    expect(contract.instalmentAmountMinor).toBe(Math.ceil((210000 - 30000) / 21)); // 3 weeks * 7 = 21 daily instalments

    const detail = await getContract(contract.id, admin);
    expect(detail.instalments).toHaveLength(21);
  });

  it('DEPOSIT_INSTALMENT rejects a term outside 1-24 weeks and a MONTHLY frequency', async () => {
    const custId = await makeCustomer('BadTerms');
    const itemId = await receiveItem('BT');

    const tooLong = await makeDepositInstalment(cashier, custId, itemId, { termWeeks: 25 });
    expect(tooLong.status).toBe(400);
    expect((await tooLong.json()).error).toMatch(/termWeeks/i);

    const itemId2 = await receiveItem('BT2');
    const monthly = await makeDepositInstalment(cashier, custId, itemId2, { paymentFrequency: 'MONTHLY' });
    expect(monthly.status).toBe(400);
    expect((await monthly.json()).error).toMatch(/paymentFrequency/i);
  });

  it('DEPOSIT_INSTALMENT: device withheld until deposit threshold is met (partial deposits accumulate)', async () => {
    const custId = await makeCustomer('DepositInst');
    const itemId = await receiveItem('B');

    const created = await makeDepositInstalment(cashier, custId, itemId);
    const contract = (await created.json()).contract;
    expect(contract.status).toBe('PENDING_DEPOSIT');
    expect(contract.depositAmountMinor).toBe(60000);
    expect(await getItemStatus(itemId)).toBe('RESERVED');

    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 30000, entryType: 'DEPOSIT' },
    }));
    let detail = await getContract(contract.id, cashier);
    expect(detail.status).toBe('PENDING_DEPOSIT');

    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 30000, entryType: 'DEPOSIT' },
    }));
    detail = await getContract(contract.id, cashier);
    expect(detail.status).toBe('ACTIVE');
    expect(detail.totalPaidMinor).toBe(60000);
    expect(detail.instalments[0].amountDueMinor).toBe(40000);
    expect(await getItemStatus(itemId)).toBe('ISSUED');
  });

  it('Payment idempotency + reversal: replay does not double-post, original row survives reversal', async () => {
    const custId = await makeCustomer('Idempotency');
    const itemId = await receiveItem('IDEM');
    const created = await makeDepositInstalment(cashier, custId, itemId);
    const contract = (await created.json()).contract;
    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 60000, entryType: 'DEPOSIT' },
    }));

    const ref = `TEST-IDEMPOTENT-${runId}`;
    const first = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 40000, entryType: 'INSTALMENT_PAYMENT', transactionRef: ref },
    }));
    expect(first.status).toBe(201);
    const firstBody = await first.json();
    const paidAfterFirst = (await getContract(contract.id, cashier)).totalPaidMinor;

    const replay = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 40000, entryType: 'INSTALMENT_PAYMENT', transactionRef: ref },
    }));
    expect(replay.status).toBe(201);
    expect((await replay.json()).idempotentReplay).toBe(true);
    expect((await getContract(contract.id, cashier)).totalPaidMinor).toBe(paidAfterFirst);

    const paymentId = firstBody.payment.id;
    const reversed = await paymentReversePOST(
      makeRequest('POST', `/api/payments/${paymentId}/reverse`, { token: admin, body: { reason: 'test correction' } }),
      makeParams({ id: paymentId }),
    );
    expect(reversed.status).toBe(201);
    expect((await getContract(contract.id, cashier)).totalPaidMinor).toBe(paidAfterFirst - 40000);

    const paymentsRes = await paymentsGET(makeRequest('GET', `/api/payments?contractId=${contract.id}`, { token: cashier }));
    const originalRow = (await paymentsRes.json()).payments.find((p: { id: string }) => p.id === paymentId);
    expect(originalRow.status).toBe('SUCCESS'); // never mutated/deleted
    expect(originalRow.reversedById).not.toBeNull();

    const doubleReverse = await paymentReversePOST(
      makeRequest('POST', `/api/payments/${paymentId}/reverse`, { token: admin, body: { reason: 'again' } }),
      makeParams({ id: paymentId }),
    );
    expect(doubleReverse.status).toBe(400);
  });

  it('rejects a DEVICE_LOAN contract linked to an inventory item, or missing a positive loanAmountMinor', async () => {
    const custId = await makeCustomer('BadDeviceLoan');
    const itemId = await receiveItem('BDL');

    const withItem = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId: custId, inventoryItemId: itemId, loanAmountMinor: 100000 },
    }));
    expect(withItem.status).toBe(400);
    expect((await withItem.json()).error).toMatch(/not linked to a product/i);

    const noAmount = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId: custId },
    }));
    expect(noAmount.status).toBe(400);
    expect((await noAmount.json()).error).toMatch(/loanAmountMinor is required/i);
  });

  it('rejects a DEPOSIT_INSTALMENT contract with no inventoryItemId', async () => {
    const custId = await makeCustomer('NoItemDeposit');
    const res = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEPOSIT_INSTALMENT', customerId: custId, totalPayableMinor: 300000, depositAmountMinor: 60000, termWeeks: 6 },
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/inventoryItemId is required/i);
  });

  it('DEVICE_LOAN: disbursed immediately with no product/schedule, and daily interest accrues as a flat 1% of the original amount', async () => {
    const custId = await makeCustomer('DeviceLoan');

    // Not linked to a product or inventory item — cash is disbursed directly
    // (contractService.ts's new DEVICE_LOAN model).
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId: custId, loanAmountMinor: 100000 },
    }));
    expect(created.status).toBe(201);
    const contract = (await created.json()).contract;
    expect(contract.status).toBe('ACTIVE'); // cash disbursed unconditionally, no down-payment gate
    expect(contract.principalMinor).toBe(100000);
    expect(contract.inventoryItemId).toBeNull();
    expect(contract.productId).toBeNull();
    // Snapshotted from whatever LoanSettings currently holds (loanSettingsService.ts's
    // DEFAULTS is 1%/day, 0 grace days — but another test/run may have changed the
    // global row, so read it back rather than assuming the default survived).
    expect(contract.interestRateBps).toBeGreaterThan(0);
    expect(contract.gracePeriodDays).toBeGreaterThanOrEqual(0);

    let detail = await getContract(contract.id, cashier);
    expect(detail.deviceLoanState.principalMinor).toBe(100000);
    expect(detail.deviceLoanState.principalOutstanding).toBe(true);
    expect(detail.deviceLoanState.accruedInterestMinor).toBe(0);
    expect(detail.instalments).toHaveLength(0); // no fixed schedule under the new model

    // The generic cash-payment route refuses this contract type outright.
    const genericAttempt = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 100000, entryType: 'INSTALMENT_PAYMENT' },
    }));
    expect(genericAttempt.status).toBe(400);
    expect((await genericAttempt.json()).error).toMatch(/postDeviceLoanPayment/);

    // Simulates one day of the accrual sweep (loanService.accrueDailyLoanInterest)
    // directly, so the test doesn't depend on the actual day of the week it runs
    // on — computed off the contract's own snapshotted rate, the same formula
    // loanService.ts uses.
    const dailyInterestMinor = Math.round((100000 * contract.interestRateBps) / 10000);
    await prisma.penalty.create({
      data: { contractId: contract.id, amountMinor: dailyInterestMinor, reason: 'DAILY_LOAN_INTEREST', appliedDate: new Date() },
    });

    detail = await getContract(contract.id, cashier);
    expect(detail.deviceLoanState.accruedInterestMinor).toBe(dailyInterestMinor);
    expect(detail.deviceLoanState.totalOwedMinor).toBe(100000 + dailyInterestMinor);

    // Exact-match validation: neither an under- nor over-payment of interest is accepted.
    const wrongInterest = await deviceLoanPaymentsPOST(makeRequest('POST', '/api/payments/device-loan', {
      token: cashier, body: { contractId: contract.id, amountMinor: dailyInterestMinor + 1, option: 'INTEREST' },
    }));
    expect(wrongInterest.status).toBe(400);
    expect((await wrongInterest.json()).error).toMatch(/exactly the accrued interest/i);

    const payInterest = await deviceLoanPaymentsPOST(makeRequest('POST', '/api/payments/device-loan', {
      token: cashier, body: { contractId: contract.id, amountMinor: dailyInterestMinor, option: 'INTEREST' },
    }));
    expect(payInterest.status).toBe(201);
    const interestPayment = (await payInterest.json()).payment;
    expect(interestPayment.entryType).toBe('LOAN_INTEREST_PAYMENT');

    detail = await getContract(contract.id, cashier);
    expect(detail.deviceLoanState.accruedInterestMinor).toBe(0);
    expect(detail.deviceLoanState.interestPaidMinor).toBe(dailyInterestMinor);
    expect(detail.status).toBe('ACTIVE'); // principal still outstanding

    // Exact-match validation on the principal side too.
    const wrongPrincipal = await deviceLoanPaymentsPOST(makeRequest('POST', '/api/payments/device-loan', {
      token: cashier, body: { contractId: contract.id, amountMinor: 99999, option: 'PRINCIPAL' },
    }));
    expect(wrongPrincipal.status).toBe(400);
    expect((await wrongPrincipal.json()).error).toMatch(/exactly the full loan amount/i);

    // Paying the full loan amount clears the principal only.
    const payPrincipal = await deviceLoanPaymentsPOST(makeRequest('POST', '/api/payments/device-loan', {
      token: cashier, body: { contractId: contract.id, amountMinor: 100000, option: 'PRINCIPAL' },
    }));
    expect(payPrincipal.status).toBe(201);
    expect((await payPrincipal.json()).payment.entryType).toBe('LOAN_PRINCIPAL_PAYMENT');

    detail = await getContract(contract.id, cashier);
    expect(detail.deviceLoanState.principalOutstanding).toBe(false);
    expect(detail.status).toBe('COMPLETED'); // principal paid AND no unpaid interest left

    // Once fully paid, the accrual sweep skips it — there's no more "loan" to charge
    // 1% of. Scoped to this contract's own penalty rows, not the sweep's total return
    // count — other tests in this shared DB leave their own ACTIVE DEVICE_LOAN
    // contracts around, which the same sweep call also (correctly) accrues against.
    const penaltiesBefore = await prisma.penalty.count({ where: { contractId: contract.id, reason: 'DAILY_LOAN_INTEREST' } });
    await accrueDailyLoanInterest();
    const penaltiesAfter = await prisma.penalty.count({ where: { contractId: contract.id, reason: 'DAILY_LOAN_INTEREST' } });
    expect(penaltiesAfter).toBe(penaltiesBefore);
  });

  it('DEVICE_LOAN: paying off the full loan amount does not forgive interest already accrued at that point', async () => {
    const custId = await makeCustomer('LoanPartial');
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'DEVICE_LOAN', customerId: custId, loanAmountMinor: 50000 },
    }));
    const contract = (await created.json()).contract;

    await prisma.penalty.create({
      data: { contractId: contract.id, amountMinor: 500, reason: 'DAILY_LOAN_INTEREST', appliedDate: new Date() },
    });

    const payPrincipal = await deviceLoanPaymentsPOST(makeRequest('POST', '/api/payments/device-loan', {
      token: cashier, body: { contractId: contract.id, amountMinor: 50000, option: 'PRINCIPAL' },
    }));
    expect(payPrincipal.status).toBe(201);

    const detail = await getContract(contract.id, cashier);
    expect(detail.deviceLoanState.principalOutstanding).toBe(false);
    expect(detail.deviceLoanState.accruedInterestMinor).toBe(500); // still owed, not forgiven
    expect(detail.status).toBe('ACTIVE'); // not COMPLETED — interest still unpaid

    const payInterest = await deviceLoanPaymentsPOST(makeRequest('POST', '/api/payments/device-loan', {
      token: cashier, body: { contractId: contract.id, amountMinor: 500, option: 'INTEREST' },
    }));
    expect(payInterest.status).toBe(201);
    expect((await getContract(contract.id, cashier)).status).toBe('COMPLETED');
  });

  it('Overpayment is accepted and flagged as credit, not rejected', async () => {
    const custId = await makeCustomer('Overpay');
    const itemId = await receiveItem('OVP');
    const created = await makeDepositInstalment(cashier, custId, itemId, { totalPayableMinor: 240000, depositAmountMinor: 0 });
    const contract = (await created.json()).contract;
    expect(contract.status).toBe('PENDING_DEPOSIT'); // every DEPOSIT_INSTALMENT starts here, even at 0% deposit
    expect(contract.totalPayableMinor).toBe(240000);

    // 0% deposit — any payment at all (even a token amount) clears the gate and
    // activates the contract; it deliberately doesn't also check for completion
    // in that same pass (advanceContractStatus), so a second payment does that part.
    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 1, entryType: 'DEPOSIT' },
    }));
    const active = await getContract(contract.id, cashier);
    expect(active.status).toBe('ACTIVE');

    const over = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 250000, entryType: 'INSTALMENT_PAYMENT' },
    }));
    expect(over.status).toBe(201);

    const detail = await getContract(contract.id, cashier);
    expect(detail.status).toBe('COMPLETED');
    expect(detail.totalPaidMinor).toBe(250001); // the 1-pesewa deposit plus the overpayment
    expect(detail.creditMinor).toBe(10001);
  });

  it('RBAC: SALES cannot record cash payments (403), CASHIER can', async () => {
    // SAVE_TO_OWN needs no product/price chart entry at all — the simplest
    // vehicle for a test that's only about the permission check.
    const custId = await makeCustomer('RbacCheck');
    const created = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType: 'SAVE_TO_OWN', customerId: custId },
    }));
    const contract = (await created.json()).contract;

    const forbidden = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: sales, body: { contractId: contract.id, amountMinor: 100, entryType: 'INSTALMENT_PAYMENT' },
    }));
    expect(forbidden.status).toBe(403);

    const allowed = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 100, entryType: 'INSTALMENT_PAYMENT' },
    }));
    expect(allowed.status).toBe(201);
  });
});
