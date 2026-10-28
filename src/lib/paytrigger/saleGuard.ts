import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { actionsAreLive } from './client';

/**
 * Which phones each instalment sale may sell. A PayTrigger phone (a product
 * an admin marked as TECNO, Infinix or itel) is sold only on Device
 * Financing, so it is never handed over without its lock; Device Financing
 * sells only such phones, and only once enrolled. A phone enrolled after the
 * customer has set it up only takes the lock after a factory reset, which is
 * why the check is made before the sale, not after.
 */

/** Enrolment states a phone can be sold in. */
const SELLABLE_ENROLMENT = ['QUEUED', 'ACTIVE'];
/** Log entries that prove an enrolment really reached PayTrigger (not a dry run). */
export const LIVE_ENROLMENT_PROOF = ['ENROL', 'VERIFY', 'CALLBACK_ACTIVATED'];

/** The devices among `deviceIds` whose enrolment PayTrigger has really accepted. */
export async function devicesEnrolledLive(deviceIds: string[]): Promise<Set<string>> {
  if (deviceIds.length === 0) return new Set();
  const proofs = await prisma.payTriggerActionLog.findMany({
    where: { deviceId: { in: deviceIds }, action: { in: LIVE_ENROLMENT_PROOF }, success: true, dryRun: false },
    select: { deviceId: true },
    distinct: ['deviceId'],
  });
  return new Set(proofs.map((p) => p.deviceId!));
}

async function enrolmentProblem(inventoryItemId: string): Promise<string | null> {
  const device = await prisma.payTriggerDevice.findUnique({ where: { inventoryItemId } });
  if (!device || !SELLABLE_ENROLMENT.includes(device.enrollmentStatus)) {
    const state = device ? ` (its enrolment is ${device.enrollmentStatus.toLowerCase()}${device.lastError ? `: ${device.lastError}` : ''})` : '';
    return `This phone is not enrolled with PayTrigger${state}. Enrol it first under PayTrigger > Enrolment, before it is switched on.`;
  }
  if (actionsAreLive() && !(await devicesEnrolledLive([device.id])).has(device.id)) {
    return 'This phone was only enrolled while PayTrigger was in dry run. Enrol it again, now that it is live, before selling it.';
  }
  return null;
}

/**
 * Null if `contractType` may sell this unit, else why not. For Deposit +
 * Instalment the check fails open (an error is logged and the sale goes
 * ahead), so PayTrigger trouble can never stop an ordinary sale; for Device
 * Financing it fails closed, since the lock is the point of the sale.
 */
export async function payTriggerSaleProblem(contractType: string, item: { id: string; productId: string }): Promise<string | null> {
  if (contractType !== 'DEPOSIT_INSTALMENT' && contractType !== 'DEVICE_FINANCING') return null;
  if (contractType === 'DEPOSIT_INSTALMENT') {
    try {
      const marked = await prisma.payTriggerProduct.findUnique({ where: { productId: item.productId } });
      return marked ? `This is a PayTrigger phone (${marked.brand}): sell it on Device Financing, so it is locked if payments stop.` : null;
    } catch (e) {
      console.error('[paytrigger] sale check failed (sale allowed):', e instanceof Error ? e.message : e);
      return null;
    }
  }
  const marked = await prisma.payTriggerProduct.findUnique({ where: { productId: item.productId } });
  if (!marked) return 'Device Financing is only for TECNO, Infinix and itel phones marked as PayTrigger phones (PayTrigger > Products).';
  return enrolmentProblem(item.id);
}

/**
 * What the new-contract wizard lists for each instalment sale: only enrolled
 * PayTrigger phones for Device Financing, and everything but PayTrigger
 * phones for Deposit + Instalment. Null for any other type: no filter.
 */
export async function saleTypeInventoryWhere(saleType: string | null): Promise<Prisma.InventoryItemWhereInput | null> {
  if (saleType !== 'DEPOSIT_INSTALMENT' && saleType !== 'DEVICE_FINANCING') return null;
  const markedProductIds = (await prisma.payTriggerProduct.findMany({ select: { productId: true } })).map((p) => p.productId);
  if (saleType === 'DEPOSIT_INSTALMENT') return { productId: { notIn: markedProductIds } };
  const enrolled = await prisma.payTriggerDevice.findMany({ where: { enrollmentStatus: { in: SELLABLE_ENROLMENT } }, select: { id: true, inventoryItemId: true } });
  const live = actionsAreLive() ? await devicesEnrolledLive(enrolled.map((d) => d.id)) : null;
  return {
    productId: { in: markedProductIds },
    id: { in: enrolled.filter((d) => !live || live.has(d.id)).map((d) => d.inventoryItemId) },
  };
}
