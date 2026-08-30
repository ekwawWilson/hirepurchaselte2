import type { MetadataRoute } from 'next';
import { getOrgSettings } from '@/lib/services/orgSettingsService';
import { APP_NAME } from '@/lib/constants/branding';

// force-dynamic: reflects whatever company name a tenant has set on the
// Settings page (same DB-backed source layout.tsx's tab title uses), rather
// than freezing it into a static build artifact.
export const dynamic = 'force-dynamic';

export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { companyName } = await getOrgSettings();
  const name = companyName === APP_NAME ? APP_NAME : `${companyName} · ${APP_NAME}`;

  return {
    name,
    short_name: companyName === APP_NAME ? APP_NAME : companyName,
    description: 'Hire-purchase management system',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1e3a8a',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
