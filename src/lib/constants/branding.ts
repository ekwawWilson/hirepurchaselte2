/**
 * Application-level default branding — shown wherever a per-tenant company
 * name/logo (set via the Settings page, see orgSettingsService.ts) hasn't
 * been configured yet. Deliberately distinct from that per-tenant "company"
 * concept: this is the product's own identity, not any one operator's.
 * No server-only imports here (no prisma) so both server and client code
 * (orgSettingsService.ts and orgSettingsStore.ts) can share one source of truth.
 */
export const APP_NAME = 'PETROS Hirepurchase';
export const APP_LOGO_URL = '/eyo.jpeg';
