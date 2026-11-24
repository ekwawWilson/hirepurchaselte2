'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Home, FileText, CreditCard, User, LogOut } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useOrgSettingsStore } from '@/lib/orgSettingsStore';
import { useCustomerAuthStore } from '@/lib/customerAuthStore';
import { cn, companyInitials } from '@/lib/utils';
import { CompanyLogo } from '@/components/CompanyLogo';

/**
 * The portal's shell: a sidebar on desktop, a bottom tab bar on phones —
 * the same four destinations either way. Kept separate from the staff
 * AppShell: a customer has no branch, no permissions and no reports, so
 * sharing that component would mean threading "which kind of user is this"
 * through all of it.
 */
type NavItem = { name: string; tabLabel: string; href: string; icon: LucideIcon };

const NAV: NavItem[] = [
  { name: 'Dashboard', tabLabel: 'Home', href: '/portal/dashboard', icon: Home },
  { name: 'My contracts', tabLabel: 'Contracts', href: '/portal/contracts', icon: FileText },
  { name: 'Payments', tabLabel: 'Payments', href: '/portal/payments', icon: CreditCard },
  { name: 'Profile', tabLabel: 'Profile', href: '/portal/profile', icon: User },
];

function isActive(pathname: string | null, href: string) {
  return pathname === href || !!pathname?.startsWith(href + '/');
}

export function PortalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { companyName, logoUrl } = useOrgSettingsStore((s) => s.settings);
  const customer = useCustomerAuthStore((s) => s.customer);
  const clearAuth = useCustomerAuthStore((s) => s.clearAuth);

  function signOut() {
    clearAuth();
    router.replace('/portal/login');
  }

  return (
    <div data-print-shell className="min-h-screen flex bg-[#f7f9fc]">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex w-[264px] shrink-0 flex-col bg-white border-r border-slate-200/80 print:hidden">
        <div className="h-[68px] flex items-center gap-3 px-5 border-b border-slate-100 shrink-0">
          <CompanyLogo
            logoUrl={logoUrl}
            companyName={companyName}
            imgClassName="w-9 h-9 rounded-xl object-cover shrink-0"
            fallback={
              <div className="w-9 h-9 rounded-xl bg-primary flex items-center justify-center shrink-0 shadow-sm shadow-blue-900/20">
                <span className="text-white text-[11px] font-extrabold tracking-tighter">{companyInitials(companyName)}</span>
              </div>
            }
          />
          <div className="leading-none min-w-0">
            <p className="font-heading text-[14px] font-extrabold text-slate-900 tracking-tight truncate">{companyName}</p>
            <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-widest mt-1">Customer Portal</p>
          </div>
        </div>

        <div className="px-5 py-4 border-b border-slate-100">
          <p className="text-sm font-semibold text-slate-800 truncate">{customer?.firstName} {customer?.lastName}</p>
          <p className="text-[11px] text-slate-400 font-mono mt-1 truncate">{customer?.membershipId}</p>
        </div>

        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition-all',
                  active ? 'bg-blue-50 text-primary shadow-sm' : 'text-slate-500 hover:text-slate-900 hover:bg-slate-50',
                )}
              >
                <item.icon className={cn('h-[18px] w-[18px] shrink-0', active ? 'text-primary' : 'text-slate-400')} />
                <span className="flex-1 truncate">{item.name}</span>
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t border-slate-100">
          <button
            onClick={signOut}
            className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold text-slate-500 hover:text-slate-900 hover:bg-slate-50 transition-colors"
          >
            <LogOut className="h-[18px] w-[18px] shrink-0 text-slate-400" />
            Sign out
          </button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div data-print-flow className="flex-1 flex flex-col min-w-0">
        <header className="lg:hidden print:hidden h-[60px] flex items-center justify-between gap-3 px-4 bg-white border-b border-slate-200/80">
          <div className="flex items-center gap-2.5 min-w-0">
            <CompanyLogo
              logoUrl={logoUrl}
              companyName={companyName}
              imgClassName="w-7 h-7 rounded-lg object-cover shrink-0"
              fallback={
                <div className="w-7 h-7 rounded-lg bg-primary flex items-center justify-center shrink-0">
                  <span className="text-white text-[11px] font-extrabold tracking-tighter">{companyInitials(companyName)}</span>
                </div>
              }
            />
            <div className="leading-none min-w-0">
              <p className="text-[13px] font-extrabold text-gray-900 truncate">{companyName}</p>
              <p className="text-[9px] text-gray-400 uppercase tracking-widest mt-0.5">Customer Portal</p>
            </div>
          </div>
          <button onClick={signOut} className="text-gray-400 hover:text-gray-600" aria-label="Sign out">
            <LogOut className="h-5 w-5" />
          </button>
        </header>

        {/* pb-20 leaves room for the bottom tab bar */}
        <main data-print-flow className="flex-1 overflow-auto p-4 sm:p-6 lg:p-8 pb-20 lg:pb-8 print:p-0">
          <div className="mx-auto w-full max-w-5xl">{children}</div>
        </main>
      </div>

      {/* Mobile bottom tabs */}
      <nav className="lg:hidden print:hidden fixed bottom-0 inset-x-0 z-40 bg-white border-t border-gray-200">
        <div className="flex items-stretch h-16">
          {NAV.map((tab) => {
            const active = isActive(pathname, tab.href);
            return (
              <Link key={tab.href} href={tab.href} className="flex-1 flex items-center justify-center">
                <span
                  className={cn(
                    'flex flex-col items-center justify-center gap-1 rounded-2xl px-4 py-1.5 transition-colors',
                    active ? 'bg-primary/10 text-primary' : 'text-gray-400 hover:text-gray-600',
                  )}
                >
                  <tab.icon className="h-5 w-5" strokeWidth={active ? 2.5 : 1.75} />
                  <span className="text-[10px] font-semibold leading-none">{tab.tabLabel}</span>
                </span>
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
