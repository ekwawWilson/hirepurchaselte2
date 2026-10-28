import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { actionsAreLive } from './client';
import { getPayTriggerSettings, clearPayTriggerSettingsCache } from './settings';
import { loadPayTriggerRegistry } from './notify';
import { ENFORCED_STATES, reconcileContract, readLockStates, syncLockText, type Breaker } from './reconcile';
import { enrolPhones, releaseDevice } from './admin';
import { devicesEnrolledLive } from './saleGuard';

/**
 * PayTrigger's one scheduled job, daily after the 08:00 overdue sweep
 * (instrumentation.ts). Every phone is brought into line with its contract,
 * paid-off phones are released, and phones whose state is in doubt are read.
 * A phone locks itself when its date passes, so missing a day never leaves
 * one open; it only delays an unlock the hooks should already have sent.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Status reads are spent sparingly: PayTrigger allows few per phone a day. */
const STATUS_READ_SPACING_MS = 20 * HOUR;

export interface SweepSummary {
  linked: number;
  reconciled: number;
  sent: number;
  skipped: number;
  errors: number;
  released: number;
  statusReads: number;
  breakerTripped: boolean;
  reEnrolled: number;
}

export async function runPayTriggerSweep(): Promise<SweepSummary> {
  const summary: SweepSummary = { linked: 0, reconciled: 0, sent: 0, skipped: 0, errors: 0, released: 0, statusReads: 0, breakerTripped: false, reEnrolled: 0 };
  const settings = await getPayTriggerSettings();
  const now = Date.now();

  // 1. Phones sold since without being linked (a missed hook): link through their contract.
  const unlinked = await prisma.payTriggerDevice.findMany({ where: { contractId: null, enrollmentStatus: { in: ['QUEUED', 'ACTIVE'] } } });
  if (unlinked.length > 0) {
    const sold = await prisma.contract.findMany({
      where: { contractType: 'DEVICE_FINANCING', inventoryItemId: { in: unlinked.map((d) => d.inventoryItemId) }, status: { notIn: ['CANCELLED', 'WRITTEN_OFF'] } },
      select: { id: true },
    });
    for (const c of sold) {
      const outcome = await reconcileContract(c.id, { reasons: ['SWEEP'] }).catch(() => null);
      if (outcome?.deviceId) summary.linked += 1;
    }
  }
  await loadPayTriggerRegistry();

  // 2. Every enforced phone with a contract, behind a circuit breaker: a bug
  // that would open every phone at once stops after a handful.
  const linked = await prisma.payTriggerDevice.findMany({ where: { contractId: { not: null }, enrollmentStatus: { in: ENFORCED_STATES } } });
  const breaker: Breaker = { limit: Math.max(5, Math.ceil(linked.length * settings.extendBreakerPercent / 100)), used: 0, tripped: false };
  for (const device of linked) {
    try {
      const outcome = await reconcileContract(device.contractId!, { reasons: ['SWEEP'], breaker });
      summary.reconciled += 1;
      if (outcome.outcome === 'SENT' || outcome.outcome === 'SIMULATED') summary.sent += 1;
      else if (outcome.outcome === 'SKIPPED') summary.skipped += 1;
      else if (outcome.outcome === 'FAILED') summary.errors += 1;
    } catch (e) {
      summary.errors += 1;
      console.error(`[paytrigger] sweep could not reconcile contract ${device.contractId}:`, e instanceof Error ? e.message : e);
    }
  }
  summary.breakerTripped = breaker.tripped;

  // 3. Live only: phones enrolled only in dry run, or whose enrolment failed, are enrolled for real.
  if (actionsAreLive()) {
    const candidates = await prisma.payTriggerDevice.findMany({ where: { enrollmentStatus: { in: ['QUEUED', 'FAILED'] } } });
    const proven = await devicesEnrolledLive(candidates.map((d) => d.id));
    const again = candidates.filter((d) => !proven.has(d.id)).map((d) => d.inventoryItemId);
    if (again.length > 0) {
      const outcomes = await enrolPhones(again.slice(0, 200), null).catch((e) => {
        console.error('[paytrigger] sweep re-enrolment failed:', e instanceof Error ? e.message : e);
        return [];
      });
      summary.reEnrolled = outcomes.filter((o) => o.ok && !o.dryRun).length;
    }
  }

  // 4. Releases due: the contract is checked again at this moment, since the
  // removal cannot be undone.
  const due = await prisma.payTriggerDevice.findMany({ where: { releaseAfter: { lte: new Date() }, releaseHeld: false, enrollmentStatus: 'ACTIVE' } });
  for (const device of due) {
    const contract = device.contractId ? await prisma.contract.findUnique({ where: { id: device.contractId }, select: { status: true } }) : null;
    if (contract?.status !== 'COMPLETED') {
      await prisma.payTriggerDevice.update({ where: { id: device.id }, data: { releaseAfter: null } });
      continue;
    }
    try {
      await releaseDevice(device.id, null);
      summary.released += 1;
    } catch (e) {
      summary.errors += 1;
      console.error(`[paytrigger] release of ${device.imei} failed:`, e instanceof Error ? e.message : e);
    }
  }

  // 5. Status reads, at most one per phone every 20 hours, for phones whose
  // state is in doubt: paid but locked, unconfirmed, near their date, or not
  // yet heard from since enrolment.
  const readable: Prisma.PayTriggerDeviceWhereInput = {
    enrollmentStatus: { in: ENFORCED_STATES },
    OR: [{ lastStatusReadAt: null }, { lastStatusReadAt: { lt: new Date(now - STATUS_READ_SPACING_MS) } }],
    AND: [{
      OR: [
        { awaitingPinSince: { not: null } },
        { committedState: { in: ['PENDING', 'UNKNOWN'] } },
        { providerExpiresAt: { gte: new Date(now - 2 * DAY), lte: new Date(now + DAY) } },
        { enrollmentStatus: 'QUEUED' },
      ],
    }],
  };
  const toRead = await prisma.payTriggerDevice.findMany({ where: readable, take: 2000 });
  if (toRead.length > 0) {
    const { read, errors } = await readLockStates(toRead);
    summary.statusReads = read;
    summary.errors += errors.length;
  }

  // 6. A switched-on phone with no contract shows "no contract" on its lock screen.
  const orphans = await prisma.payTriggerDevice.findMany({ where: { enrollmentStatus: 'ACTIVE', contractId: null } });
  for (const device of orphans) await syncLockText(device, null, null).catch(() => undefined);

  await prisma.payTriggerSettings.update({
    where: { id: settings.id },
    data: { lastSweepAt: new Date(), lastSweepSummary: summary as unknown as Prisma.InputJsonValue },
  });
  clearPayTriggerSettingsCache();
  return summary;
}

/** One line for the scheduler's log. */
export function describeSweep(s: SweepSummary): string {
  return `PayTrigger sweep: ${s.reconciled} reconciled, ${s.sent} sent, ${s.released} released, ${s.statusReads} status reads, ${s.errors} errors`
    + (s.linked ? `, ${s.linked} linked` : '') + (s.reEnrolled ? `, ${s.reEnrolled} re-enrolled` : '') + (s.breakerTripped ? ', CIRCUIT BREAKER TRIPPED' : '');
}
