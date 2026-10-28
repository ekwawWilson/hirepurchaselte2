/**
 * The PayTrigger lock decision (src/lib/paytrigger/decide.ts), one fixture
 * per rule. Pure: no database, no network, and `now` pinned.
 */
import { describe, it, expect } from 'vitest';
import { decide, lockMomentAfter, type DecisionInput } from '@/lib/paytrigger/decide';

const NOW = new Date('2026-10-28T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const day = (offset: number) => new Date(Date.UTC(2026, 9, 28 + offset));

/** GHS 600 phone, GHS 120 deposit paid, four weekly GHS 120 instalments; the first due in three days. */
function input(overrides: { contract?: Partial<DecisionInput['contract']>; device?: Partial<DecisionInput['device']>; agentDeposit?: DecisionInput['agentDeposit']; settings?: Partial<DecisionInput['settings']> } = {}): DecisionInput {
  return {
    now: NOW,
    contract: {
      status: 'ACTIVE',
      gracePeriodDays: 7,
      totalPayableMinor: 60000,
      totalPaidMinor: 12000,
      instalments: [3, 10, 17, 24].map((offset, i) => ({ instalmentNo: i + 1, dueDate: day(offset), amountDueMinor: 12000, amountPaidMinor: 0, status: 'PENDING' })),
      ...overrides.contract,
    },
    agentDeposit: overrides.agentDeposit ?? null,
    device: { activated: true, providerExpiresAt: new Date(NOW.getTime() + 5 * DAY), ...overrides.device },
    settings: { lockAfterOverdueDays: 1, maxUnlockHorizonDays: 45, ...overrides.settings },
  };
}

describe('PayTrigger lock decision', () => {
  it('locks at 08:30 (Ghana, UTC) on the day after the grace period ends', () => {
    expect(lockMomentAfter(new Date('2026-11-02T00:00:00Z'), 8).toISOString()).toBe('2026-11-10T08:30:00.000Z');
  });

  it('an active contract with nothing overdue opens the phone until the next instalment\'s grace period has run out', () => {
    const d = decide(input());
    expect(d.action).toBe('EXTEND');
    // Due 31 Oct, 7 days' grace, locks the day after: 8 Nov 08:30.
    expect(d.nextRepayTime?.toISOString()).toBe('2026-11-08T08:30:00.000Z');
    expect(d.lockNow).toBe(false);
    expect(d.amounts).toEqual({ repayedAmt: '120.00', totalAmt: '600.00', nextRepayAmt: '120.00', currentTerm: 1, totalTerm: 4 });
  });

  it('a part-paid instalment is still the next one, with what is left of it', () => {
    const d = decide(input({ contract: { instalments: [{ instalmentNo: 1, dueDate: day(3), amountDueMinor: 12000, amountPaidMinor: 5000, status: 'PARTIAL' }, { instalmentNo: 2, dueDate: day(10), amountDueMinor: 12000, amountPaidMinor: 0, status: 'PENDING' }] } }));
    expect(d.amounts?.nextRepayAmt).toBe('70.00');
    expect(d.amounts?.currentTerm).toBe(1);
  });

  it('an instalment unpaid past its grace period locks an open phone a minute from now', () => {
    const d = decide(input({ contract: { instalments: [{ instalmentNo: 1, dueDate: day(-9), amountDueMinor: 12000, amountPaidMinor: 0, status: 'OVERDUE' }] } }));
    expect(d.action).toBe('LOCK');
    expect(d.lockNow).toBe(true);
    expect(d.nextRepayTime?.getTime()).toBe(NOW.getTime() + 60_000);
  });

  it('a phone already past its lock date is not sent anything: it has locked itself', () => {
    const d = decide(input({
      contract: { instalments: [{ instalmentNo: 1, dueDate: day(-9), amountDueMinor: 12000, amountPaidMinor: 0, status: 'OVERDUE' }] },
      device: { providerExpiresAt: new Date(NOW.getTime() - DAY) },
    }));
    expect(d.action).toBe('LOCK');
    expect(d.nextRepayTime).toBeNull();
  });

  it('within the grace period the phone stays open', () => {
    const d = decide(input({ contract: { instalments: [{ instalmentNo: 1, dueDate: day(-3), amountDueMinor: 12000, amountPaidMinor: 0, status: 'OVERDUE' }] } }));
    expect(d.action).toBe('EXTEND');
    expect(d.nextRepayTime?.toISOString()).toBe('2026-11-02T08:30:00.000Z');
  });

  it('never opens a phone more than the cap ahead', () => {
    const d = decide(input({ contract: { instalments: [{ instalmentNo: 1, dueDate: day(90), amountDueMinor: 12000, amountPaidMinor: 0, status: 'PENDING' }] }, device: { providerExpiresAt: null } }));
    expect(d.nextRepayTime?.getTime()).toBe(NOW.getTime() + 45 * DAY);
  });

  it('horizon stability: a phone already holding a date near the cap keeps it, so it is not re-told on every event', () => {
    const held = new Date(NOW.getTime() + 42 * DAY);
    const d = decide(input({ contract: { instalments: [{ instalmentNo: 1, dueDate: day(90), amountDueMinor: 12000, amountPaidMinor: 0, status: 'PENDING' }] }, device: { providerExpiresAt: held } }));
    expect(d.nextRepayTime).toEqual(held);
    // ...and the fingerprint is the same a second later, so nothing is resent.
    const later = decide({ ...input({ contract: { instalments: [{ instalmentNo: 1, dueDate: day(90), amountDueMinor: 12000, amountPaidMinor: 0, status: 'PENDING' }] }, device: { providerExpiresAt: held } }), now: new Date(NOW.getTime() + 1000) });
    expect(later.fingerprint).toBe(d.fingerprint);
  });

  it('an agent\'s unremitted deposit holds the phone locked, even with nothing overdue', () => {
    const d = decide(input({ agentDeposit: { owedMinor: 12000 } }));
    expect(d.action).toBe('HOLD');
    expect(d.depositHold).toBe(true);
    expect(d.lockNow).toBe(true);
    expect(d.reason).toMatch(/GHS 120\.00/);
  });

  it('no ledger row yet on an agent\'s contract holds it too (fail closed)', () => {
    expect(decide(input({ agentDeposit: { owedMinor: null } })).action).toBe('HOLD');
  });

  it('a remitted deposit, or the office owing the agent, lets the phone open', () => {
    expect(decide(input({ agentDeposit: { owedMinor: 0 } })).action).toBe('EXTEND');
    expect(decide(input({ agentDeposit: { owedMinor: -2000 } })).action).toBe('EXTEND');
  });

  it('a paid-off contract releases the lock (after the hold period)', () => {
    expect(decide(input({ contract: { status: 'COMPLETED' } })).action).toBe('RELEASE');
  });

  it('a contract cancelled before the phone was switched on leaves it enrolled, back in stock', () => {
    expect(decide(input({ contract: { status: 'CANCELLED' }, device: { activated: false, providerExpiresAt: null } })).action).toBe('NONE');
  });

  it('a contract cancelled after switch-on locks an open phone like unsold stock', () => {
    const d = decide(input({ contract: { status: 'CANCELLED' } }));
    expect(d.action).toBe('LOCK');
    expect(d.lockNow).toBe(true);
  });

  it('a defaulted contract is never extended: an open phone is locked, a locked one left alone', () => {
    expect(decide(input({ contract: { status: 'DEFAULTED' } })).action).toBe('LOCK');
    expect(decide(input({ contract: { status: 'DEFAULTED' }, device: { providerExpiresAt: new Date(NOW.getTime() - DAY) } })).action).toBe('NONE');
  });

  it('a deposit not yet paid keeps a phone switched on early locked', () => {
    expect(decide(input({ contract: { status: 'PENDING_DEPOSIT' } })).action).toBe('LOCK');
  });

  it('a reversal that un-completes a contract turns a release back into a lock date', () => {
    expect(decide(input({ contract: { status: 'COMPLETED' } })).action).toBe('RELEASE');
    expect(decide(input({ contract: { status: 'ACTIVE' } })).action).toBe('EXTEND');
  });

  it('every instalment paid keeps the phone open while the contract completes', () => {
    const paid = [1, 2].map((n) => ({ instalmentNo: n, dueDate: day(n), amountDueMinor: 12000, amountPaidMinor: 12000, status: 'PAID' }));
    const d = decide(input({ contract: { instalments: paid }, device: { providerExpiresAt: null } }));
    expect(d.action).toBe('EXTEND');
    expect(d.nextRepayTime?.getTime()).toBe(NOW.getTime() + 45 * DAY);
  });

  it('the fingerprint follows the intent, not the moving clock: a locked phone is not re-told every event', () => {
    const overdue = { instalments: [{ instalmentNo: 1, dueDate: day(-9), amountDueMinor: 12000, amountPaidMinor: 0, status: 'OVERDUE' }] };
    const a = decide(input({ contract: overdue }));
    const b = decide({ ...input({ contract: overdue }), now: new Date(NOW.getTime() + 5 * 60_000) });
    expect(b.fingerprint).toBe(a.fingerprint);
  });
});
