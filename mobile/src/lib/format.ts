import { colors } from '../constants/colors';

/** Plain words for what the server stores as codes. */

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export const FREQUENCY_LABELS: Record<string, string> = { DAILY: 'Daily', WEEKLY: 'Weekly', BIWEEKLY: 'Every two weeks', MONTHLY: 'Monthly' };

export const CONTRACT_TYPE_LABELS: Record<string, string> = {
  DEPOSIT_INSTALMENT: 'Hire purchase',
  DEVICE_FINANCING: 'Device financing',
  SAVE_TO_OWN: 'Savings',
  DEVICE_LOAN: 'Loan',
};

const STATUS: Record<string, { label: string; color: string; background: string }> = {
  ACTIVE: { label: 'Active', color: colors.success, background: colors.successSoft },
  PENDING_DEPOSIT: { label: 'Awaiting deposit', color: colors.warning, background: colors.warningSoft },
  COMPLETED: { label: 'Paid off', color: colors.primary, background: colors.primarySoft },
  RELEASED: { label: 'Collected', color: colors.primary, background: colors.primarySoft },
  DEFAULTED: { label: 'Defaulted', color: colors.danger, background: colors.dangerSoft },
  CANCELLED: { label: 'Cancelled', color: colors.danger, background: colors.dangerSoft },
  WRITTEN_OFF: { label: 'Closed', color: colors.danger, background: colors.dangerSoft },
};

export function statusStyle(status: string) {
  return STATUS[status] ?? { label: status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' '), color: colors.textMuted, background: colors.border };
}

export const CHANNEL_LABELS: Record<string, string> = {
  USSD: 'Mobile Money',
  MOBILE_MONEY: 'Mobile Money',
  DIRECT_DEBIT: 'Direct debit',
  CASH: 'Cash',
  BANK_TRANSFER: 'Bank transfer',
  MOBILE_MONEY_TRANSFER: 'Mobile Money',
};

/** The product's name, or what kind of contract it is. */
export const contractTitle = (c: { product: { name: string } | null; contractType: string }) =>
  c.product?.name ?? CONTRACT_TYPE_LABELS[c.contractType] ?? 'Contract';
