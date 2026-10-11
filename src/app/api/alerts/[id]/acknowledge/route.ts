import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import { acknowledgeAlert } from '@/lib/services/alertService';
import { logAudit } from '@/lib/services/auditService';

/** Clears an alert from the dashboard. If the fault is still there, it opens again the next time it happens. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, 'settings.manage');
  if (!perm.authorized) return perm.error;

  const { id } = await params;
  const alert = await prisma.systemAlert.findUnique({ where: { id } });
  if (!alert) return NextResponse.json({ error: 'Alert not found' }, { status: 404 });

  await acknowledgeAlert(id);
  await logAudit({ userId: auth.user.id, action: 'ALERT_ACKNOWLEDGE', entityType: 'SystemAlert', entityId: id, newValues: { kind: alert.kind, message: alert.message } });
  return NextResponse.json({ ok: true });
}
