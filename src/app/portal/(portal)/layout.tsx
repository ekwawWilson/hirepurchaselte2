'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
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
  const pathname = usePathname();
  const { customer, token, isHydrated, hydrate } = useCustomerAuthStore();
  const loadOrgSettings = useOrgSettingsStore((s) => s.load);

  useEffect(() => {
    hydrate();
    loadOrgSettings();
  }, [hydrate, loadOrgSettings]);

  // Still on the one-time password staff issued: the server opens nothing but
  // the change of password (customerAuth.ts), so that is the only page to show.
  const mustChangePassword = !!customer?.mustChangePassword && pathname !== '/portal/profile';

  useEffect(() => {
    if (isHydrated && !token) router.replace('/portal/login');
    else if (mustChangePassword) router.replace('/portal/profile');
  }, [isHydrated, token, mustChangePassword, router]);

  if (!isHydrated || !token || !customer || mustChangePassword) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#f5f0eb]">
        <div className="h-10 w-10 border-2 border-gray-300 border-t-primary rounded-full animate-spin" />
      </div>
    );
  }

  return <PortalShell>{children}</PortalShell>;
}
