import type { Metadata } from 'next';
import { getOrgSettings } from '@/lib/services/orgSettingsService';

/**
 * Makes the customer portal its own installable app: its own manifest (start
 * page, scope, name) in place of the staff app's.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { companyName } = await getOrgSettings();
  return {
    title: `${companyName} · Customer Portal`,
    manifest: '/portal/manifest.webmanifest',
    appleWebApp: { capable: true, title: companyName, statusBarStyle: 'default' },
  };
}

export default function PortalRootLayout({ children }: { children: React.ReactNode }) {
  return children;
}
