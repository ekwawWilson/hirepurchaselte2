import { prisma } from '../db/prisma';
import { parseImageDataUrl } from '../imageData';
import { APP_NAME, MAX_LOGO_BYTES, MAX_APP_ICON_BYTES, UPLOADABLE_LOGO_TYPES } from '../constants/branding';

/**
 * Always exactly one row — a single-tenant "who is this business" record
 * (company name/address/phone/email/logo) shown in the browser tab title,
 * the top navbar/sidebar, and on reports. See schema.prisma's OrgSettings
 * comment and docs/01-plan.md.
 */
const SINGLETON_ID = 'singleton';

export interface OrgSettingsData {
  companyName: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  logoUrl: string | null;
}

const DEFAULTS: OrgSettingsData = {
  companyName: APP_NAME,
  address: null,
  phone: null,
  email: null,
  logoUrl: null, // no default logo — the initials badge stands in until one is set
};

/** Never throws, never returns null — falls back to DEFAULTS before any row has ever been saved. */
export async function getOrgSettings(): Promise<OrgSettingsData> {
  const row = await prisma.orgSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) return DEFAULTS;
  return { companyName: row.companyName, address: row.address, phone: row.phone, email: row.email, logoUrl: row.logoUrl };
}

export async function updateOrgSettings(params: OrgSettingsData & { updatedById: string }) {
  return prisma.orgSettings.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...params },
    update: { ...params },
  });
}

export function validateOrgSettingsBody(body: Record<string, unknown>): string | null {
  if (typeof body.companyName !== 'string' || !body.companyName.trim()) return 'companyName is required';

  const logoUrl = typeof body.logoUrl === 'string' ? body.logoUrl.trim() : body.logoUrl;
  if (logoUrl === undefined || logoUrl === null || logoUrl === '') return null;
  if (typeof logoUrl !== 'string') return 'logoUrl must be a string';
  if (logoUrl.startsWith('data:')) {
    const logo = parseLogoDataUrl(logoUrl);
    if (!logo) return `An uploaded logo must be a ${UPLOADABLE_LOGO_TYPES.map((t) => t.replace('image/', '').toUpperCase()).join(' or ')} image`;
    if (logo.bytes.length > MAX_LOGO_BYTES) return `An uploaded logo must be ${Math.round(MAX_LOGO_BYTES / 1024)} KB or smaller`;
    return null;
  }
  if (!/^https?:\/\//i.test(logoUrl)) return 'logoUrl must be an http(s) link or an uploaded image';
  return null;
}

/**
 * Decodes a logo uploaded from Settings (stored inline as a base64 data URL).
 * Null for anything that isn't a PNG/JPEG data URL whose bytes really are
 * that format.
 */
export function parseLogoDataUrl(logoUrl: string) {
  return parseImageDataUrl(logoUrl, UPLOADABLE_LOGO_TYPES);
}

/**
 * Everything the app icons are drawn from. `version` changes whenever
 * Settings are saved, so icon URLs carrying it stop matching a stale copy an
 * installed app or browser has cached.
 */
export async function getAppIconSource() {
  const row = await prisma.orgSettings.findUnique({
    where: { id: SINGLETON_ID },
    select: { companyName: true, logoUrl: true, appIconUrl: true, updatedAt: true },
  });
  return {
    companyName: row?.companyName ?? DEFAULTS.companyName,
    logoUrl: row?.logoUrl ?? null,
    appIconUrl: row?.appIconUrl ?? null,
    version: row ? row.updatedAt.getTime().toString(36) : '0',
  };
}

/** Null if the app icon is an acceptable uploaded image, else why not. */
export function validateAppIcon(appIconUrl: string): string | null {
  const icon = parseImageDataUrl(appIconUrl, UPLOADABLE_LOGO_TYPES);
  if (!icon) return 'The app icon must be an uploaded PNG or JPEG image';
  if (icon.bytes.length > MAX_APP_ICON_BYTES) return `The app icon must be ${Math.round(MAX_APP_ICON_BYTES / 1024)} KB or smaller`;
  return null;
}

export async function setAppIcon(appIconUrl: string | null, updatedById: string) {
  return prisma.orgSettings.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...DEFAULTS, appIconUrl, updatedById },
    update: { appIconUrl, updatedById },
    select: { updatedAt: true },
  });
}
