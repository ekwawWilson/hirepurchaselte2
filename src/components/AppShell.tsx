'use client';

import { ReactNode, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/lib/authStore';
import AppSidebar from './AppSidebar';
import AppTopBar from './AppTopBar';

export function AppShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, hydrate, isHydrated } = useAuthStore();
  const [checked, setChecked] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

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
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden bg-gray-50">
      <AppSidebar mobileOpen={mobileNavOpen} onMobileClose={() => setMobileNavOpen(false)} />

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <AppTopBar onMenuToggle={() => setMobileNavOpen((o) => !o)} />

        <main className="flex-1 overflow-y-auto">
          <div className="page-shell mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-4 sm:py-6">{children}</div>
        </main>
      </div>
    </div>
  );
}
