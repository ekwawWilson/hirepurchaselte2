'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { MoreHorizontal } from 'lucide-react';
import { useAuthStore } from '@/lib/authStore';
import { primaryMobileItems } from '@/lib/navigation';
import { cn } from '@/lib/utils';

/**
 * Mobile nav: a fixed bottom tab bar (4 primary items + "More"), not a side
 * drawer — modeled on the legacy hirepurchase app's own mobile pattern rather
 * than the drawer this project used before (docs/01-plan.md). Desktop
 * (`lg:` and up) still uses AppSidebar; this only ever renders below that
 * breakpoint.
 */
export function MobileTabBar({ moreOpen, onMoreToggle }: { moreOpen: boolean; onMoreToggle: () => void }) {
  const pathname = usePathname();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const tabs = primaryMobileItems.filter((t) => !t.perms?.length || hasPermission(...t.perms));

  return (
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 h-[68px] bg-white/95 backdrop-blur border-t border-slate-200/80 shadow-[0_-8px_24px_-18px_rgba(15,23,42,0.28)] flex items-stretch safe-area-bottom">
      {tabs.map((tab) => {
        const active = !moreOpen && (pathname === tab.href || pathname?.startsWith(tab.href + '/'));
        return (
          <Link
            key={tab.href}
            href={tab.href}
            onClick={() => moreOpen && onMoreToggle()}
            className="flex-1 flex items-center justify-center"
          >
            <span className={cn('flex flex-col items-center justify-center gap-1 rounded-2xl px-4 py-1.5 transition-colors', active && 'bg-blue-50')}>
              <tab.icon className={cn('h-5 w-5', active ? 'text-primary' : 'text-slate-400')} strokeWidth={active ? 2.5 : 1.75} />
              <span className={cn('text-[10px] font-semibold', active ? 'text-primary' : 'text-slate-400')}>{tab.name}</span>
            </span>
          </Link>
        );
      })}
      <button type="button" onClick={onMoreToggle} className="flex-1 flex items-center justify-center">
        <span className={cn('flex flex-col items-center justify-center gap-1 rounded-2xl px-4 py-1.5 transition-colors', moreOpen && 'bg-blue-50')}>
          <MoreHorizontal className={cn('h-5 w-5', moreOpen ? 'text-primary' : 'text-slate-400')} />
          <span className={cn('text-[10px] font-semibold', moreOpen ? 'text-primary' : 'text-slate-400')}>More</span>
        </span>
      </button>
    </nav>
  );
}
