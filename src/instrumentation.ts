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
  const { markOverdueInstalments, markDefaultedContracts, applyLatePenalties } = await import('@/lib/services/overdueService');
  const { reconcilePendingHubtelTransactions } = await import('@/lib/services/hubtelPaymentService');
  const { pruneExpiredUssdSessions } = await import('@/lib/services/ussdService');
  const { retryFailedDirectDebits } = await import('@/lib/services/hubtelPreapprovalService');
  const { runDirectDebitCollections } = await import('@/lib/services/collectionsService');
  const { accrueDailyLoanInterest } = await import('@/lib/services/loanService');
  const { sendDueTodayReminders, sendOverdueReminders } = await import('@/lib/services/reminderService');

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
    try {
      // Same ordering requirement as markDefaultedContracts above.
      const count = await applyLatePenalties();
      if (count > 0) console.log(`[cron] applied ${count} late-payment penalty(ies)`);
    } catch (e) {
      console.error('[cron] applyLatePenalties failed:', e);
    }
    try {
      const count = await runDirectDebitCollections();
      if (count > 0) console.log(`[cron] direct debit collections: charged ${count} contract(s)`);
    } catch (e) {
      console.error('[cron] runDirectDebitCollections failed:', e);
    }
    try {
      const count = await retryFailedDirectDebits();
      if (count > 0) console.log(`[cron] retried ${count} failed direct debit charge(s)`);
    } catch (e) {
      console.error('[cron] retryFailedDirectDebits failed:', e);
    }
    try {
      const count = await accrueDailyLoanInterest();
      if (count > 0) console.log(`[cron] accrued daily interest on ${count} DEVICE_LOAN contract(s)`);
    } catch (e) {
      console.error('[cron] accrueDailyLoanInterest failed:', e);
    }
  });

  // Daily at 09:00 and 10:00 — customer payment reminders, after the 08:00
  // sweep has settled today's arrears (the legacy app's own times).
  cron.schedule('0 9 * * *', async () => {
    try {
      const run = await sendDueTodayReminders();
      if (run.sent > 0) console.log(`[cron] sent ${run.sent} due-today payment reminder(s)`);
    } catch (e) {
      console.error('[cron] sendDueTodayReminders failed:', e);
    }
  });
  cron.schedule('0 10 * * *', async () => {
    try {
      const run = await sendOverdueReminders();
      if (run.sent > 0) console.log(`[cron] sent ${run.sent} overdue payment reminder(s)`);
    } catch (e) {
      console.error('[cron] sendOverdueReminders failed:', e);
    }
  });

  // Every 15 minutes — catches any Hubtel callback that never arrived, and sweeps expired USSD sessions.
  cron.schedule('*/15 * * * *', async () => {
    try {
      const result = await reconcilePendingHubtelTransactions();
      if (result.checked > 0) console.log(`[cron] Hubtel reconciliation: checked ${result.checked}, failed ${result.failed}`);
      if (result.unrecordedRetried > 0) console.log(`[cron] Hubtel reconciliation: retried ledger posting for ${result.unrecordedRetried} collected charge(s)`);
    } catch (e) {
      console.error('[cron] reconcilePendingHubtelTransactions failed:', e);
    }
    try {
      await pruneExpiredUssdSessions();
    } catch (e) {
      console.error('[cron] pruneExpiredUssdSessions failed:', e);
    }
  });

  console.log('[instrumentation] Scheduled jobs registered (overdue sweep @ 08:00, payment reminders @ 09:00 and 10:00 daily, Hubtel reconciliation every 15min).');
}
