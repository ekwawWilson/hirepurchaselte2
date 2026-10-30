import { prisma } from '../db/prisma';
import { formatMoney } from '../utils/money';
import { getControlSettings } from './controlSettingsService';
import { ledgerBalance } from './agentLedgerService';
import { getAgentPortfolioRisk } from './portfolioRiskService';
import { isOwnPhoneNumber } from './customerPortalService';
import { PRE_APPROVAL_STATUSES } from '../constants/contracts';

/**
 * The checks every new sale goes through: when it is made, when an agent
 * resubmits it, before submitting (the preflight), and again for the
 * approver in the approval queue. A blocker refuses the sale; a warning is
 * for the approver to weigh, and sets how soon they should decide.
 */

export interface SaleCheck {
  code: string;
  message: string;
}

export type Priority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface SaleChecks {
  blockers: SaleCheck[];
  warnings: SaleCheck[];
  priority: Priority;
  riskScore: number;
  /** How soon the approver should decide. */
  suggestedSlaHours: number;
}

export interface SaleDraft {
  createdById: string;
  creatorRole: string;
  contractType?: string;
  customerId?: string;
  productId?: string | null;
  totalPayableMinor?: number | null;
  depositAmountMinor?: number | null;
  termWeeks?: number | null;
  paymentMethod?: string | null;
  directDebitMsisdn?: string | null;
  startDate?: Date | null;
  /** The contract itself, when re-checking one already submitted: never counted against itself. */
  contractId?: string;
  resubmissions?: number;
}

// Thresholds for the approver's warnings. Decisions, kept together here.
const LOW_DEPOSIT_RATIO = 0.15;
const HIGH_FINANCE_MINOR = 700_000; // GHS 7,000
const LONG_TERM_WEEKS = 18;
const START_AHEAD_DAYS = 14;
const START_BACKDATED_DAYS = 2;

/** Warnings that make a sale HIGH or MEDIUM priority; anything else counts as low. */
const HIGH_FLAGS = ['DEFAULT_HISTORY', 'HIGH_FINANCE_AMOUNT', 'REVISION_LOOP'];
const MEDIUM_FLAGS = ['LOW_DEPOSIT_RATIO', 'MULTIPLE_OPEN_CONTRACTS', 'DIRECT_DEBIT_REVIEW', 'REPEAT_PRODUCT_FINANCING', 'MOMO_PHONE_MISMATCH'];
const SLA_HOURS: Record<Priority, number> = { HIGH: 6, MEDIUM: 12, LOW: 24 };

const DAY = 24 * 60 * 60 * 1000;
const OPEN_STATUSES = [...PRE_APPROVAL_STATUSES, 'PENDING_DEPOSIT', 'ACTIVE', 'DEFAULTED'];

/**
 * An agent may not make another sale while holding deposit cash they have
 * not remitted (Settings > Controls). Remitting it, once confirmed, lifts
 * the block by itself.
 */
async function depositArrears(agentId: string): Promise<SaleCheck | null> {
  const entries = await prisma.agentDepositLedger.findMany({ where: { agentId, status: { not: 'SETTLED' } } });
  const owing = entries.filter((e) => ledgerBalance(e) > 0);
  if (owing.length === 0) return null;
  const total = owing.reduce((s, e) => s + ledgerBalance(e), 0);
  return {
    code: 'AGENT_DEPOSIT_ARREARS',
    message: `You hold GHS ${formatMoney(total)} of deposit cash not yet remitted, on ${owing.length} contract${owing.length === 1 ? '' : 's'}. Remit it under My Deposits before your next sale.`,
  };
}

/** An agent whose PAR30 is over the limit, once their book is big enough to judge. Lifts by itself once they collect. */
async function parLimit(agentId: string, thresholdPercent: number, minContracts: number): Promise<SaleCheck | null> {
  const [risk] = await getAgentPortfolioRisk({ agentIds: [agentId] });
  if (!risk || risk.contracts < minContracts || risk.par30Percent <= thresholdPercent) return null;
  return {
    code: 'AGENT_PAR_LIMIT',
    message: `${risk.par30Percent}% of what your customers owe (GHS ${formatMoney(risk.par30Minor)} of GHS ${formatMoney(risk.outstandingMinor)}) is more than 30 days behind, over the ${thresholdPercent}% limit. Collect from them before your next sale.`,
  };
}

export async function evaluateSaleChecks(draft: SaleDraft): Promise<SaleChecks> {
  const blockers: SaleCheck[] = [];
  const warnings: SaleCheck[] = [];
  const settings = await getControlSettings();

  if (draft.creatorRole === 'AGENT') {
    if (settings.blockSalesWhileDepositsUnremitted) {
      const arrears = await depositArrears(draft.createdById);
      if (arrears) blockers.push(arrears);
    }
    if (settings.parBlockEnabled) {
      const par = await parLimit(draft.createdById, settings.parBlockThresholdPercent, settings.parBlockMinContracts);
      if (par) blockers.push(par);
    }
  }

  const others = draft.customerId
    ? await prisma.contract.findMany({
      where: { customerId: draft.customerId, ...(draft.contractId && { id: { not: draft.contractId } }) },
      select: { productId: true, status: true, defaultedAt: true },
    })
    : [];

  if (draft.productId && others.some((c) => c.productId === draft.productId && PRE_APPROVAL_STATUSES.includes(c.status))) {
    blockers.push({ code: 'DUPLICATE_UNDER_REVIEW', message: 'This customer already has a sale of this product waiting for approval.' });
  }

  const price = draft.totalPayableMinor ?? null;
  const deposit = draft.depositAmountMinor ?? null;
  if (price && price > 0 && deposit !== null) {
    if (deposit < price * LOW_DEPOSIT_RATIO) {
      warnings.push({ code: 'LOW_DEPOSIT_RATIO', message: `Deposit is ${Math.round((deposit / price) * 100)}% of the price, under ${LOW_DEPOSIT_RATIO * 100}%.` });
    }
    if (price - deposit >= HIGH_FINANCE_MINOR) {
      warnings.push({ code: 'HIGH_FINANCE_AMOUNT', message: `GHS ${formatMoney(price - deposit)} is financed, GHS ${formatMoney(HIGH_FINANCE_MINOR)} or more.` });
    }
  }
  if (draft.termWeeks && draft.termWeeks >= LONG_TERM_WEEKS) {
    warnings.push({ code: 'LONG_TENOR', message: `A ${draft.termWeeks}-week term.` });
  }
  if (draft.paymentMethod === 'DIRECT_DEBIT' || draft.paymentMethod === 'BOTH') {
    warnings.push({ code: 'DIRECT_DEBIT_REVIEW', message: 'Paid by direct debit from a mobile money wallet.' });
    if (draft.directDebitMsisdn && draft.customerId) {
      const customer = await prisma.customer.findUnique({ where: { id: draft.customerId }, select: { phone: true, phone2: true, phone3: true } });
      if (customer && !isOwnPhoneNumber(customer, draft.directDebitMsisdn)) {
        warnings.push({ code: 'MOMO_PHONE_MISMATCH', message: `The direct debit number ${draft.directDebitMsisdn} is not one of the customer's own numbers.` });
      }
    }
  }
  const open = others.filter((c) => OPEN_STATUSES.includes(c.status));
  if (open.length > 0) {
    warnings.push({ code: 'MULTIPLE_OPEN_CONTRACTS', message: `The customer already has ${open.length} open contract${open.length === 1 ? '' : 's'}.` });
  }
  if (others.some((c) => c.defaultedAt || c.status === 'DEFAULTED' || c.status === 'WRITTEN_OFF')) {
    warnings.push({ code: 'DEFAULT_HISTORY', message: 'The customer has defaulted on a contract before.' });
  }
  if (draft.productId && others.some((c) => c.productId === draft.productId && !PRE_APPROVAL_STATUSES.includes(c.status))) {
    warnings.push({ code: 'REPEAT_PRODUCT_FINANCING', message: 'The customer has bought this same product on credit before.' });
  }
  if ((draft.resubmissions ?? 0) > 0) {
    warnings.push({ code: 'REVISION_LOOP', message: `Resubmitted ${draft.resubmissions} time${draft.resubmissions === 1 ? '' : 's'} after being sent back.` });
  }
  if (draft.startDate) {
    const days = (draft.startDate.getTime() - Date.now()) / DAY;
    if (days > START_AHEAD_DAYS) warnings.push({ code: 'START_FAR_AHEAD', message: `Starts ${Math.round(days)} days from now.` });
    if (days < -START_BACKDATED_DAYS) warnings.push({ code: 'START_BACKDATED', message: `Backdated ${Math.round(-days)} days.` });
  }

  const codes = warnings.map((w) => w.code);
  const priority: Priority = blockers.length > 0 || codes.some((c) => HIGH_FLAGS.includes(c)) ? 'HIGH'
    : codes.some((c) => MEDIUM_FLAGS.includes(c)) ? 'MEDIUM' : 'LOW';
  const riskScore = blockers.length * 30
    + codes.reduce((s, c) => s + (HIGH_FLAGS.includes(c) ? 20 : MEDIUM_FLAGS.includes(c) ? 12 : 6), 0);
  return { blockers, warnings, priority, riskScore, suggestedSlaHours: SLA_HOURS[priority] };
}

/** The checks for a contract already submitted, as its approver sees them. */
export async function checksForContract(contractId: string): Promise<SaleChecks> {
  const c = await prisma.contract.findUniqueOrThrow({
    where: { id: contractId },
    select: {
      id: true, createdById: true, contractType: true, customerId: true, productId: true, totalPayableMinor: true, depositAmountMinor: true,
      termWeeks: true, paymentMethod: true, pendingDirectDebitMsisdn: true, startDate: true,
      createdBy: { select: { role: { select: { name: true } } } },
    },
  });
  const resubmissions = await prisma.auditLog.count({ where: { entityType: 'Contract', entityId: contractId, action: 'CONTRACT_RESUBMIT' } });
  return evaluateSaleChecks({
    createdById: c.createdById, creatorRole: c.createdBy.role.name, contractType: c.contractType, customerId: c.customerId, productId: c.productId,
    totalPayableMinor: c.totalPayableMinor, depositAmountMinor: c.depositAmountMinor, termWeeks: c.termWeeks,
    paymentMethod: c.paymentMethod, directDebitMsisdn: c.pendingDirectDebitMsisdn, startDate: null, contractId: c.id, resubmissions,
  });
}
