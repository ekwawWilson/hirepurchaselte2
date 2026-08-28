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

/**
 * The only term lengths an admin can price a product at — matches the legacy
 * hirepurchase app's ProductPricing model exactly (it only ever offers 3, 4, or
 * 6 month tiers). Enforced in priceChartService.validateEntryBody, i.e. at the
 * admin-entry point, not as a DB constraint.
 */
export const PRICE_CHART_TERM_MONTHS = [3, 4, 6] as const;

/** No further payments/status changes accepted once a contract reaches one of these. */
export const TERMINAL_CONTRACT_STATUSES = ['COMPLETED', 'RELEASED', 'CANCELLED', 'WRITTEN_OFF'];

/** docs/01-plan.md §5 — the allowed status per contract type. */
export const CONTRACT_STATUSES_BY_TYPE: Record<ContractTypeName, string[]> = {
  SAVE_TO_OWN: ['ACTIVE', 'COMPLETED', 'RELEASED', 'CANCELLED'],
  DEPOSIT_INSTALMENT: ['PENDING_DEPOSIT', 'ACTIVE', 'COMPLETED', 'DEFAULTED', 'CANCELLED'],
  DEVICE_LOAN: ['ACTIVE', 'COMPLETED', 'DEFAULTED', 'WRITTEN_OFF'],
};

/**
 * Direct debit (a Hubtel mandate the customer approves once, then the merchant
 * auto-charges going forward — see hubtelPreapprovalService.ts) only makes sense
 * against a contract with an actual due schedule to collect on. SAVE_TO_OWN is
 * free-form savings with no due dates at all (contractService.ts), so it's the
 * one type explicitly excluded.
 */
export const DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES: ContractTypeName[] = ['DEPOSIT_INSTALMENT', 'DEVICE_LOAN'];

/** AirtelTigo has no Hubtel direct-debit product — regular USSD collection only. */
export const DIRECT_DEBIT_NETWORKS = ['MTN', 'VODAFONE', 'TELECEL'] as const;
export type DirectDebitNetwork = (typeof DIRECT_DEBIT_NETWORKS)[number];
