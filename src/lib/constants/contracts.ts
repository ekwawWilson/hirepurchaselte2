export const CONTRACT_TYPES = ['SAVE_TO_OWN', 'DEPOSIT_INSTALMENT', 'DEVICE_LOAN'] as const;
export type ContractTypeName = (typeof CONTRACT_TYPES)[number];

/** All three contract types collect payments on one of these cadences (mission requirement). */
export const PAYMENT_FREQUENCIES = ['DAILY', 'WEEKLY', 'MONTHLY'] as const;
export type PaymentFrequencyName = (typeof PAYMENT_FREQUENCIES)[number];

/**
 * Fixed convention (not calendar-accurate) for translating an admin-entered
 * "term in months" into a number of instalments at a given cadence: 30
 * days/month, 4 weeks/month. Chosen for staff-legibility over calendar
 * precision — a 6-month term is always 180 daily or 24 weekly instalments,
 * never a number that shifts with which actual months it spans.
 */
const PERIODS_PER_MONTH: Record<PaymentFrequencyName, number> = { DAILY: 30, WEEKLY: 4, MONTHLY: 1 };

export function numberOfInstalmentsForTerm(termMonths: number, paymentFrequency: PaymentFrequencyName): number {
  return termMonths * PERIODS_PER_MONTH[paymentFrequency];
}

/** No further payments/status changes accepted once a contract reaches one of these. */
export const TERMINAL_CONTRACT_STATUSES = ['COMPLETED', 'RELEASED', 'CANCELLED', 'WRITTEN_OFF'];

/** docs/01-plan.md §5 — the allowed status per contract type. */
export const CONTRACT_STATUSES_BY_TYPE: Record<ContractTypeName, string[]> = {
  SAVE_TO_OWN: ['ACTIVE', 'COMPLETED', 'RELEASED', 'CANCELLED'],
  DEPOSIT_INSTALMENT: ['PENDING_DEPOSIT', 'ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED'],
  DEVICE_LOAN: ['ACTIVE', 'COMPLETED', 'DEFAULTED', 'WRITTEN_OFF'],
};
