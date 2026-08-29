import { prisma } from '../db/prisma';

/**
 * Flips PENDING/PARTIAL instalments past their due date to OVERDUE. A direct
 * batch update rather than a full contract recompute (see paymentService.ts)
 * since this runs across every contract on a schedule, not just the one a
 * payment just touched — recomputeContract already keeps a single contract's
 * instalments accurate on every posted payment; this sweep is what keeps
 * contracts with no recent payment activity accurate too. Mirrors the
 * legacy app's daily-cron pattern (docs/00-legacy-study.md §3).
 */
export async function markOverdueInstalments() {
  const result = await prisma.instalment.updateMany({
    where: { status: { in: ['PENDING', 'PARTIAL'] }, dueDate: { lt: new Date() } },
    data: { status: 'OVERDUE' },
  });
  return result.count;
}

/** Days-past-due threshold at which an ACTIVE contract in arrears is marked DEFAULTED — matches the "90+" arrears-ageing bucket already used elsewhere in reporting. */
const DEFAULT_THRESHOLD_DAYS = 90;

/**
 * DEFAULTED exists in the DEPOSIT_INSTALMENT and DEVICE_LOAN state machines
 * (docs/01-plan.md §5) but is never reached on its own — an ACTIVE contract
 * whose oldest unpaid instalment has been overdue past the threshold gets
 * flipped here. SAVE_TO_OWN has no DEFAULTED state (the device was never
 * released, so there's nothing to be "in default" on) and is deliberately
 * excluded. Must run after markOverdueInstalments in the same sweep so the
 * OVERDUE flips it reads are current.
 */
export async function markDefaultedContracts() {
  const cutoff = new Date(Date.now() - DEFAULT_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await prisma.contract.findMany({
    where: {
      status: 'ACTIVE',
      contractType: { in: ['DEPOSIT_INSTALMENT', 'DEVICE_LOAN'] },
      instalments: { some: { status: 'OVERDUE', dueDate: { lt: cutoff } } },
    },
    select: { id: true },
  });

  if (candidates.length === 0) return 0;

  const result = await prisma.contract.updateMany({
    where: { id: { in: candidates.map((c) => c.id) } },
    data: { status: 'DEFAULTED', defaultedAt: new Date() },
  });
  return result.count;
}

/**
 * Charges a one-time late fee — `contract.penaltyRateBps` percent of the
 * instalment's own amount — the first time an OVERDUE instalment passes that
 * contract's `gracePeriodDays`. penaltyRateBps of 0 (the default) means this
 * is a no-op for that contract, matching the "opt-in per contract" convention
 * penaltyRateBps/gracePeriodDays were added under. Idempotent per instalment:
 * checks for an existing 'LATE_PENALTY' row before creating another, so a
 * daily cron re-run never double-charges. Must run after markOverdueInstalments
 * in the same sweep so it sees today's OVERDUE flips.
 */
export async function applyLatePenalties() {
  const now = new Date();
  const overdue = await prisma.instalment.findMany({
    where: { status: 'OVERDUE', contract: { contractType: { in: ['DEPOSIT_INSTALMENT', 'DEVICE_LOAN'] }, penaltyRateBps: { gt: 0 } } },
    include: { contract: true, penalties: true },
  });

  let count = 0;
  for (const instalment of overdue) {
    const daysPastDue = Math.floor((now.getTime() - instalment.dueDate.getTime()) / (24 * 60 * 60 * 1000));
    if (daysPastDue <= instalment.contract.gracePeriodDays) continue;
    if (instalment.penalties.some((p) => p.reason === 'LATE_PENALTY')) continue;

    const amountMinor = Math.round((instalment.amountDueMinor * instalment.contract.penaltyRateBps) / 10000);
    if (amountMinor <= 0) continue;

    await prisma.penalty.create({
      data: { contractId: instalment.contractId, instalmentId: instalment.id, amountMinor, reason: 'LATE_PENALTY' },
    });
    count++;
  }
  return count;
}
