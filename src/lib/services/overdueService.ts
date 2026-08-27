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
