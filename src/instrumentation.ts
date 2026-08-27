/**
 * Runs once when the server starts. Registers the scheduled jobs that mirror
 * the legacy app's daily cron sweeps (docs/00-legacy-study.md §3/§8): marking
 * overdue instalments and reconciling any Hubtel transaction stuck PENDING.
 * Guarded to the Node.js runtime (this file also loads under the Edge
 * runtime, where node-cron and Prisma aren't available), and to only
 * register once even across dev-mode hot reloads.
 */
declare global {
  var __hpLiteCronRegistered: boolean | undefined;
}

export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (globalThis.__hpLiteCronRegistered) return;
  globalThis.__hpLiteCronRegistered = true;

  const cron = (await import('node-cron')).default;
  const { markOverdueInstalments, markDefaultedContracts } = await import('@/lib/services/overdueService');
  const { reconcilePendingHubtelTransactions } = await import('@/lib/services/hubtelPaymentService');
  const { pruneExpiredUssdSessions } = await import('@/lib/services/ussdService');

  // Daily at 08:00 — matches the legacy app's own schedule.
  cron.schedule('0 8 * * *', async () => {
    try {
      const count = await markOverdueInstalments();
      if (count > 0) console.log(`[cron] marked ${count} instalment(s) OVERDUE`);
    } catch (e) {
      console.error('[cron] markOverdueInstalments failed:', e);
    }
    try {
      // Must run after markOverdueInstalments above so it sees today's OVERDUE flips.
      const count = await markDefaultedContracts();
      if (count > 0) console.log(`[cron] marked ${count} contract(s) DEFAULTED`);
    } catch (e) {
      console.error('[cron] markDefaultedContracts failed:', e);
    }
  });

  // Every 15 minutes — catches any Hubtel callback that never arrived, and sweeps expired USSD sessions.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await reconcilePendingHubtelTransactions();
      if (result.checked > 0) console.log(`[cron] Hubtel reconciliation: checked ${result.checked}, failed ${result.failed}`);
    } catch (e) {
      console.error('[cron] reconcilePendingHubtelTransactions failed:', e);
    }
    try {
      await pruneExpiredUssdSessions();
    } catch (e) {
      console.error('[cron] pruneExpiredUssdSessions failed:', e);
    }
  });

  console.log('[instrumentation] Scheduled jobs registered (overdue sweep @ 08:00 daily, Hubtel reconciliation every 15min).');
}
