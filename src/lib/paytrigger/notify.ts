import { prisma } from '../db/prisma';

/**
 * The one line every business action adds after it commits:
 *
 *   notifyPayTrigger(contract.id, 'PAYMENT', contract.contractType);
 *
 * It returns at once, never throws and never awaits, so it cannot slow or
 * fail a payment. A contract with no PayTrigger phone costs a Set lookup and
 * nothing else: the registry below holds every contract linked to a device,
 * loaded at startup, kept up to date on link, release and removal, and
 * refreshed by the morning sweep. A Device Financing contract is let through
 * even before it is in the registry, so a new one can be linked.
 *
 * Work runs on setImmediate through a per-contract inbox: reasons arriving
 * while a contract is being reconciled are merged and run once more after,
 * so ten payments in a second cost two reconciles, not ten.
 */

export type PayTriggerReason =
  | 'PAYMENT' | 'PAYMENT_REVERSED' | 'DEPOSIT_REMITTED' | 'CONTRACT_ACTIVE' | 'CONTRACT_CHANGED' | 'RETRY';

const registry = new Set<string>();
const inbox = new Map<string, Set<PayTriggerReason>>();
const running = new Set<Promise<void>>();
/** How many reconciles the hooks have run in this process: watched by the tests, nothing else. */
export const payTriggerHookStats = { reconciles: 0 };

export function registryAdd(contractId: string) {
  registry.add(contractId);
}
export function registryRemove(contractId: string) {
  registry.delete(contractId);
}

/** Every contract with a PayTrigger device. Failing to load it is logged and never stops the server. */
export async function loadPayTriggerRegistry(): Promise<number> {
  try {
    const rows = await prisma.payTriggerDevice.findMany({
      where: { contractId: { not: null }, enrollmentStatus: { notIn: ['REMOVED', 'CANCELLED'] } },
      select: { contractId: true },
    });
    registry.clear();
    for (const r of rows) registry.add(r.contractId!);
    return registry.size;
  } catch (e) {
    console.error('[paytrigger] could not load the device registry:', e instanceof Error ? e.message : e);
    return 0;
  }
}

export function notifyPayTrigger(contractId: string | null | undefined, reason: PayTriggerReason, contractType?: string): void {
  try {
    if (!contractId) return;
    if (!registry.has(contractId) && contractType !== 'DEVICE_FINANCING') return;
    const waiting = inbox.get(contractId);
    if (waiting) {
      waiting.add(reason);
      return;
    }
    inbox.set(contractId, new Set([reason]));
    runInBackground(() => drain(contractId));
  } catch (e) {
    console.error('[paytrigger] notify failed:', e);
  }
}

/** Runs `work` after the current request has been answered; payTriggerIdle waits for it. */
export function runInBackground(work: () => Promise<unknown>): void {
  setImmediate(() => {
    const promise = work().then(() => undefined, (e) => console.error('[paytrigger] background work failed:', e instanceof Error ? e.message : e));
    running.add(promise);
    void promise.finally(() => running.delete(promise));
  });
}

async function drain(contractId: string): Promise<void> {
  const reasons = inbox.get(contractId);
  try {
    // Imported here, not at the top: keeps the sidecar out of the payment
    // services' import graph, and the import cycle (reconcile -> notify) away.
    const { reconcileContract } = await import('./reconcile');
    while (reasons && reasons.size > 0) {
      const batch = [...reasons];
      reasons.clear();
      try {
        payTriggerHookStats.reconciles += 1;
        await reconcileContract(contractId, { reasons: batch });
      } catch (e) {
        console.error(`[paytrigger] reconcile of contract ${contractId} failed:`, e instanceof Error ? e.message : e);
      }
    }
  } finally {
    inbox.delete(contractId);
  }
}

/** Resolves once every notified reconcile has finished: for tests, and for a clean shutdown. */
export async function payTriggerIdle(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  while (running.size > 0) {
    await Promise.all([...running]);
    await new Promise((resolve) => setImmediate(resolve));
  }
}
