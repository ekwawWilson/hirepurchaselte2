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
    <nav className="lg:hidden fixed bottom-0 inset-x-0 z-40 h-16 bg-white border-t border-gray-200 shadow-[0_-1px_12px_rgba(0,0,0,0.08)] flex items-stretch safe-area-bottom">
      {tabs.map((tab) => {
        const active = !moreOpen && (pathname === tab.href || pathname?.startsWith(tab.href + '/'));
        return (
          <Link
            key={tab.href}
            href={tab.href}
            onClick={() => moreOpen && onMoreToggle()}
            className="flex-1 flex flex-col items-center justify-center gap-1 relative"
          >
            {active && <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-primary rounded-t-full" />}
            <tab.icon className={cn('h-5 w-5', active ? 'text-primary' : 'text-gray-400')} strokeWidth={active ? 2.5 : 1.75} />
            <span className={cn('text-[10px] font-semibold', active ? 'text-primary' : 'text-gray-400')}>{tab.name}</span>
          </Link>
        );
      })}
      <button type="button" onClick={onMoreToggle} className="flex-1 flex flex-col items-center justify-center gap-1 relative">
        {moreOpen && <span className="absolute bottom-0 left-1/2 -translate-x-1/2 w-8 h-0.5 bg-primary rounded-t-full" />}
        <MoreHorizontal className={cn('h-5 w-5', moreOpen ? 'text-primary' : 'text-gray-400')} />
        <span className={cn('text-[10px] font-medium', moreOpen ? 'text-primary' : 'text-gray-500')}>More</span>
      </button>
    </nav>
  );
}
