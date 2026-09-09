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
 * admin-entry point, not as a DB constraint. No contract type reads a price
 * chart entry at creation anymore (contractService.ts) — kept only for the
 * standalone Price Chart page/legacy entries.
 */
export const PRICE_CHART_TERM_MONTHS = [3, 4, 6] as const;

/**
 * DEPOSIT_INSTALMENT's term is entered directly at contract creation, in
 * weeks, not looked up from a price chart — 1 to 24 weeks.
 */
export const DEPOSIT_INSTALMENT_MIN_TERM_WEEKS = 1;
export const DEPOSIT_INSTALMENT_MAX_TERM_WEEKS = 24;

/** DEPOSIT_INSTALMENT collects daily or weekly only — no monthly cadence. */
export const DEPOSIT_INSTALMENT_FREQUENCIES = ['DAILY', 'WEEKLY'] as const;

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
 * against a contract with a single well-defined "amount currently due" to
 * auto-charge. SAVE_TO_OWN is free-form savings with no due dates at all
 * (contractService.ts). DEVICE_LOAN no longer has one either under its new
 * daily-interest model — the customer self-directs which of two payments
 * (accrued interest, or the full loan amount) to make via USSD/staff, which
 * has no natural "auto-charge the due amount" equivalent — so DEPOSIT_INSTALMENT
 * is the only type left eligible.
 */
export const DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES: ContractTypeName[] = ['DEPOSIT_INSTALMENT'];

/** AirtelTigo has no Hubtel direct-debit product — regular USSD collection only. */
export const DIRECT_DEBIT_NETWORKS = ['MTN', 'VODAFONE', 'TELECEL'] as const;
export type DirectDebitNetwork = (typeof DIRECT_DEBIT_NETWORKS)[number];

/**
 * Every mobile money network Hubtel supports for a plain (non-direct-debit)
 * lookup/charge — unlike DIRECT_DEBIT_NETWORKS above, AirtelTigo belongs here
 * since Hubtel's restriction is specific to the Direct Debit product, not
 * AirtelTigo generally (getHubtelChannel maps it to 'tigo-gh' fine outside
 * direct debit). Vodafone Ghana's own 2024 rebrand to Telecel is why this
 * list has just one of the two, not both — same underlying Hubtel channel
 * ('vodafone-gh') either way, so carrying both as separate choices here would
 * only be a duplicate of the same option.
 */
export const MOBILE_MONEY_NETWORKS = ['MTN', 'TELECEL', 'AIRTELTIGO'] as const;
export type MobileMoneyNetwork = (typeof MOBILE_MONEY_NETWORKS)[number];
export const MOBILE_MONEY_NETWORK_LABELS: Record<MobileMoneyNetwork, string> = {
  MTN: 'MTN Ghana',
  TELECEL: 'Telecel Ghana',
  AIRTELTIGO: 'AirtelTigo Ghana',
};

/**
 * How a contract's instalments get collected. CUSTOMER_INITIATED (default): no
 * mandate, cash/USSD only. DIRECT_DEBIT: proactively auto-charged the moment an
 * instalment is due — no need to wait on the customer. BOTH: the customer can pay
 * themselves; direct debit only triggers once an instalment is actually overdue,
 * i.e. the customer defaulted on paying it themselves (collectionsService.ts).
 * DIRECT_DEBIT and BOTH both require a mandate — see DIRECT_DEBIT_ELIGIBLE_CONTRACT_TYPES.
 */
export const PAYMENT_METHODS = ['CUSTOMER_INITIATED', 'DIRECT_DEBIT', 'BOTH'] as const;
export type PaymentMethodName = (typeof PAYMENT_METHODS)[number];
