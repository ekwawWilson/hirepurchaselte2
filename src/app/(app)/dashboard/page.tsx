'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Users, FileText, Banknote, AlertCircle, Plus, Warehouse } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { formatCurrency } from '@/lib/utils';

interface DashboardSummary {
  todayCashMinor: number;
  todayContractsCount: number;
  todayContractsValueMinor: number;
  arrearsTotalMinor: number;
  stockAvailable: number;
}

function StatCard({
  title, value, icon: Icon, iconClass, iconBg, subtitle, href, highlight,
}: {
  title: string; value: string; icon: React.ElementType; iconClass: string; iconBg: string;
  subtitle?: string; href: string; highlight?: boolean;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-4 hover:shadow-md hover:border-gray-200 transition-all"
    >
      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${iconBg}`}>
        <Icon className={`h-5 w-5 ${iconClass}`} />
      </div>
      <div className="min-w-0">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{title}</p>
        <p className={`text-xl font-bold ${highlight ? 'text-red-600' : 'text-gray-900'}`}>{value}</p>
        {subtitle && <p className="text-xs text-gray-400 truncate">{subtitle}</p>}
      </div>
    </Link>
  );
}

function QuickAction({
  href, label, description, colorClass, labelClass, descClass, icon,
}: {
  href: string; label: string; description: string; colorClass: string; labelClass: string; descClass: string; icon: React.ReactNode;
}) {
  return (
    <Link href={href} className={`flex items-center gap-3 rounded-xl border p-4 transition-colors ${colorClass}`}>
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/70">{icon}</div>
      <div className="min-w-0">
        <p className={`text-sm font-semibold ${labelClass}`}>{label}</p>
        <p className={`text-xs ${descClass}`}>{description}</p>
      </div>
    </Link>
  );
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<DashboardSummary>('/dashboard')
      .then(setStats)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load dashboard statistics'));
  }, []);

  return (
    <div className="space-y-5 sm:space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">Hire purchase management overview</p>
      </div>

      {error && (
        <div className="flex items-start gap-3 p-4 bg-red-50 border border-red-200 rounded-xl">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{error}</p>
        </div>
      )}

      {!stats && !error && (
        <div className="flex h-40 items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      )}

      {stats && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
            <StatCard title="Today's Cash" value={formatCurrency(stats.todayCashMinor)} icon={Banknote} iconClass="text-blue-600" iconBg="bg-blue-50" href="/reports/daily-cash" />
            <StatCard
              title="Today's Contracts"
              value={String(stats.todayContractsCount)}
              subtitle={formatCurrency(stats.todayContractsValueMinor)}
              icon={FileText}
              iconClass="text-emerald-600"
              iconBg="bg-emerald-50"
              href="/contracts"
            />
            <StatCard
              title="Arrears"
              value={formatCurrency(stats.arrearsTotalMinor)}
              icon={AlertCircle}
              iconClass="text-red-600"
              iconBg="bg-red-50"
              href="/reports"
              highlight={stats.arrearsTotalMinor > 0}
            />
            <StatCard title="Items in Stock" value={String(stats.stockAvailable)} icon={Warehouse} iconClass="text-purple-600" iconBg="bg-purple-50" href="/inventory" />
          </div>

          <div>
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Quick Actions</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <QuickAction
                href="/customers"
                label="Register Customer"
                description="Create account & membership ID"
                colorClass="bg-blue-50 hover:bg-blue-100 border-blue-100"
                labelClass="text-blue-900"
                descClass="text-blue-600"
                icon={<Plus className="h-5 w-5 text-blue-600" />}
              />
              <QuickAction
                href="/contracts"
                label="New Contract"
                description="Start a hire purchase contract"
                colorClass="bg-emerald-50 hover:bg-emerald-100 border-emerald-100"
                labelClass="text-emerald-900"
                descClass="text-emerald-600"
                icon={<Plus className="h-5 w-5 text-emerald-600" />}
              />
              <QuickAction
                href="/products"
                label="Add Product"
                description="Add products to the catalogue"
                colorClass="bg-purple-50 hover:bg-purple-100 border-purple-100"
                labelClass="text-purple-900"
                descClass="text-purple-600"
                icon={<Plus className="h-5 w-5 text-purple-600" />}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <Link href="/customers" className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-4 hover:bg-gray-50 transition-colors">
              <Users className="h-5 w-5 text-gray-400" />
              <span className="text-sm font-medium text-gray-700">Browse customers</span>
            </Link>
            <Link href="/ussd-simulator" className="flex items-center gap-3 rounded-xl border border-gray-100 bg-white p-4 hover:bg-gray-50 transition-colors">
              <Banknote className="h-5 w-5 text-gray-400" />
              <span className="text-sm font-medium text-gray-700">Try the USSD payment simulator</span>
            </Link>
          </div>
        </>
      )}
    </div>
  );
}
