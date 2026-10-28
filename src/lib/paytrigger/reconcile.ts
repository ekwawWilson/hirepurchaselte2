import { createHash } from 'crypto';
import type { PayTriggerDevice, Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { ledgerBalance } from '../services/agentLedgerService';
import { getOrgSettings } from '../services/orgSettingsService';
import { formatMoney } from '../utils/money';
import { decide, type Decision } from './decide';
import { getPayTriggerSettings, fillTemplate } from './settings';
import { registryAdd, registryRemove, notifyPayTrigger, type PayTriggerReason } from './notify';
import {
  PAYTRIGGER_PATHS, payTriggerAction, payTriggerRead, payTriggerConfig, actionsAreLive, type PayTriggerResult,
} from './client';

/**
 * Brings one contract's phone into line with what the contract says
 * (decide.ts). Called from the business hooks (notify.ts), the morning sweep
 * and the "Reconcile now" button. A successful write only ever makes the
 * phone's state PENDING: what it really is comes from callbacks and status
 * reads (applyReportedState below).
 */

/** Device states the lock is still enforced in. */
export const ENFORCED_STATES = ['QUEUED', 'ACTIVE', 'UNENFORCEABLE'];
/** Contracts whose earlier phone may be handed to a new one. */
const HANDOVER_STATUSES = ['CANCELLED', 'WRITTEN_OFF'];
/** A paid-off phone is kept open with a date this far ahead until its lock is removed. */
const RELEASE_KEEP_OPEN_MS = 14 * 24 * 60 * 60 * 1000;
/** Failed sends are tried again after these delays, then left to the morning sweep. */
const RETRY_DELAYS_MS = [30_000, 120_000, 600_000];
const STATUS_READ_AFTER_UNLOCK_MS = 60_000;

export interface Breaker {
  limit: number;
  used: number;
  tripped: boolean;
}

export interface ReconcileOutcome {
  contractId: string;
  deviceId: string | null;
  action: Decision['action'] | null;
  outcome: 'SENT' | 'SIMULATED' | 'SKIPPED' | 'UNCHANGED' | 'DEFERRED' | 'FAILED' | 'NO_DEVICE' | 'RECORDED';
  reason: string;
}

/** A fingerprint or text key from a dry run is marked, so going live resends what was only simulated. */
const marked = (key: string, dryRun: boolean) => (dryRun ? `dry:${key}` : key);
const isCurrent = (stored: string | null, key: string) => stored === key || (!actionsAreLive() && stored === `dry:${key}`);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export async function logAction(entry: {
  deviceId?: string | null; contractId?: string | null; action: string; result?: PayTriggerResult; success?: boolean;
  skippedReason?: string; actorId?: string | null; response?: unknown; dryRun?: boolean;
}) {
  try {
    await prisma.payTriggerActionLog.create({
      data: {
        deviceId: entry.deviceId ?? null,
        contractId: entry.contractId ?? null,
        action: entry.action,
        success: entry.success ?? entry.result?.success ?? false,
        dryRun: entry.dryRun ?? entry.result?.dryRun ?? !actionsAreLive(),
        providerCode: entry.result?.code != null ? String(entry.result.code) : null,
        skippedReason: entry.skippedReason ?? (entry.result && !entry.result.success ? entry.result.error : null),
        request: (entry.result?.request ?? undefined) as Prisma.InputJsonValue | undefined,
        response: (entry.response ?? (entry.result ? { code: entry.result.code, message: entry.result.message, data: entry.result.data } : undefined)) as Prisma.InputJsonValue | undefined,
        actorId: entry.actorId ?? null,
      },
    });
  } catch (e) {
    console.error('[paytrigger] could not write the action log:', e instanceof Error ? e.message : e);
  }
}

export type CommandType = 'EXTEND' | 'LOCK';

/**
 * One outbound command, idempotent by `${deviceId}:${type}:${fingerprint}`:
 * an earlier success is not sent again unless `repeat` (lock dates repeat,
 * since a phone can return to an earlier state: paid, reversed, paid).
 * While a canary list is set, a live command for any other contract is
 * logged and not sent. A failure is retried in-process at +30s, +2m and
 * +10m by reconciling again, then left to the morning sweep; a permanent
 * code gives up at once, and a rate limit waits for the next sweep.
 */
export async function runCommand(params: {
  device: PayTriggerDevice;
  contract: { id: string; contractNumber: string } | null;
  type: CommandType;
  fingerprint: string;
  payload: Record<string, unknown>;
  send: () => Promise<PayTriggerResult>;
  repeat?: boolean;
  actorId?: string | null;
}): Promise<{ status: 'SUCCEEDED' | 'SKIPPED' | 'FAILED' | 'DEFERRED'; result: PayTriggerResult | null; why?: string }> {
  const { device, contract, type } = params;
  const key = `${device.id}:${type}:${params.fingerprint}`;
  const existing = await prisma.payTriggerCommand.findUnique({ where: { idempotencyKey: key } });
  if (existing?.status === 'SUCCEEDED' && !params.repeat) return { status: 'SKIPPED', result: null, why: 'Already done' };

  const config = payTriggerConfig();
  if (actionsAreLive(config) && config.canary.size > 0 && !(contract && (config.canary.has(contract.contractNumber) || config.canary.has(contract.id)))) {
    const why = 'Not on the canary list while live actions are limited to it';
    await logAction({ deviceId: device.id, contractId: contract?.id, action: type, success: false, skippedReason: why, actorId: params.actorId });
    return { status: 'SKIPPED', result: null, why };
  }

  const command = await prisma.payTriggerCommand.upsert({
    where: { idempotencyKey: key },
    create: { deviceId: device.id, type, idempotencyKey: key, payload: params.payload as Prisma.InputJsonValue, status: 'PROCESSING', attempts: 1 },
    update: { status: 'PROCESSING', attempts: { increment: 1 }, payload: params.payload as Prisma.InputJsonValue },
  });
  const result = await params.send();
  await logAction({ deviceId: device.id, contractId: contract?.id, action: type, result, actorId: params.actorId });

  if (result.success) {
    await prisma.payTriggerCommand.update({ where: { id: command.id }, data: { status: 'SUCCEEDED', lastError: null, nextAttemptAt: null } });
    if (device.lastError) await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { lastError: null } });
    return { status: 'SUCCEEDED', result };
  }

  const error = result.error ?? 'Unknown error';
  await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { lastError: `${type}: ${error}`.slice(0, 500) } });
  if (result.rateLimited) {
    await prisma.payTriggerCommand.update({ where: { id: command.id }, data: { status: 'DEFERRED', lastError: error } });
    return { status: 'DEFERRED', result };
  }
  const delay = RETRY_DELAYS_MS[command.attempts - 1];
  if (result.permanent || delay === undefined || !contract) {
    await prisma.payTriggerCommand.update({ where: { id: command.id }, data: { status: 'FAILED', lastError: error } });
    return { status: 'FAILED', result };
  }
  await prisma.payTriggerCommand.update({ where: { id: command.id }, data: { status: 'PENDING', lastError: error, nextAttemptAt: new Date(Date.now() + delay) } });
  setTimeout(() => notifyPayTrigger(contract.id, 'RETRY'), delay).unref?.();
  return { status: 'FAILED', result };
}

// ---------------------------------------------------------------------------
// What the phone reports
// ---------------------------------------------------------------------------

export interface ReportedState {
  lockState?: number | null;
  serverState?: number | null;
  mobileStatus?: number | null;
  deviceTag?: string | null;
  lastConnectTime?: number | null;
  apkVersion?: string | null;
  expiration?: number | null;
}

/**
 * Applies what PayTrigger says the phone is doing, from a callback or a
 * status read. Returns whether the phone has just been seen activated for
 * the first time, so the caller can reconcile it.
 */
export async function applyReportedState(device: PayTriggerDevice, state: ReportedState): Promise<{ activatedNow: boolean; removed: boolean }> {
  const now = new Date();
  const data: Prisma.PayTriggerDeviceUpdateInput = { lastStatusReadAt: now };
  if (state.deviceTag) data.deviceTag = state.deviceTag;
  if (state.lastConnectTime) data.lastConnectAt = new Date(state.lastConnectTime * 1000);
  if (state.apkVersion) data.apkVersion = state.apkVersion;

  const lifecycle = state.lockState ?? state.serverState ?? null;
  let activatedNow = false;
  let removed = false;
  if (lifecycle === 3000 && device.enrollmentStatus === 'QUEUED') {
    data.enrollmentStatus = 'ACTIVE';
    data.licenceConsumedAt = device.licenceConsumedAt ?? now;
    activatedNow = true;
  }
  if (lifecycle === 5000 && device.enrollmentStatus !== 'REMOVED') {
    data.enrollmentStatus = 'REMOVED';
    data.committedState = 'UNLOCKED';
    data.awaitingPinSince = null;
    removed = true;
  }
  if (!removed && (state.mobileStatus === 1000 || state.mobileStatus === 2000)) {
    const locked = state.mobileStatus === 1000;
    data.committedState = locked ? 'LOCKED' : 'UNLOCKED';
    // Locked while PayTrigger holds a date in the future: paid, but the phone
    // has not been online to hear it. Staff can issue an offline PIN.
    const shouldBeOpen = !!device.providerExpiresAt && device.providerExpiresAt.getTime() > now.getTime();
    data.awaitingPinSince = locked && shouldBeOpen ? device.awaitingPinSince ?? now : null;
  }
  await prisma.payTriggerDevice.update({ where: { id: device.id }, data });
  if (removed && device.contractId) registryRemove(device.contractId);
  return { activatedNow, removed };
}

interface LockStateRow { imei?: string; deviceTag?: string; lockState?: number; serverState?: number; mobileStatus?: number; lastConnectTime?: number; apkVersion?: string; expiration?: number }

/**
 * Reads the lock state of up to 100 phones per call (PayTrigger allows 100
 * batch reads a day). A QUEUED phone reported activated, whose callback never
 * reached us, is marked ACTIVE and reconciled.
 */
export async function readLockStates(devices: PayTriggerDevice[]): Promise<{ read: number; errors: string[] }> {
  const errors: string[] = [];
  let read = 0;
  for (let i = 0; i < devices.length; i += 100) {
    const chunk = devices.slice(i, i + 100);
    const result = await payTriggerRead<LockStateRow[]>(PAYTRIGGER_PATHS.batchFindLockState, { imei: chunk.map((d) => d.imei).join(',') });
    await logAction({ action: 'STATUS_READ', result, success: result.success, response: { code: result.code, message: result.message, count: result.data?.length ?? 0 } });
    if (!result.success) {
      errors.push(result.error ?? 'Status read failed');
      if (result.rateLimited) break;
      continue;
    }
    for (const row of result.data ?? []) {
      const device = chunk.find((d) => d.imei === row.imei || (!!row.deviceTag && d.deviceTag === row.deviceTag));
      if (!device) continue;
      read += 1;
      const { activatedNow } = await applyReportedState(device, row);
      if (activatedNow && device.contractId) notifyPayTrigger(device.contractId, 'CONTRACT_CHANGED');
    }
  }
  return { read, errors };
}

// ---------------------------------------------------------------------------
// Linking a contract to its phone
// ---------------------------------------------------------------------------

async function findOrLinkDevice(contract: { id: string; inventoryItemId: string | null }): Promise<PayTriggerDevice | null> {
  const linked = await prisma.payTriggerDevice.findUnique({ where: { contractId: contract.id } });
  if (linked) return linked;
  if (!contract.inventoryItemId) return null;
  const device = await prisma.payTriggerDevice.findUnique({ where: { inventoryItemId: contract.inventoryItemId } });
  if (!device) return null;
  if (device.contractId && device.contractId !== contract.id) {
    // Handed to the new contract only if the earlier one is over without the phone.
    const earlier = await prisma.contract.findUnique({ where: { id: device.contractId }, select: { status: true } });
    if (earlier && !HANDOVER_STATUSES.includes(earlier.status)) return null;
    registryRemove(device.contractId);
  }
  const updated = await prisma.payTriggerDevice.update({
    where: { id: device.id },
    data: { contractId: contract.id, fingerprint: null, releaseAfter: null, releaseHeld: false, awaitingPinSince: null },
  });
  registryAdd(contract.id);
  await logAction({ deviceId: device.id, contractId: contract.id, action: 'LINK', success: true, response: { inventoryItemId: contract.inventoryItemId } });
  return updated;
}

// ---------------------------------------------------------------------------
// Lock-screen text
// ---------------------------------------------------------------------------

type LoadedContract = NonNullable<Awaited<ReturnType<typeof loadContract>>>;

function loadContract(contractId: string) {
  return prisma.contract.findUnique({
    where: { id: contractId },
    include: {
      instalments: { select: { instalmentNo: true, dueDate: true, amountDueMinor: true, amountPaidMinor: true, status: true } },
      customer: { select: { firstName: true, lastName: true, phone: true } },
      createdBy: { select: { firstName: true, lastName: true, phone: true, role: { select: { name: true } } } },
      agentDepositLedger: { select: { amountOwedMinor: true, amountRemittedMinor: true, commissionPaidMinor: true } },
    },
  });
}

async function lockScreenText(contract: LoadedContract | null, decision: Decision | null): Promise<{ title: string; tips: string }> {
  const settings = await getPayTriggerSettings();
  const org = await getOrgSettings();
  const base = { companyName: org.companyName, supportPhone: org.phone ?? '' };
  if (!contract || !['ACTIVE', 'DEFAULTED'].includes(contract.status)) {
    return { title: fillTemplate(settings.unlinkedTitle, base), tips: fillTemplate(settings.unlinkedTips, base) };
  }
  const values = {
    ...base,
    customerName: `${contract.customer.firstName} ${contract.customer.lastName}`,
    firstName: contract.customer.firstName,
    amount: `GHS ${formatMoney(decision?.next?.remainingMinor ?? contract.balanceMinor ?? 0)}`,
    dueDate: decision?.next ? decision.next.dueDate.toISOString().slice(0, 10) : '',
    balance: `GHS ${formatMoney(contract.balanceMinor ?? 0)}`,
    contractNumber: contract.contractNumber,
    agentName: `${contract.createdBy.firstName} ${contract.createdBy.lastName}`,
    agentPhone: contract.createdBy.phone ?? base.supportPhone,
  };
  return decision?.depositHold
    ? { title: fillTemplate(settings.depositHoldTitle, values), tips: fillTemplate(settings.depositHoldTips, values) }
    : { title: fillTemplate(settings.lockTitle, values), tips: fillTemplate(settings.lockTips, values) };
}

/**
 * Sends the lock-screen text when it has changed, before any lock, so the
 * phone shows it even offline. Needs the phone's device tag, so only once
 * it has been switched on.
 */
export async function syncLockText(device: PayTriggerDevice, contract: LoadedContract | null, decision: Decision | null, actorId?: string | null) {
  if (device.enrollmentStatus !== 'ACTIVE' || !device.deviceTag) return;
  const settings = await getPayTriggerSettings();
  const text = await lockScreenText(contract, decision);
  const key = createHash('sha256').update(JSON.stringify(text)).digest('hex');
  if (isCurrent(device.lockMessageKey, key)) return;
  const result = await payTriggerAction(PAYTRIGGER_PATHS.setLockRule, {
    deviceTag: device.deviceTag, imei: device.imei, ruleNum: settings.defaultRuleNum,
    deviceTitle: text.title.slice(0, 80), deviceTips: text.tips.slice(0, 400),
  });
  await logAction({ deviceId: device.id, contractId: contract?.id, action: 'LOCK_TEXT', result, actorId });
  if (result.success) await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { lockMessageKey: marked(key, result.dryRun) } });
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export async function reconcileContract(contractId: string, opts: {
  reasons: Array<PayTriggerReason | 'SWEEP' | 'ADMIN'>; actorId?: string | null; force?: boolean; breaker?: Breaker;
}): Promise<ReconcileOutcome> {
  const contract = await loadContract(contractId);
  const out = (deviceId: string | null, action: Decision['action'] | null, outcome: ReconcileOutcome['outcome'], reason: string): ReconcileOutcome =>
    ({ contractId, deviceId, action, outcome, reason });
  if (!contract) return out(null, null, 'NO_DEVICE', 'Contract not found');

  let device = await findOrLinkDevice(contract);
  if (!device) return out(null, null, 'NO_DEVICE', 'No PayTrigger phone is linked to this contract');
  if (!ENFORCED_STATES.includes(device.enrollmentStatus)) return out(device.id, null, 'SKIPPED', `Enrolment is ${device.enrollmentStatus}`);

  const settings = await getPayTriggerSettings();
  const now = new Date();
  const activated = device.enrollmentStatus === 'ACTIVE';
  const isAgentContract = contract.createdBy.role.name === 'AGENT';
  const decision = decide({
    now,
    contract,
    agentDeposit: isAgentContract && settings.lockOnUnpaidAgentDeposit
      ? { owedMinor: contract.agentDepositLedger ? ledgerBalance(contract.agentDepositLedger) : null }
      : null,
    device: { activated, providerExpiresAt: device.providerExpiresAt },
    settings,
  });

  const update: Prisma.PayTriggerDeviceUpdateInput = { scheduleExpiresAt: decision.scheduleExpiresAt };
  // A reversal can un-complete a contract: a release no longer due is called off.
  if (decision.action !== 'RELEASE' && device.releaseAfter) update.releaseAfter = null;
  device = await prisma.payTriggerDevice.update({ where: { id: device.id }, data: update });

  if (activated) await syncLockText(device, contract, decision, opts.actorId);

  if (decision.action === 'RELEASE') {
    if (!device.releaseAfter) {
      await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { releaseAfter: new Date(now.getTime() + settings.releaseHoldHours * 3_600_000) } });
      await logAction({ deviceId: device.id, contractId, action: 'RELEASE_SCHEDULED', success: true, actorId: opts.actorId, response: { releaseHoldHours: settings.releaseHoldHours } });
    }
    // Kept open meanwhile: a 14-day date, topped up once a third of it is left.
    const held = device.providerExpiresAt?.getTime() ?? 0;
    if (!activated || held - now.getTime() > RELEASE_KEEP_OPEN_MS / 3) return out(device.id, 'RELEASE', 'RECORDED', decision.reason);
    const keepOpen = new Date(now.getTime() + RELEASE_KEEP_OPEN_MS);
    const sent = await sendLockDate(device, contract, { ...decision, action: 'EXTEND', nextRepayTime: keepOpen }, `release-${keepOpen.toISOString().slice(0, 10)}`, opts);
    return out(device.id, 'RELEASE', sent, decision.reason);
  }

  // Cancelled before it was switched on: back in stock, still enrolled, free
  // for the next sale. Checked before the fingerprint, which (doing nothing
  // either way) is the same as before the cancellation.
  if (contract.status === 'CANCELLED' && !activated) {
    await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { contractId: null, fingerprint: null } });
    registryRemove(contract.id);
    await logAction({ deviceId: device.id, contractId, action: 'UNLINK', success: true, dryRun: false, actorId: opts.actorId, response: { reason: decision.reason } });
    return out(device.id, 'NONE', 'RECORDED', decision.reason);
  }

  if (!opts.force && isCurrent(device.fingerprint, decision.fingerprint)) return out(device.id, decision.action, 'UNCHANGED', 'Decision unchanged');

  if (decision.action === 'NONE') {
    await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { fingerprint: decision.fingerprint } });
    return out(device.id, 'NONE', 'RECORDED', decision.reason);
  }

  // EXTEND, HOLD, LOCK
  if (!activated) {
    // Enrolled to lock itself on first switch-on; its activation callback reconciles it.
    return out(device.id, decision.action, 'SKIPPED', 'Not switched on yet: the phone locks itself when it is, and is reconciled then');
  }
  if (!decision.nextRepayTime) {
    await logAction({ deviceId: device.id, contractId, action: 'LOCK', success: true, skippedReason: 'Deferred: the phone is already past its lock date and locks itself', actorId: opts.actorId });
    await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { fingerprint: marked(decision.fingerprint, !actionsAreLive()) } });
    return out(device.id, decision.action, 'DEFERRED', decision.reason);
  }
  if (decision.action === 'EXTEND' && opts.breaker) {
    if (opts.breaker.used >= opts.breaker.limit) {
      opts.breaker.tripped = true;
      await logAction({ deviceId: device.id, contractId, action: 'EXTEND', success: false, skippedReason: `Circuit breaker: more than ${opts.breaker.limit} phones would open in one sweep`, actorId: opts.actorId });
      return out(device.id, 'EXTEND', 'SKIPPED', 'Circuit breaker tripped');
    }
    opts.breaker.used += 1;
  }
  const sent = await sendLockDate(device, contract, decision, decision.fingerprint, opts);
  return out(device.id, decision.action, sent, decision.reason);
}

async function sendLockDate(
  device: PayTriggerDevice, contract: LoadedContract, decision: Decision, fingerprint: string,
  opts: { reasons: string[]; actorId?: string | null },
): Promise<ReconcileOutcome['outcome']> {
  const settings = await getPayTriggerSettings();
  const config = payTriggerConfig();
  const nextRepayTime = Math.floor(decision.nextRepayTime!.getTime() / 1000);
  const description = `${decision.action === 'EXTEND' ? 'Paid up' : 'Overdue'}: ${contract.contractNumber}`.slice(0, 100);
  const fields = {
    imei: device.imei,
    deviceTag: device.deviceTag ?? undefined,
    nextRepayTime,
    orderNum: contract.contractNumber,
    phoneNum: contract.customer.phone ?? undefined,
    currencyType: config.currency.slice(0, 4),
    ruleNum: settings.defaultRuleNum,
    description,
    ...(decision.amounts ?? {}),
  };
  const type: CommandType = decision.action === 'EXTEND' ? 'EXTEND' : 'LOCK';
  const run = await runCommand({
    device, contract: { id: contract.id, contractNumber: contract.contractNumber }, type, fingerprint,
    payload: { ...fields, nextRepayTime }, repeat: true, actorId: opts.actorId,
    send: () => payTriggerAction(PAYTRIGGER_PATHS.updateRepayInfo, fields),
  });
  if (run.status === 'SKIPPED') return 'SKIPPED';
  if (run.status === 'DEFERRED') return 'DEFERRED';
  if (run.status !== 'SUCCEEDED') return 'FAILED';

  const dryRun = !!run.result?.dryRun;
  await prisma.payTriggerDevice.update({
    where: { id: device.id },
    data: {
      providerExpiresAt: decision.nextRepayTime,
      fingerprint: marked(decision.fingerprint, dryRun),
      committedState: 'PENDING',
      lastError: null,
    },
  });
  // Opened after money came in while the phone was shut: check once, a minute
  // later, whether it heard. Still locked means it is offline: staff are shown
  // it under "Paid, still locked" and can give the customer an offline PIN.
  const openedAfterPayment = type === 'EXTEND' && device.committedState === 'LOCKED'
    && opts.reasons.some((r) => r === 'PAYMENT' || r === 'DEPOSIT_REMITTED');
  if (openedAfterPayment && !dryRun) {
    setTimeout(() => {
      void (async () => {
        const fresh = await prisma.payTriggerDevice.findUnique({ where: { id: device.id } });
        if (fresh) await readLockStates([fresh]);
      })().catch((e) => console.error('[paytrigger] status read after unlock failed:', e));
    }, STATUS_READ_AFTER_UNLOCK_MS).unref?.();
  }
  return dryRun ? 'SIMULATED' : 'SENT';
}
