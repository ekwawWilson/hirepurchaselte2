/**
 * Shapes the customer portal reads back from /api/portal, and the two
 * per-contract-type rules its pages keep needing. Both live here rather than
 * in each page, because "what does this customer still owe" is answered
 * differently by each of the three contract types:
 *
 *   SAVE_TO_OWN        open-ended savings — nothing is owed, and there is no
 *                      target to measure progress against
 *   DEPOSIT_INSTALMENT a balance and a schedule, so both are real figures
 *   DEVICE_LOAN        the loan amount plus interest accrued so far, with no
 *                      schedule to show progress against
 */

export interface PortalDeviceLoanState {
  principalMinor: number;
  principalOutstanding: boolean;
  accruedInterestMinor: number;
  interestPaidMinor: number;
  totalOwedMinor: number;
}

export interface PortalContract {
  id: string;
  contractNumber: string;
  contractType: string;
  status: string;
  totalPayableMinor: number | null;
  totalPaidMinor: number;
  balanceMinor: number | null;
  depositAmountMinor: number;
  instalmentAmountMinor: number | null;
  paymentFrequency: string;
  termWeeks: number | null;
  startDate: string;
  product: { name: string } | null;
  deviceLoanState: PortalDeviceLoanState | null;
}

export interface PortalInstalment {
  id: string;
  instalmentNo: number;
  dueDate: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  status: string;
}

export interface PortalUpcoming extends PortalInstalment {
  contract: { id: string; contractNumber: string; contractType: string };
}

export interface PortalPayment {
  id: string;
  entryType: string;
  amountMinor: number;
  channel: string;
  receiptNumber: string | null;
  receivedAt: string | null;
  reversesPaymentId: string | null;
  contract?: { id: string; contractNumber: string; contractType: string };
}

export interface PortalContractDetail extends PortalContract {
  inventoryItem: { serialNumber: string } | null;
  instalments: PortalInstalment[];
  payments: PortalPayment[];
}

/** What this contract still asks for. Always 0 for open-ended savings. */
export function amountOwed(contract: PortalContract): number {
  if (contract.contractType === 'DEVICE_LOAN') return contract.deviceLoanState?.totalOwedMinor ?? 0;
  if (contract.contractType === 'SAVE_TO_OWN') return 0;
  return contract.balanceMinor ?? 0;
}

/** Percentage paid, or null where the type has no total to measure against. */
export function progressPercent(contract: PortalContract): number | null {
  if (!contract.totalPayableMinor || contract.totalPayableMinor <= 0) return null;
  return Math.min(100, Math.round((contract.totalPaidMinor / contract.totalPayableMinor) * 100));
}

/** How a payment row reads to a customer — no internal entry-type names. */
export function paymentLabel(payment: PortalPayment): string {
  if (payment.reversesPaymentId) return 'Reversal';
  switch (payment.entryType) {
    case 'DEPOSIT': return 'Deposit';
    case 'WITHDRAWAL': return 'Withdrawal';
    case 'LOAN_INTEREST_PAYMENT': return 'Interest payment';
    case 'LOAN_PRINCIPAL_PAYMENT': return 'Loan repayment';
    default: return 'Payment';
  }
}
