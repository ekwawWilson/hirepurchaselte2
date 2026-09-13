'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useCustomerAuthStore } from '@/lib/customerAuthStore';
import { useOrgSettingsStore } from '@/lib/orgSettingsStore';
import { PortalShell } from '@/components/portal/PortalShell';

/**
 * Guards every portal page: no session, back to the sign-in screen. The
 * server checks the token again on each request (customerAuth.ts) — this
 * only avoids rendering a page that would come back empty.
 */
export default function PortalLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { customer, token, isHydrated, hydrate } = useCustomerAuthStore();
  const loadOrgSettings = useOrgSettingsStore((s) => s.load);

  useEffect(() => {
    hydrate();
    loadOrgSettings();
  }, [hydrate, loadOrgSettings]);

  useEffect(() => {
    if (isHydrated && !token) router.replace('/portal/login');
  }, [isHydrated, token, router]);

  if (!isHydrated || !token || !customer) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f5f0eb]">
        <div className="h-10 w-10 border-2 border-gray-300 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return <PortalShell>{children}</PortalShell>;
}
