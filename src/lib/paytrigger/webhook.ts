import { createHash } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { payTriggerConfig, verifyCallbackSignature } from './client';
import { applyReportedState, logAction, reconcileContract, syncLockText } from './reconcile';
import { registryRemove } from './notify';

/**
 * PayTrigger's callbacks (API doc §5): it posts here when a phone is
 * activated, locks or unlocks (notifyType 1000), has its lock removed
 * (2000), or refused a strong restriction (4000), and keeps re-sending until
 * it is answered `{ code: 200 }`. So every callback is answered 200 at once,
 * kept first (de-duplicated by a hash of its body) and processed after.
 */

export interface CallbackBody {
  notifyType?: number;
  imei?: string;
  deviceTag?: string;
  orderNum?: string;
  state?: number;
  serverState?: number;
  mobileStatus?: number;
  expiration?: number;
  activeTime?: number;
  tip?: string;
}

/**
 * Keeps a callback. Returns the id of an event to process, or null: an
 * unsigned or wrongly signed one is kept with its error and not processed,
 * and a repeat of one already processed is ignored.
 */
export async function spoolCallback(body: Record<string, unknown>, signHeader: string | null): Promise<string | null> {
  const dedupeKey = createHash('sha256').update(JSON.stringify(body)).digest('hex');
  const notifyType = String(body.notifyType ?? 'unknown');
  const apiKey = payTriggerConfig().apiKey;
  const signed = !!apiKey && verifyCallbackSignature(body, signHeader, apiKey);

  const existing = await prisma.payTriggerWebhookEvent.findUnique({ where: { dedupeKey } });
  if (!signed) {
    if (!existing) {
      await prisma.payTriggerWebhookEvent.create({
        data: { dedupeKey, notifyType, body: body as Prisma.InputJsonValue, error: apiKey ? 'Signature check failed' : 'Signature check failed: PAYTRIGGER_API_KEY is not set' },
      }).catch(() => undefined); // a concurrent identical copy already kept it
    }
    return null;
  }
  if (existing) return existing.processedAt ? null : existing.id;
  try {
    const event = await prisma.payTriggerWebhookEvent.create({ data: { dedupeKey, notifyType, body: body as Prisma.InputJsonValue } });
    return event.id;
  } catch {
    return null; // a concurrent identical copy is being processed
  }
}

export async function processCallbackEvent(eventId: string): Promise<void> {
  const event = await prisma.payTriggerWebhookEvent.findUnique({ where: { id: eventId } });
  if (!event || event.processedAt) return;
  const body = event.body as CallbackBody;
  try {
    const device = (body.imei ? await prisma.payTriggerDevice.findUnique({ where: { imei: body.imei } }) : null)
      ?? (body.deviceTag ? await prisma.payTriggerDevice.findFirst({ where: { deviceTag: body.deviceTag } }) : null);
    if (!device) throw new Error(`No enrolled phone with IMEI ${body.imei || '-'} or device tag ${body.deviceTag || '-'}`);

    let action = `CALLBACK_${body.notifyType}`;
    if (body.notifyType === 1000) {
      const { activatedNow } = await applyReportedState(device, {
        lockState: body.state, serverState: body.serverState, mobileStatus: body.mobileStatus, deviceTag: body.deviceTag,
      });
      if (activatedNow) {
        action = 'CALLBACK_ACTIVATED';
        // First switch-on: the phone locked itself. Give it its contract's real
        // date (and lock-screen text), or the "no contract" text if unsold.
        const fresh = await prisma.payTriggerDevice.findUniqueOrThrow({ where: { id: device.id } });
        if (fresh.contractId) await reconcileContract(fresh.contractId, { reasons: ['CONTRACT_CHANGED'], force: true });
        else await syncLockText(fresh, null, null);
      }
    } else if (body.notifyType === 2000) {
      await prisma.payTriggerDevice.update({
        where: { id: device.id },
        data: { enrollmentStatus: 'REMOVED', committedState: 'UNLOCKED', awaitingPinSince: null, lastStatusReadAt: new Date() },
      });
      if (device.contractId) registryRemove(device.contractId);
    } else if (body.notifyType === 4000) {
      await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { lastError: `PayTrigger: ${body.tip ?? 'a strong restriction did not take effect'}`.slice(0, 500) } });
    }
    // A callback is always real, whatever the dry-run switch says: proof of a live enrolment.
    await logAction({ deviceId: device.id, contractId: device.contractId, action, success: true, response: body, dryRun: false });
    await prisma.payTriggerWebhookEvent.update({ where: { id: event.id }, data: { processedAt: new Date(), error: null } });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.payTriggerWebhookEvent.update({ where: { id: event.id }, data: { error: message.slice(0, 500) } });
    console.error(`[paytrigger] callback ${event.id} could not be processed: ${message}`);
  }
}
