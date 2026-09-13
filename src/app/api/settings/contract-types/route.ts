import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import {
  getContractTypeSettings, updateContractTypeSettings, validateContractTypeSettingsBody,
} from '@/lib/services/contractTypeSettingsService';
import { logAudit } from '@/lib/services/auditService';

/**
 * GET needs authentication but no particular permission — the contract
 * wizard (any user who can create contracts) has to know which types to
 * offer. Changing them requires settings.manage.
 */
export async function GET(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;

  const settings = await getContractTypeSettings();
  return NextResponse.json({ settings });
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  const body = (await req.json()) as Record<string, unknown>;
  const error = validateContractTypeSettingsBody(body);
  if (error) return NextResponse.json({ error }, { status: 400 });

  const settings = await updateContractTypeSettings({
    saveToOwnEnabled: body.saveToOwnEnabled as boolean,
    deviceLoanEnabled: body.deviceLoanEnabled as boolean,
    updatedById: auth.user.id,
  });
  await logAudit({ userId: auth.user.id, action: 'SETTINGS_UPDATE', entityType: 'ContractTypeSettings', entityId: settings.id, newValues: settings });
  return NextResponse.json({ settings });
}
