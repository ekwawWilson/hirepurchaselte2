import type { PayTriggerDevice } from '@prisma/client';
import { prisma } from '../db/prisma';
import { logAudit } from '../services/auditService';
import { PAYTRIGGER_PATHS, payTriggerAction, payTriggerRead, payTriggerConfig, actionsAreLive, jsonList, type PayTriggerResult } from './client';
import { getPayTriggerSettings } from './settings';
import { registryRemove } from './notify';
import { applyReportedState, logAction, reconcileContract, syncLockText, ENFORCED_STATES } from './reconcile';
import { devicesEnrolledLive } from './saleGuard';

/**
 * What staff do by hand (PayTrigger pages): mark which products are
 * Transsion phones, enrol stock, check an enrolment, issue an offline PIN,
 * remove a lock for good, and see what needs attention.
 */

export class PayTriggerError extends Error {}

export const TRANSSION_BRANDS = ['TECNO', 'INFINIX', 'ITEL'] as const;
const TRANSSION_NAME = /\b(tecno|infinix|itel)\b/i;
const IMEI = /^\d{15,18}$/;
/** PayTrigger's own limit on offline PIN unlocks per phone (Introduction Manual 6.1). */
export const MAX_PIN_UNLOCKS = 4;

async function deviceOrThrow(deviceId: string): Promise<PayTriggerDevice> {
  const device = await prisma.payTriggerDevice.findUnique({ where: { id: deviceId } });
  if (!device) throw new PayTriggerError('PayTrigger device not found');
  return device;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

/** Every product, with whether it is marked as a Transsion phone, and a suggestion from its name or brand. */
export async function listProducts() {
  const [products, marked] = await Promise.all([
    prisma.product.findMany({ where: { isActive: true }, select: { id: true, name: true, brand: true, model: true, sku: true }, orderBy: { name: 'asc' } }),
    prisma.payTriggerProduct.findMany(),
  ]);
  const byProduct = new Map(marked.map((m) => [m.productId, m]));
  return products.map((p) => {
    const match = `${p.brand ?? ''} ${p.name} ${p.model ?? ''}`.match(TRANSSION_NAME);
    return {
      ...p,
      payTriggerBrand: byProduct.get(p.id)?.brand ?? null,
      suggestedBrand: !byProduct.has(p.id) && match ? match[1].toUpperCase() : null,
    };
  });
}

/** Marks (brand) or unmarks (null) a product as a Transsion phone. Never inferred from a name. */
export async function setProductBrand(productId: string, brand: string | null, actorId: string) {
  if (brand !== null && !(TRANSSION_BRANDS as readonly string[]).includes(brand)) throw new PayTriggerError(`brand must be one of ${TRANSSION_BRANDS.join(', ')}`);
  if (!(await prisma.product.findUnique({ where: { id: productId }, select: { id: true } }))) throw new PayTriggerError('Product not found');
  if (brand === null) {
    await prisma.payTriggerProduct.deleteMany({ where: { productId } });
  } else {
    await prisma.payTriggerProduct.upsert({ where: { productId }, create: { productId, brand, addedById: actorId }, update: { brand } });
  }
  await logAudit({ userId: actorId, action: 'PAYTRIGGER_PRODUCT', entityType: 'Product', entityId: productId, newValues: { brand } });
}

// ---------------------------------------------------------------------------
// Enrolment
// ---------------------------------------------------------------------------

/** Transsion stock not yet enrolled (or whose enrolment failed or lapsed), in or reserved from stock. */
export async function enrolmentCandidates(branchId?: string) {
  const productIds = (await prisma.payTriggerProduct.findMany({ select: { productId: true } })).map((p) => p.productId);
  const items = await prisma.inventoryItem.findMany({
    where: { productId: { in: productIds }, status: { in: ['AVAILABLE', 'RESERVED'] }, ...(branchId && { branchId }) },
    include: { product: { select: { name: true } }, branch: { select: { name: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });
  const devices = await prisma.payTriggerDevice.findMany({ where: { inventoryItemId: { in: items.map((i) => i.id) } } });
  const live = actionsAreLive() ? await devicesEnrolledLive(devices.map((d) => d.id)) : null;
  return items
    .map((item) => {
      const device = devices.find((d) => d.inventoryItemId === item.id) ?? null;
      const needsEnrolment = !device || ['FAILED', 'CANCELLED', 'REMOVED'].includes(device.enrollmentStatus)
        || (!!live && device.enrollmentStatus === 'QUEUED' && !live.has(device.id));
      return {
        id: item.id, serialNumber: item.serialNumber, status: item.status, productName: item.product.name, branchName: item.branch.name,
        imeiValid: IMEI.test(item.serialNumber), device: device && { id: device.id, enrollmentStatus: device.enrollmentStatus, lastError: device.lastError },
        needsEnrolment,
      };
    })
    .filter((c) => c.needsEnrolment);
}

interface EnrolOutcome { inventoryItemId: string; imei: string; ok: boolean; message: string; dryRun: boolean; modelWarning?: string }

/**
 * Enrols phones with PayTrigger so each locks itself on first switch-on
 * (preLockFlag): it stays locked until its contract's real date is sent.
 * The IMEI is unique, so a stray record left by a deleted, re-added or
 * corrected inventory item is moved to the current one; refused only when
 * the old item still exists with the same IMEI, a real duplicate.
 */
export async function enrolPhones(inventoryItemIds: string[], actorId: string | null): Promise<EnrolOutcome[]> {
  if (inventoryItemIds.length === 0) throw new PayTriggerError('Choose at least one phone');
  if (inventoryItemIds.length > 200) throw new PayTriggerError('Enrol at most 200 phones at a time');
  const settings = await getPayTriggerSettings();
  const items = await prisma.inventoryItem.findMany({ where: { id: { in: inventoryItemIds } }, include: { product: { select: { id: true, name: true, model: true } } } });
  const marked = new Set((await prisma.payTriggerProduct.findMany({ where: { productId: { in: items.map((i) => i.productId) } } })).map((m) => m.productId));
  const outcomes: EnrolOutcome[] = [];
  const toSend: Array<{ item: (typeof items)[number]; device: PayTriggerDevice | null }> = [];

  for (const id of inventoryItemIds) {
    const item = items.find((i) => i.id === id);
    if (!item) { outcomes.push({ inventoryItemId: id, imei: '', ok: false, message: 'Inventory item not found', dryRun: false }); continue; }
    const imei = item.serialNumber.trim();
    const refuse = (message: string) => outcomes.push({ inventoryItemId: id, imei, ok: false, message, dryRun: false });
    if (!marked.has(item.productId)) { refuse(`${item.product.name} is not marked as a PayTrigger phone (PayTrigger > Products)`); continue; }
    if (!IMEI.test(imei)) { refuse('The serial number is not an IMEI: it must be 15 to 18 digits'); continue; }

    let device = await prisma.payTriggerDevice.findUnique({ where: { imei } });
    if (device && device.inventoryItemId !== item.id) {
      const earlier = await prisma.inventoryItem.findUnique({ where: { id: device.inventoryItemId }, select: { serialNumber: true } });
      if (earlier && earlier.serialNumber.trim() === imei) { refuse('Another inventory item already carries this IMEI'); continue; }
    }
    const strayOnItem = await prisma.payTriggerDevice.findUnique({ where: { inventoryItemId: item.id } });
    if (strayOnItem && strayOnItem.imei !== imei) {
      // The item's IMEI was corrected after an earlier enrolment.
      if (strayOnItem.enrollmentStatus === 'ACTIVE') { refuse(`This item was enrolled as ${strayOnItem.imei}, which is active: verify that phone instead`); continue; }
      await prisma.payTriggerDevice.delete({ where: { id: strayOnItem.id } });
      await logAction({ action: 'STRAY_REMOVED', success: true, actorId, dryRun: false, response: { inventoryItemId: item.id, imei: strayOnItem.imei } });
    }
    if (device && device.inventoryItemId !== item.id) {
      // Left behind by an item deleted or re-added: moved to this one.
      const from = device.inventoryItemId;
      device = await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { inventoryItemId: item.id } });
      await logAction({ deviceId: device.id, action: 'MOVE', success: true, actorId, dryRun: false, response: { from, to: item.id } });
    }
    if (device?.enrollmentStatus === 'ACTIVE') { refuse('Already active with PayTrigger: use Verify instead'); continue; }
    toSend.push({ item, device });
  }
  if (toSend.length === 0) return outcomes;

  // Model cross-check: shown when it differs, never a reason to refuse.
  const warnings = new Map<string, string>();
  if (payTriggerConfig().apiKey) {
    for (const { item } of toSend.slice(0, 20)) {
      const model = await payTriggerRead<{ brandName?: string; modelMarketName?: string; modelLabelName?: string }>(PAYTRIGGER_PATHS.model, { imei: item.serialNumber.trim() });
      const known = `${model.data?.brandName ?? ''} ${model.data?.modelMarketName ?? ''} ${model.data?.modelLabelName ?? ''}`.toLowerCase();
      const ours = `${item.product.name} ${item.product.model ?? ''}`.toLowerCase();
      if (model.success && model.data && !ours.split(/\s+/).some((w) => w.length > 2 && known.includes(w))) {
        warnings.set(item.id, `PayTrigger knows this IMEI as ${model.data.brandName ?? ''} ${model.data.modelMarketName ?? model.data.modelLabelName ?? ''}`.trim());
      }
    }
  }

  const result: PayTriggerResult<Array<{ imei: string; errCode: string | number; message: string }>> = await payTriggerAction(PAYTRIGGER_PATHS.enrol, {
    imeiInfo: jsonList(toSend.map(({ item }) => ({ imei: item.serialNumber.trim(), nextRepaymentTimeSwitch: true, orderNum: item.id, ruleNum: settings.defaultRuleNum }))),
    preLockFlag: true,
  }, { simulated: [] });
  const failures = new Map((result.code === 50021 ? result.data ?? [] : []).map((f) => [f.imei, f]));

  for (const { item, device } of toSend) {
    const imei = item.serialNumber.trim();
    const failure = failures.get(imei);
    const alreadyEnrolled = failure && Number(failure.errCode) === 50015;
    const ok = result.success || (result.code === 50021 && (!failure || !!alreadyEnrolled));
    const message = ok
      ? (result.dryRun ? 'Enrolled (dry run: not sent to PayTrigger)' : alreadyEnrolled ? 'Already enrolled with PayTrigger' : 'Enrolled: it locks itself when first switched on, until its contract opens it')
      : failure ? `${failure.message} (${failure.errCode})` : result.error ?? 'Enrolment failed';
    const saved = await prisma.payTriggerDevice.upsert({
      where: { inventoryItemId: item.id },
      create: { inventoryItemId: item.id, imei, orderRef: item.id, enrollmentStatus: ok ? 'QUEUED' : 'FAILED', lastError: ok ? null : message },
      update: { imei, orderRef: item.id, enrollmentStatus: ok ? 'QUEUED' : 'FAILED', lastError: ok ? null : message, ...(ok && !device?.deviceTag && { committedState: 'UNKNOWN' }) },
    });
    await logAction({
      deviceId: saved.id, action: 'ENROL', success: ok, actorId,
      result: { ...result, success: ok, error: ok ? null : message },
      skippedReason: ok ? undefined : message,
    });
    outcomes.push({ inventoryItemId: item.id, imei, ok, message, dryRun: result.dryRun, modelWarning: warnings.get(item.id) });
  }
  return outcomes;
}

/**
 * Asks PayTrigger what it knows of a phone: after enrolling, or whenever its
 * state is in doubt. Unknown to PayTrigger: enrol again. Active: marked so,
 * its lock state read, and its contract reconciled.
 */
export async function verifyDevice(deviceId: string, actorId: string | null): Promise<{ message: string }> {
  const device = await deviceOrThrow(deviceId);
  const result = await payTriggerRead<{ deviceTag?: string; lockState?: number; serverState?: number }>(PAYTRIGGER_PATHS.getDevice, { imei: device.imei });
  await logAction({ deviceId, contractId: device.contractId, action: 'VERIFY', result, actorId });
  if (!result.success) {
    if (result.code === 20001 || result.code === 50051) {
      await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { enrollmentStatus: 'FAILED', lastError: 'PayTrigger does not know this IMEI: enrol it again' } });
      return { message: 'PayTrigger does not know this IMEI. Enrol it again.' };
    }
    throw new PayTriggerError(result.error ?? 'Could not ask PayTrigger');
  }
  const state = result.data?.lockState ?? result.data?.serverState ?? null;
  if (state === 5000) {
    await applyReportedState(device, { lockState: 5000, deviceTag: result.data?.deviceTag });
    return { message: 'The lock has been removed from this phone.' };
  }
  if (state === 3000) {
    await applyReportedState(device, { lockState: 3000, deviceTag: result.data?.deviceTag });
    const lock = await payTriggerRead<{ mobileStatus?: number; lastConnectTime?: number; apkVersion?: string }>(PAYTRIGGER_PATHS.findLockState, { imei: device.imei });
    const fresh = await deviceOrThrow(deviceId);
    if (lock.success && lock.data) await applyReportedState(fresh, lock.data);
    if (fresh.contractId) await reconcileContract(fresh.contractId, { reasons: ['ADMIN'], actorId, force: true });
    else await syncLockText(fresh, null, null, actorId);
    return { message: 'Active with PayTrigger.' };
  }
  if (device.enrollmentStatus === 'FAILED') await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { enrollmentStatus: 'QUEUED', lastError: null } });
  return { message: 'Enrolled with PayTrigger, waiting for its first switch-on.' };
}

/** Undoes an enrolment before the phone is switched on, so it can be sold without the lock. */
export async function cancelEnrolment(deviceId: string, actorId: string) {
  const device = await deviceOrThrow(deviceId);
  if (!['QUEUED', 'FAILED'].includes(device.enrollmentStatus)) throw new PayTriggerError(`Only an enrolment not yet switched on can be cancelled (this one is ${device.enrollmentStatus})`);
  if (device.contractId) {
    const contract = await prisma.contract.findUnique({ where: { id: device.contractId }, select: { status: true, contractNumber: true } });
    if (contract && !['CANCELLED', 'WRITTEN_OFF'].includes(contract.status)) {
      throw new PayTriggerError(`This phone is sold on contract ${contract.contractNumber}: cancelling its enrolment would leave it with no lock`);
    }
  }
  const result = await payTriggerAction(PAYTRIGGER_PATHS.cancelEnrolment, { imeiInfo: device.imei });
  await logAction({ deviceId, contractId: device.contractId, action: 'CANCEL_ENROLMENT', result, actorId });
  if (!result.success) throw new PayTriggerError(result.error ?? 'PayTrigger refused');
  await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { enrollmentStatus: 'CANCELLED', contractId: null } });
  if (device.contractId) registryRemove(device.contractId);
  await logAudit({ userId: actorId, action: 'PAYTRIGGER_CANCEL_ENROLMENT', entityType: 'PayTriggerDevice', entityId: deviceId, newValues: { imei: device.imei } });
}

// ---------------------------------------------------------------------------
// Offline PIN and release
// ---------------------------------------------------------------------------

/**
 * A 9-digit PIN the customer types on the lock screen of a phone that has
 * no data: it carries the lock date PayTrigger holds now, so the contract is
 * reconciled first and a PIN is refused unless that date is in the future.
 * Phones on an old PayTrigger app also need the 4-digit key shown on their
 * lock screen (`captcha`). The PIN is returned once and never stored or logged.
 */
export async function issueOfflinePin(deviceId: string, actorId: string, captcha?: string): Promise<{ pin: string | null; needsKey?: boolean; message: string }> {
  let device = await deviceOrThrow(deviceId);
  if (device.enrollmentStatus !== 'ACTIVE') throw new PayTriggerError('An offline PIN is only for a phone that has been switched on');
  if (device.pinUnlocksUsed >= MAX_PIN_UNLOCKS) throw new PayTriggerError(`This phone has used all ${MAX_PIN_UNLOCKS} offline PIN unlocks PayTrigger allows`);
  if (captcha !== undefined && !/^\d{4}$/.test(captcha)) throw new PayTriggerError('The key from the lock screen is 4 digits');
  if (device.contractId) {
    const outcome = await reconcileContract(device.contractId, { reasons: ['ADMIN'], actorId, force: true });
    device = await deviceOrThrow(deviceId);
    if (!device.providerExpiresAt || device.providerExpiresAt.getTime() < Date.now() + 60_000) {
      throw new PayTriggerError(`A PIN would not open this phone: its lock date has passed. ${outcome.reason}`);
    }
  } else {
    throw new PayTriggerError('This phone has no contract, so there is nothing to open it for');
  }

  const result = await payTriggerAction<{ verifyCode?: string }>(PAYTRIGGER_PATHS.verifyCode, { imei: device.imei, deviceTag: device.deviceTag ?? undefined, captcha }, { simulated: {} });
  // The response is logged without its data: it holds the PIN.
  await logAction({ deviceId, contractId: device.contractId, action: 'PIN', result: { ...result, data: null }, actorId, response: { code: result.code, message: result.message } });
  if (result.code === 50063) return { pin: null, needsKey: true, message: 'This phone runs an old PayTrigger app: enter the 4-digit key shown on its lock screen.' };
  if (!result.success) throw new PayTriggerError(result.error ?? 'PayTrigger refused');
  if (result.dryRun) return { pin: null, message: 'Dry run: no PIN was generated. Switch PayTrigger live to issue real PINs.' };

  await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { pinUnlocksUsed: { increment: 1 }, awaitingPinSince: null } });
  await logAudit({ userId: actorId, action: 'PAYTRIGGER_PIN', entityType: 'PayTriggerDevice', entityId: deviceId, newValues: { contractId: device.contractId } });
  return { pin: result.data?.verifyCode ?? null, message: 'Give the customer this PIN to type on the lock screen. It can be used once.' };
}

/**
 * Removes the lock for good: PayTrigger uninstalls itself from the phone,
 * which cannot be undone. Only for a paid-off contract, checked again at the
 * moment of release.
 */
export async function releaseDevice(deviceId: string, actorId: string | null): Promise<{ message: string }> {
  const device = await deviceOrThrow(deviceId);
  if (device.enrollmentStatus !== 'ACTIVE') throw new PayTriggerError(`Only an active phone can be released (this one is ${device.enrollmentStatus})`);
  const contract = device.contractId ? await prisma.contract.findUnique({ where: { id: device.contractId }, select: { status: true, contractNumber: true } }) : null;
  if (!contract || contract.status !== 'COMPLETED') {
    throw new PayTriggerError(`Only a phone on a paid-off contract can be released${contract ? ` (contract ${contract.contractNumber} is ${contract.status})` : ''}`);
  }
  const result = await payTriggerAction(PAYTRIGGER_PATHS.removeLock, { imei: device.imei, deviceTag: device.deviceTag ?? undefined });
  await logAction({ deviceId, contractId: device.contractId, action: 'RELEASE', result, actorId });
  if (!result.success) {
    await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { lastError: `RELEASE: ${result.error}`.slice(0, 500) } });
    throw new PayTriggerError(result.error ?? 'PayTrigger refused');
  }
  if (!result.dryRun) {
    await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { enrollmentStatus: 'REMOVED', committedState: 'UNLOCKED', releaseAfter: null, awaitingPinSince: null, lastError: null } });
    registryRemove(device.contractId!);
  }
  if (actorId) await logAudit({ userId: actorId, action: 'PAYTRIGGER_RELEASE', entityType: 'PayTriggerDevice', entityId: deviceId, newValues: { contractNumber: contract.contractNumber } });
  return { message: result.dryRun ? 'Dry run: the lock was not really removed.' : 'Lock removed: PayTrigger uninstalls itself from the phone once it is online.' };
}

export async function setReleaseHeld(deviceId: string, held: boolean, actorId: string) {
  await deviceOrThrow(deviceId);
  await prisma.payTriggerDevice.update({ where: { id: deviceId }, data: { releaseHeld: held } });
  await logAction({ deviceId, action: held ? 'RELEASE_HELD' : 'RELEASE_UNHELD', success: true, actorId, dryRun: false });
}

/** A pop-up (1) or notification (2) on the phone. PayTrigger allows 3 of each a day per phone. */
export async function sendPhoneMessage(deviceId: string, message: { title: string; content: string; pushType: 1 | 2 }, actorId: string) {
  const device = await deviceOrThrow(deviceId);
  if (device.enrollmentStatus !== 'ACTIVE') throw new PayTriggerError('Messages reach only a phone that has been switched on');
  const title = message.title.trim();
  const content = message.content.trim();
  if (!title || title.length > 80) throw new PayTriggerError('The title must be 1 to 80 characters');
  if (!content || content.length > 500) throw new PayTriggerError('The message must be 1 to 500 characters');
  const result = await payTriggerAction(PAYTRIGGER_PATHS.sendPush, { imei: device.imei, deviceTag: device.deviceTag ?? undefined, title, content, pushType: message.pushType });
  await logAction({ deviceId, contractId: device.contractId, action: message.pushType === 1 ? 'POPUP' : 'PUSH', result, actorId });
  if (!result.success) throw new PayTriggerError(result.error ?? 'PayTrigger refused');
  return { dryRun: result.dryRun };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function listDevices(filter: { status?: string; q?: string }) {
  const devices = await prisma.payTriggerDevice.findMany({
    where: {
      ...(filter.status && { enrollmentStatus: filter.status }),
      ...(filter.q && { imei: { contains: filter.q.trim() } }),
    },
    orderBy: { updatedAt: 'desc' },
    take: 300,
  });
  const contracts = await prisma.contract.findMany({
    where: { id: { in: devices.map((d) => d.contractId).filter((id): id is string => !!id) } },
    select: { id: true, contractNumber: true, status: true, customer: { select: { firstName: true, lastName: true } } },
  });
  return devices.map((d) => ({ ...d, contract: contracts.find((c) => c.id === d.contractId) ?? null }));
}

export async function deviceDetail(deviceId: string) {
  const device = await deviceOrThrow(deviceId);
  const [contract, item, timeline] = await Promise.all([
    device.contractId ? prisma.contract.findUnique({
      where: { id: device.contractId },
      select: { id: true, contractNumber: true, status: true, balanceMinor: true, customer: { select: { firstName: true, lastName: true, phone: true } } },
    }) : null,
    prisma.inventoryItem.findUnique({ where: { id: device.inventoryItemId }, select: { serialNumber: true, status: true, product: { select: { name: true } } } }),
    prisma.payTriggerActionLog.findMany({ where: { deviceId }, orderBy: { createdAt: 'desc' }, take: 100 }),
  ]);
  return { device, contract, item, timeline };
}

const HOUR = 3_600_000;

/**
 * What staff work through, top down: phones paid for but still locked, held
 * for an agent's deposit, locks not confirmed, failures, phones not heard
 * from, sold PayTrigger phones never enrolled, and a late sweep.
 */
export async function payTriggerIssues() {
  const now = Date.now();
  const settings = await getPayTriggerSettings();
  const enforced = await prisma.payTriggerDevice.findMany({ where: { enrollmentStatus: { in: ENFORCED_STATES } } });
  const contracts = await prisma.contract.findMany({
    where: { id: { in: enforced.map((d) => d.contractId).filter((id): id is string => !!id) } },
    select: {
      id: true, contractNumber: true, status: true, approvedAt: true, createdAt: true,
      customer: { select: { firstName: true, lastName: true, phone: true } },
      createdBy: { select: { firstName: true, lastName: true, phone: true, role: { select: { name: true } } } },
      agentDepositLedger: { select: { amountOwedMinor: true, amountRemittedMinor: true, commissionPaidMinor: true, createdAt: true } },
    },
  });
  const withContract = (d: PayTriggerDevice) => ({ ...d, contract: contracts.find((c) => c.id === d.contractId) ?? null });
  const { ledgerBalance } = await import('../services/agentLedgerService');

  const paidStillLocked = enforced.filter((d) => d.awaitingPinSince).sort((a, b) => a.awaitingPinSince!.getTime() - b.awaitingPinSince!.getTime()).map(withContract);
  const depositHeld = enforced.map(withContract).filter((d) => d.contract && d.contract.createdBy.role.name === 'AGENT' && settings.lockOnUnpaidAgentDeposit
    && d.contract.status === 'ACTIVE' && (!d.contract.agentDepositLedger || ledgerBalance(d.contract.agentDepositLedger) > 0))
    .map((d) => ({ ...d, owedMinor: d.contract!.agentDepositLedger ? ledgerBalance(d.contract!.agentDepositLedger) : null }));
  const lockNotConfirmed = enforced.filter((d) => d.enrollmentStatus === 'ACTIVE' && d.scheduleExpiresAt && d.scheduleExpiresAt.getTime() < now - 24 * HOUR && d.committedState !== 'LOCKED').map(withContract);
  const unenforceable = enforced.filter((d) => d.enrollmentStatus === 'UNENFORCEABLE').map(withContract);
  const failing = (await prisma.payTriggerDevice.findMany({ where: { lastError: { not: null } }, orderBy: { updatedAt: 'desc' }, take: 100 })).map(withContract);
  const stale = enforced.filter((d) => d.enrollmentStatus === 'ACTIVE' && d.lastConnectAt && d.lastConnectAt.getTime() < now - 14 * 24 * HOUR).map(withContract);

  const soldNotEnrolled = await prisma.contract.findMany({
    where: { contractType: 'DEVICE_FINANCING', status: { in: ['PENDING_DEPOSIT', 'ACTIVE', 'DEFAULTED'] }, inventoryItemId: { not: null } },
    select: { id: true, contractNumber: true, status: true, inventoryItemId: true, customer: { select: { firstName: true, lastName: true } } },
  }).then(async (rows) => {
    const devices = await prisma.payTriggerDevice.findMany({ where: { inventoryItemId: { in: rows.map((r) => r.inventoryItemId!) } } });
    return rows
      .map((r) => ({ ...r, device: devices.find((d) => d.inventoryItemId === r.inventoryItemId) ?? null }))
      .filter((r) => !r.device || !ENFORCED_STATES.includes(r.device.enrollmentStatus));
  });

  const sweepLate = !settings.lastSweepAt || settings.lastSweepAt.getTime() < now - 26 * HOUR;
  return { paidStillLocked, depositHeld, lockNotConfirmed, unenforceable, failing, stale, soldNotEnrolled, sweepLate, lastSweepAt: settings.lastSweepAt };
}

/** The switches, the licence count and the device counts: is PayTrigger working? */
export async function payTriggerHealth() {
  const config = payTriggerConfig();
  const settings = await getPayTriggerSettings();
  const counts = await prisma.payTriggerDevice.groupBy({ by: ['enrollmentStatus'], _count: true });
  const licence = config.apiKey
    ? await payTriggerRead<{ totalAmountOfLicense?: number; amountUsedOfLicense?: number; remainingAmountOfLicense?: number }>(PAYTRIGGER_PATHS.checkLicense, {})
    : null;
  return {
    config: {
      keySet: !!config.apiKey, dryRun: config.dryRun, liveActionsEnabled: config.liveActions, live: actionsAreLive(config),
      canary: [...config.canary], baseUrl: config.baseUrl,
    },
    licence: licence ? { ok: licence.success, error: licence.error, ...(licence.data ?? {}) } : null,
    devices: Object.fromEntries(counts.map((c) => [c.enrollmentStatus, c._count])),
    lastSweepAt: settings.lastSweepAt,
    lastSweepSummary: settings.lastSweepSummary,
  };
}
