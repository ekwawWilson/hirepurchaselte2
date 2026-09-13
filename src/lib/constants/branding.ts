/**
 * Application-level default branding — shown wherever a per-tenant company
 * name (set via the Settings page, see orgSettingsService.ts) hasn't been
 * configured yet. Deliberately distinct from that per-tenant "company"
 * concept: this is the product's own identity, not any one operator's.
 * There is no default logo: the logo, favicon and install icons all come from
 * Settings, falling back to the company's initials (see app-icon/[file]).
 * No server-only imports here (no prisma) so both server and client code
 * (orgSettingsService.ts and orgSettingsStore.ts) can share one source of truth.
 */
export const APP_NAME = 'PETROS Hirepurchase';

/** Brand colour behind the initials badge — matches the manifest/viewport theme colour. */
export const APP_THEME_COLOR = '#1e3a8a';

/**
 * An uploaded logo is stored inline as a data URL (OrgSettings.logoUrl), so it
 * is capped: GET /api/settings returns it on every page load.
 */
export const MAX_LOGO_BYTES = 300 * 1024;
export const UPLOADABLE_LOGO_TYPES = ['image/png', 'image/jpeg'] as const;

/** The uploaded app icon is squared and resized to this in the browser before upload. */
export const APP_ICON_SIZE = 512;
export const MAX_APP_ICON_BYTES = 400 * 1024;
