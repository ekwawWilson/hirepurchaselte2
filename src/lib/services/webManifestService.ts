import type { MetadataRoute } from 'next';
import { getAppIconSource } from './orgSettingsService';
import { APP_NAME, APP_THEME_COLOR } from '../constants/branding';

/**
 * The web app manifest for one of the two installable apps — the staff app
 * (start /) and the customer portal (start /portal). Both take their name and
 * icons from Settings. Icon URLs carry the settings version, so after a new
 * icon is uploaded browsers fetch it rather than keep their cached copy.
 */
export async function buildWebManifest(app: 'staff' | 'portal'): Promise<MetadataRoute.Manifest> {
  const { companyName, version } = await getAppIconSource();
  const isDefault = companyName === APP_NAME;
  const icon = (file: string) => `/app-icon/${file}?v=${version}`;

  const icons: MetadataRoute.Manifest['icons'] = [
    { src: icon('icon-192.png'), sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: icon('icon-512.png'), sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: icon('icon-512-maskable.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ];

  if (app === 'portal') {
    return {
      // A separate identity and scope from the staff app, so a customer's
      // installed portal is its own app and never opens staff pages.
      id: '/portal',
      name: `${companyName} Customer Portal`,
      short_name: isDefault ? 'My Account' : companyName,
      description: 'Check your contracts and balance, and pay by mobile money',
      start_url: '/portal/dashboard',
      scope: '/portal/',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#f5f0eb',
      theme_color: APP_THEME_COLOR,
      icons,
    };
  }

  return {
    // Explicit, stable app identity — without it, browsers fall back to
    // start_url for identity, which is more fragile across an
    // uninstall/reinstall cycle.
    id: '/',
    name: isDefault ? APP_NAME : `${companyName} · ${APP_NAME}`,
    short_name: isDefault ? APP_NAME : companyName,
    description: 'Hire-purchase management system',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: APP_THEME_COLOR,
    icons,
    shortcuts: [
      { name: 'Customers', url: '/customers', icons: [{ src: icon('icon-192.png'), sizes: '192x192' }] },
      { name: 'Contracts', url: '/contracts', icons: [{ src: icon('icon-192.png'), sizes: '192x192' }] },
    ],
  };
}
