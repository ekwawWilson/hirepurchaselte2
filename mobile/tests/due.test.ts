/**
 * The Pay screen's arithmetic (src/lib/due.ts): quick amounts, limits, and
 * what a payment covers, in the order the server applies money. Run with
 * `npm test` (Node's own test runner; no app or network needed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  amountProblem, coverageText, defaultAmount, formatMoney, isPayable, networkForPhone, normalisePhone, parseAmount, quickAmounts,
} from '../src/lib/due.ts';
import type { Contract, Instalment } from '../src/lib/types.ts';

const MIN = 100;
const MAX_SAVINGS = 2_000_000;

function contract(overrides: Partial<Contract> & { due?: Partial<Contract['due']> } = {}): Contract {
  const { due, ...rest } = overrides;
  return {
    id: 'c1', contractNumber: 'FP-CON-1', contractType: 'DEVICE_FINANCING', status: 'ACTIVE',
    totalPayableMinor: 60000, totalPaidMinor: 24000, balanceMinor: 36000, depositAmountMinor: 12000, instalmentAmountMinor: 4000,
    paymentFrequency: 'WEEKLY', termWeeks: 12, gracePeriodDays: 7, penaltyRateBps: 500, startDate: '2026-10-01T00:00:00Z',
    product: { name: 'TECNO Spark 30' }, deviceLoanState: null,
    ...rest,
    due: { totalDueMinor: 36500, penaltyOutstandingMinor: 500, overdueMinor: 8000, overdueCount: 2, nextDueMinor: 4000, nextDueDate: '2026-11-05T00:00:00Z', unpaidCount: 9, ...due },
  };
}

const instalment = (n: number, due: string, paid = 0): Instalment => ({
  id: `i${n}`, instalmentNo: n, dueDate: due, amountDueMinor: 4000, amountPaidMinor: paid, status: paid >= 4000 ? 'PAID' : paid > 0 ? 'PARTIAL' : 'PENDING', paidAt: null,
});
const schedule = [instalment(1, '2026-10-15T00:00:00Z', 4000), instalment(2, '2026-10-22T00:00:00Z'), instalment(3, '2026-10-29T00:00:00Z'), instalment(4, '2026-11-05T00:00:00Z')];

test('quick amounts: what is overdue (with late charges), overdue plus the next, then everything', () => {
  assert.deepEqual(quickAmounts(contract()), [
    { label: 'Overdue', amountMinor: 8500 },
    { label: 'Overdue + next', amountMinor: 12500 },
    { label: 'Pay all', amountMinor: 36500 },
  ]);
  assert.equal(defaultAmount(contract()), 8500);
});

test('quick amounts never go above what is owed, and say "late charges" when that is all that is due', () => {
  const onlyCharges = contract({ due: { overdueMinor: 0, overdueCount: 0, totalDueMinor: 4500, nextDueMinor: 4000 } });
  assert.deepEqual(quickAmounts(onlyCharges), [
    { label: 'Late charges', amountMinor: 500 },
    { label: 'Overdue + next', amountMinor: 4500 },
  ]);
  const nothingLate = contract({ due: { overdueMinor: 0, overdueCount: 0, penaltyOutstandingMinor: 0, totalDueMinor: 36000 } });
  assert.equal(quickAmounts(nothingLate)[0].label, 'Next payment');
});

test('a sale awaiting its deposit offers the deposit first', () => {
  const pending = contract({ status: 'PENDING_DEPOSIT', totalPaidMinor: 2000, due: { overdueMinor: 0, overdueCount: 0, penaltyOutstandingMinor: 0, totalDueMinor: 58000 } });
  assert.deepEqual(quickAmounts(pending)[0], { label: 'Deposit', amountMinor: 10000 });
  assert.equal(coverageText(pending, schedule, 14000), 'Covers your deposit, 1 instalment (to 22 Oct)');
});

test('a device loan takes exactly the interest or the full loan, nothing else', () => {
  const loan = contract({ contractType: 'DEVICE_LOAN', totalPayableMinor: null, deviceLoanState: { principalMinor: 100000, principalOutstanding: true, accruedInterestMinor: 3000, interestPaidMinor: 0, totalOwedMinor: 103000 }, due: { totalDueMinor: 103000 } });
  assert.deepEqual(quickAmounts(loan), [{ label: 'Interest owed', amountMinor: 3000 }, { label: 'Full loan', amountMinor: 100000 }]);
  assert.equal(amountProblem(loan, 3000, MIN, MAX_SAVINGS), null);
  assert.match(amountProblem(loan, 5000, MIN, MAX_SAVINGS)!, /interest owed or the full loan/);
});

test('savings take any amount from the minimum to the largest single payment', () => {
  const savings = contract({ contractType: 'SAVE_TO_OWN', totalPayableMinor: null, due: { totalDueMinor: null } });
  assert.equal(isPayable(savings), true);
  assert.deepEqual(quickAmounts(savings), []);
  assert.equal(amountProblem(savings, 50, MIN, MAX_SAVINGS), 'The smallest payment is GH₵ 1.00');
  assert.equal(amountProblem(savings, 500000, MIN, MAX_SAVINGS), null);
  assert.match(amountProblem(savings, 2_500_000, MIN, MAX_SAVINGS)!, /at most GH₵ 20,000.00/);
  assert.equal(coverageText(savings, null, 5000), 'Added to your savings');
});

test('more than is owed is refused before the server is asked', () => {
  assert.equal(amountProblem(contract(), 36600, MIN, MAX_SAVINGS), 'More than you owe (GH₵ 365.00)');
  assert.equal(amountProblem(contract(), 36500, MIN, MAX_SAVINGS), null);
});

test('coverage follows the server: late charges first, then instalments oldest first', () => {
  assert.equal(coverageText(contract(), schedule, 8500), 'Covers late charges, 2 instalments (to 29 Oct)');
  assert.equal(coverageText(contract(), schedule, 10500), 'Covers late charges, 2 instalments (to 29 Oct), part of the next');
  assert.equal(coverageText(contract(), schedule, 2500), 'Covers late charges, part of your next instalment');
  // Late charges are paid whole or not at all: less than them is never promised to cover them.
  assert.equal(coverageText(contract(), schedule, 300), 'Goes to your late charges first');
});

test('a closed contract or one with nothing owed is not payable', () => {
  assert.equal(isPayable(contract({ status: 'COMPLETED' })), false);
  assert.equal(isPayable(contract({ due: { totalDueMinor: 0 } })), false);
  assert.equal(isPayable(contract({ status: 'DEFAULTED' })), true);
});

test('the network is guessed from the number, written any way', () => {
  assert.equal(networkForPhone('0244123456'), 'MTN');
  assert.equal(networkForPhone('+233 50 123 4567'), 'TELECEL');
  assert.equal(networkForPhone('233271234567'), 'AIRTELTIGO');
  assert.equal(networkForPhone('0314123456'), null);
  assert.equal(normalisePhone('233244123456'), '0244123456');
});

test('money in and out', () => {
  assert.equal(formatMoney(123450), 'GH₵ 1,234.50');
  assert.equal(parseAmount('1,200.5'), 120050);
  assert.ok(Number.isNaN(parseAmount('50abc')));
  assert.ok(Number.isNaN(parseAmount('0.001')));
});
