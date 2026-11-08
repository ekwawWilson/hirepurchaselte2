/**
 * What the server's customer API returns (/api/portal). Money is always in
 * pesewas (minor units), as the server keeps it; dates are ISO strings.
 */

export type ContractType = 'DEPOSIT_INSTALMENT' | 'DEVICE_FINANCING' | 'SAVE_TO_OWN' | 'DEVICE_LOAN';

export interface Customer {
  id: string;
  membershipId: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  phone2?: string | null;
  phone3?: string | null;
  email?: string | null;
  address?: string | null;
  mustChangePassword?: boolean;
  branch?: { name: string; phone: string | null; address: string | null } | null;
}

/** What is owed on a contract right now (customerPortalService.dueSummary on the server). */
export interface Due {
  /** The most one payment can be; null for open-ended savings. */
  totalDueMinor: number | null;
  penaltyOutstandingMinor: number;
  overdueMinor: number;
  overdueCount: number;
  nextDueMinor: number;
  nextDueDate: string | null;
  unpaidCount: number;
}

export interface DeviceLoanState {
  principalMinor: number;
  principalOutstanding: boolean;
  accruedInterestMinor: number;
  interestPaidMinor: number;
  totalOwedMinor: number;
}

/** One tier of a temporary unlock: pay this, the phone opens this long. */
export interface UnlockOption {
  percent: number;
  hours: number;
  /** "1 day", "12 hours". */
  period: string;
  amountMinor: number;
  chargeMinor: number;
}

/** A locked Device Financing phone (paytrigger/temporaryUnlock.ts on the server); null when it does not apply. */
export interface TemporaryUnlockOffer {
  available: boolean;
  message: string | null;
  overdueMinor: number;
  options: UnlockOption[];
  activeUntil: string | null;
  usesLeft: number;
}

export interface Contract {
  id: string;
  contractNumber: string;
  contractType: ContractType;
  status: string;
  totalPayableMinor: number | null;
  totalPaidMinor: number;
  balanceMinor: number | null;
  depositAmountMinor: number;
  instalmentAmountMinor: number | null;
  paymentFrequency: string;
  termWeeks: number | null;
  gracePeriodDays: number;
  penaltyRateBps: number;
  startDate: string;
  product: { name: string } | null;
  deviceLoanState: DeviceLoanState | null;
  /** Missing on a server older than this app. */
  temporaryUnlock?: TemporaryUnlockOffer | null;
  due: Due;
}

export interface Instalment {
  id: string;
  instalmentNo: number;
  dueDate: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  status: 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE' | string;
  paidAt: string | null;
}

export interface Payment {
  id: string;
  entryType: string;
  amountMinor: number;
  channel: string;
  status?: string;
  receiptNumber: string | null;
  transactionRef?: string;
  receivedAt: string | null;
  createdAt: string;
  reversesPaymentId: string | null;
  reversedById?: string | null;
  contract?: { id: string; contractNumber: string; contractType: string };
}

export interface ContractDetail extends Contract {
  inventoryItem: { serialNumber: string; name: string | null; description: string | null } | null;
  instalments: Instalment[];
  payments: Payment[];
}

export interface OrgSettings {
  companyName: string;
  phone: string | null;
  address: string | null;
  email: string | null;
  logoUrl: string | null;
}
