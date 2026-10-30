import { prisma } from '../db/prisma';
import { formatMoney } from '../utils/money';
import { getControlSettings } from './controlSettingsService';
import { ledgerBalance } from './agentLedgerService';

/**
 * The checks every new sale goes through before it is made, and again when
 * an agent resubmits one. A blocker refuses the sale; the agent sees why.
 */

export interface SaleCheck {
  code: string;
  message: string;
}

export interface SaleChecks {
  blockers: SaleCheck[];
}

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

export async function evaluateSaleChecks(params: { createdById: string; creatorRole: string }): Promise<SaleChecks> {
  const blockers: SaleCheck[] = [];
  const settings = await getControlSettings();
  if (params.creatorRole === 'AGENT' && settings.blockSalesWhileDepositsUnremitted) {
    const arrears = await depositArrears(params.createdById);
    if (arrears) blockers.push(arrears);
  }
  return { blockers };
}
