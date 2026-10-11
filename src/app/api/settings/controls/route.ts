import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { getControlSettings, updateControlSettings, validateControlSettings, type ControlSettingsData } from '@/lib/services/controlSettingsService';
import { normalizeGhanaPhone } from '@/lib/constants/customers';
import { sendOwnerSms } from '@/lib/services/ownerNotificationService';
import { logAudit } from '@/lib/services/auditService';

/** The owner's controls: second approval, the owner's number, and the notification switches. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;
  return NextResponse.json({ settings: await getControlSettings() });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const error = validateControlSettings(body);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const before = await getControlSettings();
  const ownerPhone = typeof body.ownerPhone === 'string' && body.ownerPhone.trim() ? normalizeGhanaPhone(body.ownerPhone) : null;
  await updateControlSettings({ ...(body as unknown as ControlSettingsData), ownerPhone, updatedById: auth.user.id });
  const settings = await getControlSettings();
  await logAudit({ userId: auth.user.id, action: 'SETTINGS_UPDATE', entityType: 'ControlSettings', entityId: 'singleton', oldValues: before, newValues: settings });

  // A number is only useful if messages reach it: say so now, not at the first alert.
  if (settings.ownerPhone && settings.ownerPhone !== before.ownerPhone) {
    await sendOwnerSms('owner.alert', 'This number will now receive alerts and the daily summary from your hire purchase system.');
  }
  return NextResponse.json({ settings });
}
