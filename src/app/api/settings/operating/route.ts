import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { getOperatingSettings, updateOperatingSettings, validateOperatingSettingsBody } from '@/lib/services/operatingSettingsService';
import { logAudit } from '@/lib/services/auditService';

/**
 * GET needs authentication but no particular permission — the contract
 * wizard's schedule preview (any cashier/sales user) has to know which days
 * are working days to show the same due dates the server will actually
 * generate. Which days the business opens isn't sensitive; changing them is,
 * hence settings.manage on PATCH only.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const settings = await getOperatingSettings();
  return NextResponse.json({ settings });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  const body = (await req.json()) as Record<string, unknown>;
  const error = validateOperatingSettingsBody(body);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const settings = await updateOperatingSettings({
    worksSaturday: body.worksSaturday as boolean,
    worksSunday: body.worksSunday as boolean,
    updatedById: auth.user.id,
  });
  await logAudit({ userId: auth.user.id, action: 'SETTINGS_UPDATE', entityType: 'OperatingSettings', entityId: settings.id, newValues: settings });
  return NextResponse.json({ settings });
}
