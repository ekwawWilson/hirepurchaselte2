'use client';

import Link from 'next/link';
import {
  Banknote, FileText, Scale, Receipt, Wallet, AlertTriangle, PieChart,
  Warehouse, PackageCheck, Landmark, History, UserPlus, type LucideIcon,
} from 'lucide-react';
import { useAuthStore } from '@/lib/authStore';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ReportLetterhead } from '@/components/ReportLetterhead';
import { cn } from '@/lib/utils';

interface ReportLink {
  href: string;
  label: string;
  desc: string;
  icon: LucideIcon;
  color: 'blue' | 'emerald' | 'amber' | 'red' | 'purple' | 'gray';
  perms?: string[];
}

const COLOR_MAP = {
  blue: 'bg-blue-100 text-primary',
  emerald: 'bg-emerald-100 text-emerald-600',
  amber: 'bg-amber-100 text-amber-600',
  red: 'bg-red-100 text-red-600',
  purple: 'bg-purple-100 text-purple-600',
  gray: 'bg-gray-100 text-gray-600',
} as const;

const REPORTS: ReportLink[] = [
  { href: '/reports/daily-cash', label: 'Daily cash received', desc: 'Cash vs USSD, by cashier, reconciled against the ledger.', icon: Banknote, color: 'emerald' },
  { href: '/reports/contracts-created', label: 'Contracts created', desc: 'Count and value of new contracts, by type and by staff.', icon: FileText, color: 'blue' },
  { href: '/reports/collections-vs-expected', label: 'Collections vs expected', desc: 'What was due in range vs what actually came in.', icon: Scale, color: 'purple' },
  { href: '/reports/payments-register', label: 'Payments register', desc: 'Every payment in range, all channels.', icon: Receipt, color: 'blue' },
  { href: '/reports/outstanding-balances', label: 'Outstanding balances', desc: 'Portfolio view, per contract and customer.', icon: Wallet, color: 'amber' },
  { href: '/reports/arrears-ageing', label: 'Arrears ageing', desc: '1-30 / 31-60 / 61-90 / 90+ days past due.', icon: AlertTriangle, color: 'red' },
  { href: '/reports/contract-status-summary', label: 'Contract status summary', desc: 'Active/completed/defaulted counts and values.', icon: PieChart, color: 'purple' },
  { href: '/reports/inventory-position', label: 'Inventory position', desc: 'Stock on hand/reserved/issued, by product/branch.', icon: Warehouse, color: 'gray' },
  { href: '/reports/devices-pending-release', label: 'Devices pending release', desc: 'Completed Save-to-Own contracts awaiting hand-over.', icon: PackageCheck, color: 'amber' },
  { href: '/reports/loan-book', label: 'Loan book', desc: 'Device Loan: principal/interest outstanding and earned.', icon: Landmark, color: 'blue' },
  { href: '/reports/audit-trail', label: 'User activity / audit trail', desc: 'Who did what, when.', icon: History, color: 'gray', perms: ['audit.view'] },
  { href: '/reports/customer-registrations', label: 'Customer registrations', desc: 'New customers in range, by user.', icon: UserPlus, color: 'emerald' },
];

export default function ReportsIndexPage() {
  const hasPermission = useAuthStore((s) => s.hasPermission);

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Reports</h1>
        <p className="text-sm text-gray-500 mt-0.5">Every report is permission-gated and branch-scoped server-side.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map((r) => {
          const locked = !!r.perms?.length && !hasPermission(...r.perms);
          return (
            <Card key={r.href} className={cn('h-full flex flex-col hover:shadow-md transition-shadow', locked && 'opacity-60')}>
              <CardContent className="p-5 flex flex-col flex-1">
                <div className={cn('w-10 h-10 rounded-lg flex items-center justify-center shrink-0 mb-3', COLOR_MAP[r.color])}>
                  <r.icon className="h-5 w-5" />
                </div>
                <p className="font-heading font-semibold text-gray-900">{r.label}</p>
                <p className="mt-1 text-xs text-gray-500 flex-1">{r.desc}</p>
                {locked ? (
                  <p className="mt-4 text-xs text-gray-400 text-center">Requires {r.perms?.join(' or ')}</p>
                ) : (
                  <Button asChild variant="outline" size="sm" className="mt-4 w-full">
                    <Link href={r.href}>View Report</Link>
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
