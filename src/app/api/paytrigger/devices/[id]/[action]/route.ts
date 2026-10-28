import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, requirePermission } from '@/lib/auth/rbac';
import type { Permission } from '@/lib/constants/rbac';
import { prisma } from '@/lib/db/prisma';
import { reconcileContract } from '@/lib/paytrigger/reconcile';
import {
  verifyDevice, cancelEnrolment, setReleaseHeld, sendPhoneMessage, issueOfflinePin, releaseDevice, PayTriggerError,
} from '@/lib/paytrigger/admin';

/** Who may do what to a phone. Removing a lock cannot be undone, so it needs the strongest permission. */
const ACTIONS: Record<string, Permission> = {
  reconcile: 'paytrigger.manage',
  verify: 'paytrigger.manage',
  message: 'paytrigger.manage',
  'cancel-enrolment': 'paytrigger.manage',
  'hold-release': 'paytrigger.manage',
  pin: 'paytrigger.pin',
  release: 'paytrigger.release',
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; action: string }> }) {
  const { id, action } = await params;
  const permission = ACTIONS[action];
  if (!permission) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  const auth = await requireAuth(req);
  if ('error' in auth) return auth.error;
  const perm = requirePermission(auth.user, permission);
  if (!perm.authorized) return perm.error;
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const userId = auth.user.id;

  try {
    switch (action) {
      case 'reconcile': {
        const device = await prisma.payTriggerDevice.findUnique({ where: { id } });
        if (!device) return NextResponse.json({ error: 'PayTrigger device not found' }, { status: 404 });
        if (!device.contractId) return NextResponse.json({ error: 'This phone has no contract to reconcile' }, { status: 400 });
        return NextResponse.json({ outcome: await reconcileContract(device.contractId, { reasons: ['ADMIN'], actorId: userId, force: body.force === true }) });
      }
      case 'verify':
        return NextResponse.json(await verifyDevice(id, userId));
      case 'message': {
        const pushType = body.pushType === 2 ? 2 : 1;
        return NextResponse.json(await sendPhoneMessage(id, { title: String(body.title ?? ''), content: String(body.content ?? ''), pushType }, userId));
      }
      case 'cancel-enrolment':
        await cancelEnrolment(id, userId);
        return NextResponse.json({ ok: true });
      case 'hold-release':
        await setReleaseHeld(id, body.held !== false, userId);
        return NextResponse.json({ ok: true });
      case 'pin':
        return NextResponse.json(await issueOfflinePin(id, userId, typeof body.key === 'string' && body.key.trim() ? body.key.trim() : undefined));
      case 'release':
        // Uninstalls PayTrigger from the phone: typed out, not a single click.
        if (body.confirm !== 'RELEASE') return NextResponse.json({ error: 'Type RELEASE to confirm: removing the lock cannot be undone' }, { status: 400 });
        return NextResponse.json(await releaseDevice(id, userId));
    }
  } catch (e) {
    if (e instanceof PayTriggerError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}
