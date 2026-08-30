import { prisma } from '../db/prisma';
import { APP_NAME, APP_LOGO_URL } from '../constants/branding';

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
  logoUrl: APP_LOGO_URL,
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
  return null;
}
