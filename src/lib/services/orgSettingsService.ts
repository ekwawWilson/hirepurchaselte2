import { prisma } from '../db/prisma';
import { APP_NAME, MAX_LOGO_BYTES, UPLOADABLE_LOGO_TYPES } from '../constants/branding';

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
export function parseLogoDataUrl(logoUrl: string): { contentType: string; bytes: Buffer } | null {
  const match = /^data:(image\/[a-z+.-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(logoUrl);
  if (!match) return null;
  const contentType = match[1].toLowerCase();
  if (!(UPLOADABLE_LOGO_TYPES as readonly string[]).includes(contentType)) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (detectImageType(bytes) !== contentType) return null;
  return { contentType, bytes };
}

/**
 * The real format of image bytes, from their file signature — a declared
 * content type alone isn't trusted: bytes that aren't a real image render as
 * a blank icon rather than failing.
 */
export function detectImageType(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}
