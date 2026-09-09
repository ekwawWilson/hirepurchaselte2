import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { getLoanSettings, updateLoanSettings, validateLoanSettingsBody } from '@/lib/services/loanSettingsService';
import { logAudit } from '@/lib/services/auditService';

export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  const settings = await getLoanSettings();
  return NextResponse.json({ settings });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  const body = (await req.json()) as Record<string, unknown>;
  const error = validateLoanSettingsBody(body);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const settings = await updateLoanSettings({
    dailyInterestRateBps: body.dailyInterestRateBps as number,
    interestGraceDays: body.interestGraceDays as number,
    updatedById: auth.user.id,
  });
  await logAudit({ userId: auth.user.id, action: 'SETTINGS_UPDATE', entityType: 'LoanSettings', entityId: settings.id, newValues: settings });
  return NextResponse.json({ settings });
}
