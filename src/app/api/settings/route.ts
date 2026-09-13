import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { getOrgSettings, updateOrgSettings, validateOrgSettingsBody } from '@/lib/services/orgSettingsService';
import { logAudit } from '@/lib/services/auditService';

/**
 * Deliberately public (no requireAuth) — the browser tab title, the login
 * screen, and the top navbar all need the company name/logo before a user
 * has signed in. None of these fields (name/address/phone/email/logo) are
 * sensitive; they're the business's own public-facing details.
 */
export async function GET() {
  const settings = await getOrgSettings();
  return NextResponse.json({ settings });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  const body = (await req.json()) as Record<string, unknown>;
  const error = validateOrgSettingsBody(body);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const settings = await updateOrgSettings({
    companyName: (body.companyName as string).trim(),
    address: ((body.address as string) ?? '').trim() || null,
    phone: ((body.phone as string) ?? '').trim() || null,
    email: ((body.email as string) ?? '').trim() || null,
    logoUrl: ((body.logoUrl as string) ?? '').trim() || null,
    updatedById: auth.user.id,
  });
  // An uploaded logo is a data URL of up to a few hundred KB — noted, not copied, in the audit trail.
  const auditedLogo = settings.logoUrl?.startsWith('data:') ? '(uploaded image)' : settings.logoUrl;
  await logAudit({ userId: auth.user.id, action: 'SETTINGS_UPDATE', entityType: 'OrgSettings', entityId: settings.id, newValues: { ...settings, logoUrl: auditedLogo } });
  return NextResponse.json({ settings });
}
