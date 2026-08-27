import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** amountMinor is pesewas (integer minor units) — never a float. */
export function formatCurrency(amountMinor: number): string {
  return new Intl.NumberFormat("en-GH", {
    style: "currency",
    currency: "GHS",
  }).format(amountMinor / 100);
}

export function formatDate(date: Date | string | null | undefined): string {
  if (!date) return "-";
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-GB").format(d);
}

export function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "-";
  const d = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-GB", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function calculateProgress(totalPaidMinor: number, totalPayableMinor: number): number {
  if (totalPayableMinor === 0) return 0;
  return Math.min((totalPaidMinor / totalPayableMinor) * 100, 100);
}

export function getStatusColor(status: string): string {
  const colors: Record<string, string> = {
    // Contract statuses
    ACTIVE: "bg-blue-50 text-blue-700 ring-1 ring-blue-200/60",
    PENDING_DEPOSIT: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/60",
    COMPLETED: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60",
    RELEASED: "bg-gray-100 text-gray-600 ring-1 ring-gray-200/60",
    CANCELLED: "bg-gray-100 text-gray-600 ring-1 ring-gray-200/60",
    DEFAULTED: "bg-red-50 text-red-700 ring-1 ring-red-200/60",
    WRITTEN_OFF: "bg-slate-800 text-slate-100 ring-1 ring-slate-700",
    // Instalment / payment statuses
    PENDING: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/60",
    PARTIAL: "bg-orange-50 text-orange-700 ring-1 ring-orange-200/60",
    PAID: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60",
    OVERDUE: "bg-red-50 text-red-700 ring-1 ring-red-200/60",
    SUCCESS: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200/60",
    FAILED: "bg-red-50 text-red-700 ring-1 ring-red-200/60",
    // Inventory statuses
    AVAILABLE: "bg-blue-50 text-blue-700 ring-1 ring-blue-200/60",
    RESERVED: "bg-amber-50 text-amber-700 ring-1 ring-amber-200/60",
    ISSUED: "bg-violet-50 text-violet-700 ring-1 ring-violet-200/60",
    RETURNED: "bg-gray-100 text-gray-600 ring-1 ring-gray-200/60",
  };
  return colors[status] || "bg-gray-100 text-gray-600 ring-1 ring-gray-200/60";
}

export function contractTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    SAVE_TO_OWN: "Save to Own",
    DEPOSIT_INSTALMENT: "Deposit + Instalment",
    DEVICE_LOAN: "Device Loan",
  };
  return labels[type] ?? type;
}
