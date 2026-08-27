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
    ACTIVE: "bg-blue-100 text-blue-800",
    PENDING_DEPOSIT: "bg-amber-100 text-amber-800",
    COMPLETED: "bg-green-100 text-green-800",
    RELEASED: "bg-gray-100 text-gray-700",
    CANCELLED: "bg-gray-100 text-gray-800",
    DEFAULTED: "bg-red-100 text-red-800",
    WRITTEN_OFF: "bg-zinc-800 text-zinc-100",
    // Instalment / payment statuses
    PENDING: "bg-yellow-100 text-yellow-800",
    PARTIAL: "bg-orange-100 text-orange-800",
    PAID: "bg-green-100 text-green-800",
    OVERDUE: "bg-red-100 text-red-800",
    SUCCESS: "bg-green-100 text-green-800",
    FAILED: "bg-red-100 text-red-800",
    // Inventory statuses
    AVAILABLE: "bg-blue-100 text-blue-800",
    RESERVED: "bg-yellow-100 text-yellow-800",
    ISSUED: "bg-purple-100 text-purple-800",
    RETURNED: "bg-gray-100 text-gray-700",
  };
  return colors[status] || "bg-gray-100 text-gray-800";
}

export function contractTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    SAVE_TO_OWN: "Save to Own",
    DEPOSIT_INSTALMENT: "Deposit + Instalment",
    DEVICE_LOAN: "Device Loan",
  };
  return labels[type] ?? type;
}
