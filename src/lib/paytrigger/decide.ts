import { createHash } from 'crypto';

/**
 * What a Device Financing phone's lock should be doing, from the contract
 * alone. Pure: no database, no network, and no clock except the `now` passed
 * in, so every rule is pinned by fixtures (tests/paytrigger-decide.test.ts).
 *
 * PayTrigger is lock-date driven: each phone holds a date and locks itself
 * once it passes, online or offline. There is no "lock" call. Opening a
 * phone means pushing its date into the future; locking it means pushing a
 * date a minute from now; and PayTrigger refuses dates in the past.
 */

export type LockAction = 'EXTEND' | 'HOLD' | 'LOCK' | 'RELEASE' | 'NONE';

export interface DecisionInput {
  now: Date;
  contract: {
    status: string;
    gracePeriodDays: number;
    totalPayableMinor: number | null;
    totalPaidMinor: number;
    instalments: Array<{ instalmentNo: number; dueDate: Date; amountDueMinor: number; amountPaidMinor: number; status: string }>;
  };
  /**
   * Set when the contract is an agent's and deposit holds are on: what the
   * agent still owes the office on it (agentLedgerService.ledgerBalance), or
   * null when no ledger row exists yet, which holds the phone too (fail closed).
   */
  agentDeposit: { owedMinor: number | null } | null;
  device: { activated: boolean; providerExpiresAt: Date | null };
  settings: { lockAfterOverdueDays: number; maxUnlockHorizonDays: number };
}

export interface LockAmounts {
  repayedAmt: string;
  totalAmt: string;
  nextRepayAmt: string;
  currentTerm: number;
  totalTerm: number;
}

export interface Decision {
  action: LockAction;
  reason: string;
  /** The lock date to send; null when nothing is to be sent (a phone already past its date locks itself). */
  nextRepayTime: Date | null;
  /** The date pushed is "now + 1 minute", to lock an open phone. */
  lockNow: boolean;
  /** The lock date the contract implies, for staff to read. */
  scheduleExpiresAt: Date | null;
  depositHold: boolean;
  amounts: LockAmounts | null;
  /** The next unpaid instalment, for the lock-screen text. */
  next: { instalmentNo: number; dueDate: Date; remainingMinor: number } | null;
  fingerprint: string;
}

/** Ghana keeps UTC all year: the lock moment is 08:30 there, after the 08:00 overdue sweep. */
const LOCK_HOUR_UTC = 8;
const LOCK_MINUTE_UTC = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOCK_NOW_MS = 60_000;
/** A held date this close to "now + cap" is kept, so every event does not resend a slightly later one. */
const HORIZON_STABILITY_MS = 7 * DAY_MS;

/** 08:30 on the day `days` after a due date. */
export function lockMomentAfter(dueDate: Date, days: number): Date {
  return new Date(Date.UTC(dueDate.getUTCFullYear(), dueDate.getUTCMonth(), dueDate.getUTCDate() + days, LOCK_HOUR_UTC, LOCK_MINUTE_UTC));
}

const cedis = (minor: number) => (minor / 100).toFixed(2);

function fingerprintOf(parts: { action: LockAction; target: string | null; hold: boolean; amounts: LockAmounts | null }): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function decide(input: DecisionInput): Decision {
  const { now, contract, device, settings } = input;
  const isOpen = device.activated && !!device.providerExpiresAt && device.providerExpiresAt.getTime() > now.getTime();

  const instalments = [...contract.instalments].sort((a, b) => a.instalmentNo - b.instalmentNo);
  const nextUnpaid = instalments.find((i) => i.status !== 'PAID' && i.amountPaidMinor < i.amountDueMinor) ?? null;
  const next = nextUnpaid
    ? { instalmentNo: nextUnpaid.instalmentNo, dueDate: nextUnpaid.dueDate, remainingMinor: nextUnpaid.amountDueMinor - nextUnpaid.amountPaidMinor }
    : null;
  const amounts: LockAmounts | null = instalments.length > 0
    ? {
      repayedAmt: cedis(contract.totalPaidMinor),
      totalAmt: cedis(contract.totalPayableMinor ?? contract.totalPaidMinor),
      nextRepayAmt: cedis(next?.remainingMinor ?? 0),
      currentTerm: Math.min(1000, next?.instalmentNo ?? instalments.length),
      totalTerm: Math.min(1000, instalments.length),
    }
    : null;

  const result = (action: LockAction, reason: string, nextRepayTime: Date | null, extra: Partial<Decision> = {}): Decision => {
    const lockNow = extra.lockNow ?? false;
    const depositHold = extra.depositHold ?? false;
    return {
      action, reason, nextRepayTime, lockNow, depositHold, amounts, next,
      scheduleExpiresAt: extra.scheduleExpiresAt ?? null,
      fingerprint: fingerprintOf({ action, target: lockNow ? 'NOW' : nextRepayTime?.toISOString() ?? null, hold: depositHold, amounts }),
    };
  };
  // Lock now: a minute from now, and only if the phone is open. One already
  // past its date has locked itself, so nothing is sent.
  const lockNow = (action: LockAction, reason: string, extra: Partial<Decision> = {}) => isOpen
    ? result(action, reason, new Date(now.getTime() + LOCK_NOW_MS), { ...extra, lockNow: true })
    : result(action, `${reason} (the phone is already past its lock date)`, null, { ...extra, lockNow: true });

  switch (contract.status) {
    case 'COMPLETED':
      return result('RELEASE', 'Paid in full: the lock is removed after the hold period', null);
    case 'CANCELLED':
      // Never switched on, so no licence was spent: the phone goes back to
      // stock still enrolled, ready for the next Device Financing sale.
      if (!device.activated) return result('NONE', 'Contract cancelled before the phone was switched on: it returns to stock still enrolled', null);
      return isOpen ? lockNow('LOCK', 'Contract cancelled: the phone is locked like unsold stock') : result('NONE', 'Contract cancelled; the phone is already locked', null);
    case 'DEFAULTED':
    case 'WRITTEN_OFF':
      // Never extended again; a payment that cures a default makes it ACTIVE first.
      return isOpen ? lockNow('LOCK', `Contract ${contract.status.toLowerCase().replace('_', ' ')}: the lock date is never extended`) : result('NONE', `Contract ${contract.status.toLowerCase().replace('_', ' ')}; the phone stays locked`, null);
    case 'ACTIVE':
      break;
    default:
      // Awaiting approval or the deposit: the phone should still be in the shop.
      // One switched on early locked itself on activation and stays that way.
      return isOpen ? lockNow('LOCK', 'The deposit is not paid yet') : result('NONE', 'The deposit is not paid yet; the phone stays locked', null);
  }

  const horizon = new Date(now.getTime() + settings.maxUnlockHorizonDays * DAY_MS);
  const schedule = next
    ? lockMomentAfter(next.dueDate, contract.gracePeriodDays + settings.lockAfterOverdueDays)
    : horizon;

  if (input.agentDeposit && (input.agentDeposit.owedMinor === null || input.agentDeposit.owedMinor > 0)) {
    const why = input.agentDeposit.owedMinor === null
      ? 'No agent ledger entry yet for this agent\'s contract: held locked until it exists'
      : `The agent has not yet remitted GHS ${cedis(input.agentDeposit.owedMinor)} collected on this contract`;
    return isOpen
      ? lockNow('HOLD', why, { depositHold: true, scheduleExpiresAt: schedule })
      : result('HOLD', why, null, { depositHold: true, scheduleExpiresAt: schedule, lockNow: true });
  }

  if (schedule.getTime() <= now.getTime() + LOCK_NOW_MS) {
    return lockNow('LOCK', `Instalment ${next!.instalmentNo} is unpaid past the grace period`, { scheduleExpiresAt: schedule });
  }

  // Never more than the cap ahead, so a mistake can never open a phone for long.
  let target = schedule.getTime() > horizon.getTime() ? horizon : schedule;
  // Horizon stability: "now + cap" moves every second. A phone already holding
  // a date near it keeps that date rather than being re-told on every event.
  const held = device.providerExpiresAt;
  if (schedule.getTime() > horizon.getTime() && held && held.getTime() > now.getTime() && held.getTime() >= horizon.getTime() - HORIZON_STABILITY_MS) {
    target = held;
  }
  const reason = next
    ? `Open until ${target.toISOString().slice(0, 16).replace('T', ' ')} UTC: instalment ${next.instalmentNo} is due ${next.dueDate.toISOString().slice(0, 10)}`
    : 'Every instalment is paid: kept open while the contract completes';
  return result('EXTEND', reason, target, { scheduleExpiresAt: schedule });
}
