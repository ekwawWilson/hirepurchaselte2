'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertCircle, ArrowRight, Banknote, ChevronRight, FileText, Plus, Warehouse } from 'lucide-react';
import { api, ApiError } from '@/lib/apiClient';
import { useAuthStore } from '@/lib/authStore';
import { formatCurrency, formatDate, contractTypeLabel, getStatusColor, cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

interface DashboardSummary {
  todayCashMinor: number;
  todayContractsCount: number;
  todayContractsValueMinor: number;
  arrearsTotalMinor: number;
  stockAvailable: number;
}

interface RecentContract {
  id: string;
  contractNumber: string;
  contractType: string;
  status: string;
  totalPaidMinor: number;
  createdAt: string;
  customer: { firstName: string; lastName: string };
  product: { name: string } | null;
}

/** Legacy's stat card: label with a tinted icon chip to its right, the figure below. */
function StatCard({
  title, value, icon: Icon, iconClass, iconBg, subtitle, href, highlight,
}: {
  title: string; value: string; icon: React.ElementType; iconClass: string; iconBg: string;
  subtitle?: string; href: string; highlight?: boolean;
}) {
  return (
    <Link
      href={href}
      className={cn(
        'flex min-w-0 flex-col gap-3 rounded-xl border bg-white p-4 transition-all hover:shadow-md hover:-translate-y-px',
        highlight ? 'border-red-200 ring-1 ring-red-100' : 'border-gray-100',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs sm:text-sm font-medium text-gray-500 truncate">{title}</span>
        <div className={cn('p-1.5 sm:p-2 rounded-lg shrink-0', iconBg)}>
          <Icon className={cn('h-4 w-4 sm:h-5 sm:w-5', iconClass)} />
        </div>
      </div>
      <div className="min-w-0">
        <p className={cn('truncate text-lg sm:text-2xl font-bold', highlight ? 'text-red-600' : 'text-gray-900')} title={value}>
          {value}
        </p>
        {subtitle && <p className="text-xs text-gray-400 mt-0.5 truncate">{subtitle}</p>}
      </div>
    </Link>
  );
}

/** Legacy's quick action: a tinted card with a plus, a title and a line of detail. */
function QuickAction({ href, label, description, tone }: {
  href: string; label: string; description: string; tone: 'blue' | 'emerald' | 'purple' | 'orange';
}) {
  const tones = {
    blue: { card: 'bg-blue-50/80 border-blue-100 hover:bg-blue-50', title: 'text-blue-900', text: 'text-blue-600' },
    emerald: { card: 'bg-emerald-50/80 border-emerald-100 hover:bg-emerald-50', title: 'text-emerald-900', text: 'text-emerald-600' },
    purple: { card: 'bg-purple-50/80 border-purple-100 hover:bg-purple-50', title: 'text-purple-900', text: 'text-purple-600' },
    // The logo's own orange — see globals.css's --brand-accent comment.
    orange: { card: 'bg-orange-50/80 border-orange-100 hover:bg-orange-50', title: 'text-orange-900', text: 'text-orange-600' },
  }[tone];

  return (
    <Link href={href} className={cn('group flex items-center gap-4 rounded-xl border p-4 transition-colors', tones.card)}>
      <Plus className={cn('h-5 w-5 shrink-0', tones.text)} />
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm font-semibold truncate', tones.title)}>{label}</p>
        <p className={cn('text-xs truncate', tones.text)}>{description}</p>
      </div>
      <ChevronRight className="h-4 w-4 text-gray-400 shrink-0 transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

export default function DashboardPage() {
  const canViewContracts = useAuthStore((s) => s.hasPermission('contract.view'));
  const hasReportAccess = useAuthStore((s) => s.hasPermission('report.view.branch', 'report.view.all'));
  // Neither SALES nor the Agent module's AGENT role holds a report
  // permission — the branch-wide dashboard below is meaningless to them
  // (and the API 403s it anyway). They get a portfolio-shaped summary of
  // their own contracts instead, derived from the same own-scoped
  // GET /api/contracts every other page already uses (rbac.ts's
  // ownRecordsWhere for AGENT; a plain branch view for SALES).
  const showAgentSummary = !hasReportAccess && canViewContracts;
  // The branch-wide dashboard below is reachable by roles that hold none of
  // a given quick action's underlying permission (STORE_KEEPER has neither
  // customer.view nor contract.view; AUDITOR has none of the three at all) —
  // unconditional tiles would point them at a page that's either a hard
  // AccessDenied wall or, at best, missing the actual create button they
  // came for. Gated the same way each destination page gates its own button.
  const canCreateCustomer = useAuthStore((s) => s.hasPermission('customer.create'));
  const canCreateContract = useAuthStore((s) => s.hasPermission('contract.create'));
  const canReceiveInventory = useAuthStore((s) => s.hasPermission('inventory.receive'));
  const hasAnyQuickAction = canCreateCustomer || canCreateContract || canReceiveInventory;
  const [stats, setStats] = useState<DashboardSummary | null>(null);
  const [recent, setRecent] = useState<RecentContract[] | null>(null);
  const [ownContracts, setOwnContracts] = useState<RecentContract[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function load() {
    if (showAgentSummary) return;
    setError(null);
    api.get<DashboardSummary>('/dashboard')
      .then(setStats)
      .catch((e) => setError(e instanceof ApiError ? e.message : 'Could not load dashboard statistics'));
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAgentSummary]);

  useEffect(() => {
    if (!canViewContracts || showAgentSummary) return;
    api.get<{ contracts: RecentContract[] }>('/contracts')
      .then((r) => setRecent(r.contracts.slice(0, 5)))
      .catch(() => setRecent([]));
  }, [canViewContracts, showAgentSummary]);

  useEffect(() => {
    if (!showAgentSummary) return;
    api.get<{ contracts: RecentContract[] }>('/contracts')
      .then((r) => setOwnContracts(r.contracts))
      .catch(() => setOwnContracts([]));
  }, [showAgentSummary]);

  if (showAgentSummary) {
    return <AgentDashboard contracts={ownContracts} />;
  }

  return (
    <div className="space-y-5 sm:space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">Hire purchase management overview</p>
      </div>

      {error && (
        <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <AlertCircle className="h-5 w-5 text-red-500 shrink-0" />
          <p className="flex-1 text-sm text-red-700">{error}</p>
          <button onClick={load} className="text-sm font-medium text-red-700 underline hover:text-red-900">Retry</button>
        </div>
      )}

      {!stats && !error && (
        <div className="flex h-40 items-center justify-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        </div>
      )}

      {stats && (
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
            href="/reports/arrears-ageing"
            highlight={stats.arrearsTotalMinor > 0}
          />
          <StatCard title="Items in Stock" value={String(stats.stockAvailable)} icon={Warehouse} iconClass="text-purple-600" iconBg="bg-purple-50" href="/inventory" />
        </div>
      )}

      {hasAnyQuickAction && (
        <section>
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Quick Actions</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {canCreateCustomer && (
              <QuickAction href="/customers" label="Register Customer" description="Create account & membership ID" tone="blue" />
            )}
            {canCreateContract && (
              <QuickAction href="/contracts" label="New Contract" description="Start a hire purchase contract" tone="emerald" />
            )}
            {canReceiveInventory && (
              <QuickAction href="/products" label="Add Product" description="Add products to the catalogue" tone="orange" />
            )}
          </div>
        </section>
      )}

      {canViewContracts && (
        <section>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Recent Contracts</h2>
            <Link href="/contracts" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
              View all <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>

          <div className="rounded-2xl border border-white/60 bg-white/90 shadow-[0_20px_45px_-22px_rgba(15,23,42,0.35)] overflow-hidden">
            {recent === null ? (
              <div className="flex h-32 items-center justify-center">
                <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
              </div>
            ) : recent.length === 0 ? (
              <div className="py-12 text-center">
                <FileText className="h-8 w-8 text-gray-300 mx-auto mb-2" />
                <p className="text-sm text-gray-500">No contracts yet</p>
                <p className="text-xs text-gray-400 mt-0.5">Recent contracts will appear here</p>
              </div>
            ) : (
              <div className="divide-y divide-gray-100">
                {recent.map((c) => (
                  <Link key={c.id} href={`/contracts/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50/80 transition-colors">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900 truncate">{c.customer.firstName} {c.customer.lastName}</p>
                      <p className="text-xs text-gray-500 truncate">
                        <span className="font-mono">{c.contractNumber}</span> · {c.product?.name ?? contractTypeLabel(c.contractType)} · {formatDate(c.createdAt)}
                      </p>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="text-sm font-semibold text-gray-900">{formatCurrency(c.totalPaidMinor)}</p>
                      <Badge className={getStatusColor(c.status)}>{c.status.replace(/_/g, ' ')}</Badge>
                    </div>
                    <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * The Agent module's own-portfolio dashboard — shown instead of the
 * branch-wide one above to anyone who can create contracts but has no
 * report permission (an AGENT, or a SALES user): the branch summary would
 * either 403 or mean nothing to them, since neither role sees more than
 * their own book (rbac.ts's OWN_SCOPED_ROLES / ownRecordsWhere).
 */
function AgentDashboard({ contracts }: { contracts: RecentContract[] | null }) {
  if (!contracts) {
    return (
      <div className="flex h-40 items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  const pendingApproval = contracts.filter((c) => c.status === 'PENDING_APPROVAL').length;
  const revisionRequested = contracts.filter((c) => c.status === 'REVISION_REQUESTED').length;
  const stillGoing = contracts.filter((c) => ['ACTIVE', 'PENDING_DEPOSIT', 'DEFAULTED'].includes(c.status)).length;

  return (
    <div className="space-y-5 sm:space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-sm text-gray-500 mt-0.5">Your own contracts</p>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard title="Total portfolio" value={String(contracts.length)} icon={FileText} iconClass="text-blue-600" iconBg="bg-blue-50" href="/contracts" />
        <StatCard title="Pending approval" value={String(pendingApproval)} icon={AlertCircle} iconClass="text-amber-600" iconBg="bg-amber-50" href="/contracts?status=PENDING_APPROVAL" highlight={pendingApproval > 0} />
        <StatCard title="Revision requested" value={String(revisionRequested)} icon={AlertCircle} iconClass="text-orange-600" iconBg="bg-orange-50" href="/contracts?status=REVISION_REQUESTED" highlight={revisionRequested > 0} />
        <StatCard title="Active" value={String(stillGoing)} icon={FileText} iconClass="text-emerald-600" iconBg="bg-emerald-50" href="/contracts" />
      </div>

      <section>
        <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide mb-3">Quick Actions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <QuickAction href="/customers" label="Register Customer" description="Create account & membership ID" tone="blue" />
          <QuickAction href="/contracts" label="New Contract" description="Submit a hire purchase contract" tone="emerald" />
        </div>
      </section>

      <section>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-gray-500 uppercase tracking-wide">Your contracts</h2>
          <Link href="/contracts" className="flex items-center gap-1 text-xs font-medium text-primary hover:underline">
            View all <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </div>

        <div className="rounded-2xl border border-white/60 bg-white/90 shadow-[0_20px_45px_-22px_rgba(15,23,42,0.35)] overflow-hidden">
          {contracts.length === 0 ? (
            <div className="py-12 text-center">
              <FileText className="h-8 w-8 text-gray-300 mx-auto mb-2" />
              <p className="text-sm text-gray-500">No contracts yet</p>
              <p className="text-xs text-gray-400 mt-0.5">Submit your first contract from the Contracts page</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {contracts.slice(0, 8).map((c) => (
                <Link key={c.id} href={`/contracts/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50/80 transition-colors">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-gray-900 truncate">{c.customer.firstName} {c.customer.lastName}</p>
                    <p className="text-xs text-gray-500 truncate">
                      <span className="font-mono">{c.contractNumber}</span> · {c.product?.name ?? contractTypeLabel(c.contractType)} · {formatDate(c.createdAt)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-semibold text-gray-900">{formatCurrency(c.totalPaidMinor)}</p>
                    <Badge className={getStatusColor(c.status)}>{c.status.replace(/_/g, ' ')}</Badge>
                  </div>
                  <ChevronRight className="h-4 w-4 text-gray-300 shrink-0" />
                </Link>
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
