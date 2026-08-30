'use client';

import { ReactNode, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/authStore';
import { useOrgSettingsStore } from '@/lib/orgSettingsStore';
import AppSidebar from './AppSidebar';
import AppTopBar from './AppTopBar';
import { MobileTabBar } from './MobileTabBar';
import { MoreSheet } from './MoreSheet';

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, hydrate, isHydrated } = useAuthStore();
  const loadOrgSettings = useOrgSettingsStore((s) => s.load);
  const [checked, setChecked] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  useEffect(() => {
    hydrate();
    loadOrgSettings();
  }, [hydrate, loadOrgSettings]);

  useEffect(() => {
    if (!isHydrated) return;
    if (!user) {
      router.replace('/login');
    } else {
      setChecked(true);
    }
  }, [isHydrated, user, router]);

  if (!checked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <AppSidebar />

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <AppTopBar />

        {/* pb-16 clears the fixed mobile tab bar; lg:pb-0 since desktop has no bottom bar */}
        <main className="flex-1 overflow-y-auto surface-grid pb-16 lg:pb-0">
          <div className="page-shell mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-4 sm:py-6">{children}</div>
        </main>
      </div>

      <MobileTabBar moreOpen={moreOpen} onMoreToggle={() => setMoreOpen((o) => !o)} />
      <MoreSheet open={moreOpen} onClose={() => setMoreOpen(false)} />
    </div>
  );
}
