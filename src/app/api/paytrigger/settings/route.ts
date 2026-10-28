import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { getPayTriggerSettings, updatePayTriggerSettings, validatePayTriggerSettings, MESSAGE_PLACEHOLDERS } from '@/lib/paytrigger/settings';
import { logAudit } from '@/lib/services/auditService';

/** When phones lock and what their lock screens say (Settings > PayTrigger). */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'paytrigger.view');
  if (!perm.authorized) return perm.error;
  return NextResponse.json({ settings: await getPayTriggerSettings(), placeholders: MESSAGE_PLACEHOLDERS });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const error = validatePayTriggerSettings(body);
  if (error) return NextResponse.json({ error }, { status: 400 });
  const before = await getPayTriggerSettings();
  const settings = await updatePayTriggerSettings(body, auth.user.id);
  await logAudit({ userId: auth.user.id, action: 'SETTINGS_UPDATE', entityType: 'PayTriggerSettings', entityId: 'singleton', oldValues: before, newValues: settings });
  return NextResponse.json({ settings, placeholders: MESSAGE_PLACEHOLDERS });
}
