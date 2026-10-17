import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { getCommissionSettingsView, updateCommissionSettings, validateCommissionSettingsBody } from '@/lib/services/commissionSettingsService';
import { logAudit } from '@/lib/services/auditService';

/** The default agent commission and each product category's own amount. */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  return NextResponse.json({ settings: await getCommissionSettingsView() });
}

/** Body: { fixedCommissionMinor, categoryRates?: [{ categoryId, commissionMinor | null }] } — null puts a category back on the default. */
export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const error = await validateCommissionSettingsBody(body);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const before = await getCommissionSettingsView();
  await updateCommissionSettings({
    fixedCommissionMinor: body.fixedCommissionMinor as number,
    categoryRates: body.categoryRates as { categoryId: string; commissionMinor: number | null }[] | undefined,
    updatedById: auth.user.id,
  });
  const settings = await getCommissionSettingsView();
  await logAudit({ userId: auth.user.id, action: 'SETTINGS_UPDATE', entityType: 'CommissionSettings', entityId: 'singleton', oldValues: before, newValues: settings });
  return NextResponse.json({ settings });
}
