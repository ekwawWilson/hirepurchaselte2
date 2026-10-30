import type { Contract, Instalment } from './types';

/**
 * What a customer owes and what a payment will do: the figures behind Home,
 * Contracts, the contract page and Pay. Pure (no network, no clock but the
 * `today` passed in) so tests/due.test.ts can pin them. The amounts
 * themselves come from the server (Contract.due); these only arrange them.
 * The server checks every payment again, whatever is shown here.
 */

/** Statuses a payment is taken on (the server refuses closed and unapproved contracts). */
const PAYABLE_STATUSES = ['ACTIVE', 'PENDING_DEPOSIT', 'DEFAULTED'];

export const isSavings = (c: Pick<Contract, 'contractType'>) => c.contractType === 'SAVE_TO_OWN';
export const isLoan = (c: Pick<Contract, 'contractType'>) => c.contractType === 'DEVICE_LOAN';

export function isPayable(c: Contract): boolean {
  if (!PAYABLE_STATUSES.includes(c.status)) return false;
  if (isSavings(c)) return true;
  return (c.due.totalDueMinor ?? 0) > 0;
}

/** Owed now: overdue instalments plus late charges. */
export function dueNowMinor(c: Contract): number {
  return c.due.overdueMinor + c.due.penaltyOutstandingMinor;
}

/** Share paid, 0 to 1, or null where there is no total to measure against (savings, loans). */
export function progress(c: Contract): number | null {
  if (!c.totalPayableMinor || c.totalPayableMinor <= 0) return null;
  return Math.min(1, c.totalPaidMinor / c.totalPayableMinor);
}

/** The deposit still owed on a sale waiting for it. */
export function depositLeftMinor(c: Contract): number {
  return c.status === 'PENDING_DEPOSIT' ? Math.max(0, c.depositAmountMinor - c.totalPaidMinor) : 0;
}

export interface QuickAmount {
  label: string;
  amountMinor: number;
}

/**
 * The one-tap amounts on the Pay screen, never more than is owed. A device
 * loan takes exactly one of two amounts, so those are its only choices.
 * Savings have none: the customer types what they want to save.
 */
export function quickAmounts(c: Contract): QuickAmount[] {
  if (isSavings(c)) return [];
  if (isLoan(c)) {
    const s = c.deviceLoanState;
    if (!s) return [];
    return [
      ...(s.accruedInterestMinor > 0 ? [{ label: 'Interest owed', amountMinor: s.accruedInterestMinor }] : []),
      ...(s.principalOutstanding ? [{ label: 'Full loan', amountMinor: s.principalMinor }] : []),
    ];
  }
  const total = c.due.totalDueMinor ?? 0;
  const out: QuickAmount[] = [];
  const deposit = depositLeftMinor(c);
  if (deposit > 0) out.push({ label: 'Deposit', amountMinor: Math.min(deposit, total) });
  const now = dueNowMinor(c);
  if (now > 0) out.push({ label: c.due.overdueMinor > 0 ? 'Overdue' : 'Late charges', amountMinor: Math.min(now, total) });
  if (c.due.nextDueMinor > 0) {
    out.push({ label: now > 0 ? 'Overdue + next' : 'Next payment', amountMinor: Math.min(now + c.due.nextDueMinor, total) });
  }
  if (total > 0 && !out.some((q) => q.amountMinor === total)) out.push({ label: 'Pay all', amountMinor: total });
  // The same amount twice says nothing new.
  return out.filter((q, i) => q.amountMinor > 0 && out.findIndex((o) => o.amountMinor === q.amountMinor) === i);
}

/** The chip chosen when the Pay screen opens: what is due now, else the next payment. */
export function defaultAmount(c: Contract): number | null {
  const chips = quickAmounts(c);
  return chips.length > 0 ? chips[0].amountMinor : null;
}

/** Why `amountMinor` can't be paid on this contract, or null. The server checks the same again. */
export function amountProblem(c: Contract, amountMinor: number, minMinor: number, maxSavingsMinor: number): string | null {
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return 'Enter an amount';
  if (amountMinor < minMinor) return `The smallest payment is ${formatMoney(minMinor)}`;
  if (isSavings(c)) return amountMinor > maxSavingsMinor ? `One payment can be at most ${formatMoney(maxSavingsMinor)}` : null;
  if (isLoan(c) && !quickAmounts(c).some((q) => q.amountMinor === amountMinor)) return 'A loan is paid as the interest owed or the full loan amount';
  const total = c.due.totalDueMinor ?? 0;
  return amountMinor > total ? `More than you owe (${formatMoney(total)})` : null;
}

const shortDate = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * What a typed amount pays off, in the order the server applies it
 * (paymentService.allocatePayment): the deposit while it is owed, then
 * overdue instalments oldest first, then late charges, then instalments not
 * yet due. A late charge is paid whole or not at all: an amount too small
 * for it carries on to the upcoming instalments instead. `instalments` is
 * the contract's schedule (the contract page loads it); `today` is the start
 * of today (UTC), passed in to keep this pure.
 */
export function coverageText(c: Contract, instalments: Instalment[] | null, amountMinor: number, today: Date = startOfTodayUtc()): string | null {
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) return null;
  if (isSavings(c)) return 'Added to your savings';
  if (isLoan(c)) {
    const s = c.deviceLoanState;
    if (s && amountMinor === s.accruedInterestMinor) return 'Pays the interest owed so far';
    if (s && amountMinor === s.principalMinor) return 'Pays off the loan amount';
    return null;
  }
  let left = amountMinor;
  const parts: string[] = [];
  const deposit = depositLeftMinor(c);
  if (deposit > 0) {
    parts.push(left >= deposit ? 'your deposit' : 'part of your deposit');
    left -= Math.min(left, deposit);
  }
  if (!instalments) {
    if (left > 0) parts.push('overdue instalments first, then late charges and upcoming instalments');
    return parts.length ? `Covers ${parts.join(', ')}` : null;
  }
  const unpaid = instalments
    .filter((i) => i.status !== 'PAID' && i.amountDueMinor - i.amountPaidMinor > 0)
    .sort((a, b) => a.instalmentNo - b.instalmentNo);
  const isLate = (i: Instalment) => i.status === 'OVERDUE' || new Date(i.dueDate) < today;
  const pay = (rows: Instalment[], what: string) => {
    let whole = 0;
    let lastDue: string | null = null;
    let partial = false;
    for (const i of rows) {
      if (left <= 0) break;
      const owed = i.amountDueMinor - i.amountPaidMinor;
      if (left >= owed) {
        whole += 1;
        lastDue = i.dueDate;
        left -= owed;
      } else {
        partial = true;
        left = 0;
      }
    }
    if (whole > 0) parts.push(`${whole} ${what}instalment${whole === 1 ? '' : 's'} (to ${shortDate(lastDue!)})`);
    if (partial) parts.push(whole > 0 ? 'part of the next' : `part of your next ${what}instalment`);
  };
  pay(unpaid.filter(isLate), 'overdue ');
  const charges = c.due.penaltyOutstandingMinor;
  if (left > 0 && charges > 0 && left >= charges) {
    parts.push('late charges');
    left -= charges;
  }
  pay(unpaid.filter((i) => !isLate(i)), '');
  return parts.length ? `Covers ${parts.join(', ')}` : null;
}

function startOfTodayUtc(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** The network a Ghana number is on, from its prefix (for preselecting the chip). */
export function networkForPhone(phone: string | null | undefined): 'MTN' | 'TELECEL' | 'AIRTELTIGO' | null {
  const local = normalisePhone(phone);
  if (!local) return null;
  const prefix = local.slice(0, 3);
  if (['024', '025', '053', '054', '055', '059'].includes(prefix)) return 'MTN';
  if (['020', '050'].includes(prefix)) return 'TELECEL';
  if (['026', '027', '056', '057'].includes(prefix)) return 'AIRTELTIGO';
  return null;
}

/** 0XXXXXXXXX from 233XXXXXXXXX / +233… / spaces; null if it isn't a 10-digit Ghana number. */
export function normalisePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[\s\-()]/g, '').replace(/^\+/, '');
  const local = digits.startsWith('233') && digits.length === 12 ? `0${digits.slice(3)}` : digits;
  return /^0\d{9}$/.test(local) ? local : null;
}

/** GH₵ 1,234.50 from pesewas. */
export function formatMoney(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const [whole, fraction] = (Math.abs(minor) / 100).toFixed(2).split('.');
  return `${sign}GH₵ ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`;
}

/** Pesewas from what the customer typed ("50", "50.5", "1,200"), or NaN unless it is plainly an amount. */
export function parseAmount(text: string): number {
  const clean = text.replace(/,/g, '').trim();
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(clean)) return NaN;
  return Math.round(parseFloat(clean) * 100);
}
