/** What the printed receipt, statement and agreement read from GET /api/contracts/:id. */
export interface DocInstalment { id: string; instalmentNo: number; dueDate: string; amountDueMinor: number; amountPaidMinor: number; status: string }
export interface DocPayment {
  id: string; entryType: string; amountMinor: number; channel: string; status: string; receiptNumber: string | null;
  transactionRef: string; notes: string | null; reversesPaymentId: string | null; reversedById: string | null;
  mobileMoneyNetwork: string | null; createdAt: string; receivedAt: string | null;
  createdBy: { firstName: string; lastName: string } | null;
}
export interface DocContract {
  id: string; contractNumber: string; contractType: string; status: string; paymentFrequency: string; paymentMethod: string;
  totalPayableMinor: number | null; totalPaidMinor: number; balanceMinor: number | null; depositAmountMinor: number;
  principalMinor: number | null; interestRateBps: number | null; instalmentAmountMinor: number | null;
  termWeeks: number | null; gracePeriodDays: number; penaltyRateBps: number; startDate: string; createdAt: string;
  deviceLoanState: { principalMinor: number; principalOutstanding: boolean; accruedInterestMinor: number; interestPaidMinor: number; totalOwedMinor: number } | null;
  customer: {
    firstName: string; lastName: string; membershipId: string; phone: string | null; phone2: string | null; phone3: string | null;
    address: string | null; occupation: string | null; workAddress: string | null; nationalId: string | null;
    guarantorName: string | null; guarantorPhone: string | null;
  };
  product: { name: string } | null;
  inventoryItem: { serialNumber: string; name: string | null; description: string | null } | null;
  branch: { name: string; address: string | null; phone: string | null } | null;
  instalments: DocInstalment[];
  payments: DocPayment[];
}

export const ENTRY_LABELS: Record<string, string> = {
  DEPOSIT: 'Deposit', INSTALMENT_PAYMENT: 'Payment', WITHDRAWAL: 'Withdrawal',
  LOAN_INTEREST_PAYMENT: 'Loan interest', LOAN_PRINCIPAL_PAYMENT: 'Loan repayment', CREDIT: 'Credit',
};
export const CHANNEL_LABELS: Record<string, string> = { CASH: 'Cash', USSD: 'Mobile money', DIRECT_DEBIT: 'Direct debit' };

export const customerPhone = (c: DocContract['customer']) => c.phone ?? c.phone2 ?? c.phone3;

/** Payments that count: successful, not a reversal row, and not themselves reversed. */
export const effectivePayments = (contract: DocContract) =>
  contract.payments.filter((p) => p.status === 'SUCCESS' && !p.reversesPaymentId && !p.reversedById);

/** What is overdue on the schedule right now. */
export const overdueMinor = (contract: DocContract) =>
  contract.instalments.filter((i) => i.status === 'OVERDUE').reduce((s, i) => s + i.amountDueMinor - i.amountPaidMinor, 0);

/** The next instalment still to be paid, if there is a schedule. */
export const nextInstalment = (contract: DocContract) =>
  contract.instalments.find((i) => i.amountPaidMinor < i.amountDueMinor) ?? null;

/** 0241234567 -> 233241234567, the form wa.me links take. */
export const whatsappNumber = (phone: string) => (phone.startsWith('0') ? `233${phone.slice(1)}` : phone.replace(/^\+/, ''));
