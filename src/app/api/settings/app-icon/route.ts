import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { setAppIcon, validateAppIcon } from '@/lib/services/orgSettingsService';
import { logAudit } from '@/lib/services/auditService';

/**
 * Sets or clears the uploaded app icon. Its own endpoint rather than a field
 * on PATCH /api/settings: that response is loaded by every page, and an icon
 * of a few hundred KB has no business riding along with it.
 */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  const { appIconUrl } = (await req.json().catch(() => ({}))) as { appIconUrl?: string | null };
  const icon = appIconUrl?.trim() || null;
  if (icon) {
    const error = validateAppIcon(icon);
    if (error) return NextResponse.json({ error }, { status: 400 });
  }

  const { updatedAt } = await setAppIcon(icon, auth.user.id);
  await logAudit({
    userId: auth.user.id, action: 'SETTINGS_APP_ICON_UPDATE', entityType: 'OrgSettings', entityId: 'singleton',
    newValues: { appIcon: icon ? '(uploaded image)' : null },
  });
  return NextResponse.json({ ok: true, version: updatedAt.getTime().toString(36) });
}
