'use client';

import Link from 'next/link';
import { useAuthStore } from '@/lib/authStore';
import { Card } from '@/components/ui/card';
import { ReportLetterhead } from '@/components/ReportLetterhead';

const rawViewer = (path: string) => `/reports/raw?path=${encodeURIComponent(path)}`;

const REPORTS = [
  { href: '/reports/daily-cash', label: 'Daily cash received', desc: 'Cash vs USSD, by cashier, reconciled against the ledger.' },
  { href: rawViewer('/reports/contracts-created'), label: 'Contracts created today', desc: 'Count and value, by type/user/branch.' },
  { href: rawViewer('/reports/collections-vs-expected'), label: 'Collections vs expected', desc: 'What was due today vs what came in.' },
  { href: rawViewer('/reports/payments-register'), label: 'Payments register', desc: 'Every payment in range, all channels.' },
  { href: rawViewer('/reports/outstanding-balances'), label: 'Outstanding balances', desc: 'Portfolio view, per contract and customer.' },
  { href: rawViewer('/reports/arrears-ageing'), label: 'Arrears ageing', desc: '1-30 / 31-60 / 61-90 / 90+ days past due.' },
  { href: rawViewer('/reports/contract-status-summary'), label: 'Contract status summary', desc: 'Active/completed/defaulted counts and values.' },
  { href: rawViewer('/reports/inventory-position'), label: 'Inventory position', desc: 'Stock on hand/reserved/issued, by product/branch.' },
  { href: rawViewer('/reports/devices-pending-release'), label: 'Devices pending release', desc: 'Completed Save-to-Own contracts awaiting hand-over.' },
  { href: rawViewer('/reports/loan-book'), label: 'Loan book', desc: 'Type C: principal/interest outstanding and earned.' },
  { href: rawViewer('/reports/audit-trail'), label: 'User activity / audit trail', desc: 'Who did what, when.' },
  { href: rawViewer('/reports/customer-registrations'), label: 'Customer registrations', desc: 'New customers in range, by user.' },
];

export default function ReportsIndexPage() {
  const hasPermission = useAuthStore((s) => s.hasPermission);

  return (
    <div className="space-y-5">
      <ReportLetterhead />
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Reports</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          Every report is permission-gated and branch-scoped server-side. Daily Cash has a full dashboard view;
          the rest open in an authenticated JSON viewer for now.
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {REPORTS.map((r) => (
          <Link key={r.href} href={r.href}>
            <Card className="h-full p-5 hover:shadow-md hover:border-gray-300 transition-all">
              <p className="font-semibold text-gray-900">{r.label}</p>
              <p className="mt-1 text-xs text-gray-500">{r.desc}</p>
            </Card>
          </Link>
        ))}
      </div>
      {!hasPermission('audit.view') && (
        <p className="text-xs text-gray-400">Note: the audit trail report requires the audit.view permission.</p>
      )}
    </div>
  );
}
