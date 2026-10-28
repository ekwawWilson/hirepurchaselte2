/**
 * The Node.js half of instrumentation.ts: registers the scheduled jobs. Kept
 * in its own file, imported only under the Node.js runtime, so the Edge
 * build of instrumentation.ts never follows these imports (Next.js's
 * "Importing runtime-specific code").
 */
declare global {
  var __hpLiteCronRegistered: boolean | undefined;
}

export async function registerScheduledJobs() {
  if (globalThis.__hpLiteCronRegistered) return;
  globalThis.__hpLiteCronRegistered = true;

  const cron = (await import('node-cron')).default;
  const { markOverdueInstalments, markDefaultedContracts, applyLatePenalties } = await import('@/lib/services/overdueService');
  const { reconcilePendingHubtelTransactions } = await import('@/lib/services/hubtelPaymentService');
  const { pruneExpiredUssdSessions } = await import('@/lib/services/ussdService');
  const { retryFailedDirectDebits, reconcilePendingPreapprovals } = await import('@/lib/services/hubtelPreapprovalService');
  const { runDirectDebitCollections } = await import('@/lib/services/collectionsService');
  const { accrueDailyLoanInterest } = await import('@/lib/services/loanService');
  const { sendDueTodayReminders, sendOverdueReminders } = await import('@/lib/services/reminderService');
  const { sendDirectDebitNotices, sendOwnerDailySummary } = await import('@/lib/services/dailyNoticesService');
  const { pruneLoginThrottles } = await import('@/lib/auth/loginThrottle');
  const { retryFulfilmentCallbacks } = await import('@/lib/services/ussdCheckoutService');
  const { alertLongHeldAgentCash } = await import('@/lib/services/agentLedgerService');
  const { expireStaleSubmissions } = await import('@/lib/services/contractService');
  const { raiseAlert } = await import('@/lib/services/alertService');
  const { runPayTriggerSweep, describeSweep } = await import('@/lib/paytrigger/sweep');
  const { loadPayTriggerRegistry } = await import('@/lib/paytrigger/notify');

  /**
   * Runs one scheduled job. A failure is logged, raised as an alert on the
   * dashboard (one alert per job, however many times it fails) and never
   * stops the jobs after it.
   */
  async function job<T>(name: string, label: string, run: () => Promise<T>, report?: (result: T) => string | null) {
    try {
      const message = report?.(await run());
      if (message) console.log(`[cron] ${message}`);
    } catch (e) {
      console.error(`[cron] ${name} failed:`, e);
      await raiseAlert({
        kind: 'JOB_FAILED',
        message: `The scheduled job "${label}" failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`,
        dedupeKey: `job-failed:${name}`,
      });
    }
  }
  const counted = (text: (n: number) => string) => (n: number) => (n > 0 ? text(n) : null);

  // Daily at 08:00 — matches the legacy app's own schedule. In order: the
  // defaulted and late-fee sweeps must see today's OVERDUE flips, and retries
  // run after collections so a contract is only ever attempted once a morning.
  cron.schedule('0 8 * * *', async () => {
    await job('markOverdueInstalments', 'mark overdue instalments', markOverdueInstalments, counted((n) => `marked ${n} instalment(s) OVERDUE`));
    await job('markDefaultedContracts', 'mark defaulted contracts', markDefaultedContracts, counted((n) => `marked ${n} contract(s) DEFAULTED`));
    await job('applyLatePenalties', 'apply late-payment charges', applyLatePenalties, counted((n) => `applied ${n} late-payment penalty(ies)`));
    await job('runDirectDebitCollections', 'collect direct debits', runDirectDebitCollections, counted((n) => `direct debit collections: charged ${n} contract(s)`));
    await job('retryFailedDirectDebits', 'retry failed direct debits', retryFailedDirectDebits, counted((n) => `retried ${n} failed direct debit charge(s)`));
    await job('accrueDailyLoanInterest', 'accrue daily loan interest', accrueDailyLoanInterest, counted((n) => `accrued daily interest on ${n} DEVICE_LOAN contract(s)`));
    await job('pruneLoginThrottles', 'clear old sign-in counts', pruneLoginThrottles);
    await job('expireStaleSubmissions', 'cancel agent submissions left unapproved', expireStaleSubmissions, counted((n) => `cancelled ${n} stale agent submission(s)`));
    await job('alertLongHeldAgentCash', 'check cash agents are holding', alertLongHeldAgentCash, counted((n) => `${n} agent(s) holding cash too long`));
  });

  // Daily at 08:36 — PayTrigger phone locks, after the 08:00 sweep has marked
  // today's arrears and defaults. Phones lock themselves at 08:30 when a date
  // passes; this sends whatever the day's hooks missed, releases paid-off
  // phones, and reads the state of phones in doubt.
  cron.schedule('36 8 * * *', () => job('runPayTriggerSweep', 'bring PayTrigger phone locks up to date', runPayTriggerSweep, describeSweep));

  // Daily at 09:00 and 10:00 — customer payment reminders, after the 08:00
  // sweep has settled today's arrears (the legacy app's own times).
  cron.schedule('0 9 * * *', () => job('sendDueTodayReminders', 'send due-today reminders', sendDueTodayReminders,
    (run) => (run.sent > 0 ? `sent ${run.sent} due-today payment reminder(s)` : null)));
  cron.schedule('0 10 * * *', () => job('sendOverdueReminders', 'send overdue reminders', sendOverdueReminders,
    (run) => (run.sent > 0 ? `sent ${run.sent} overdue payment reminder(s)` : null)));

  // Daily at 16:00 — tell customers whose wallet will be debited tomorrow,
  // while there is still an afternoon to put the money in it.
  cron.schedule('0 16 * * *', () => job('sendDirectDebitNotices', 'send direct debit notices', sendDirectDebitNotices,
    (run) => (run.sent > 0 ? `sent ${run.sent} direct debit notice(s)` : null)));

  // Daily at 19:00 — the day's figures, texted to the owner.
  cron.schedule('0 19 * * *', () => job('sendOwnerDailySummary', "send the owner's daily summary", sendOwnerDailySummary,
    (sent) => (sent ? "sent the owner's daily summary" : null)));

  // Every 5 minutes — Hubtel requires a status check on any transaction that
  // has gone five minutes without its callback. Also sweeps expired USSD sessions.
  cron.schedule('*/5 * * * *', async () => {
    await job('reconcilePendingHubtelTransactions', 'check unanswered mobile money payments', reconcilePendingHubtelTransactions, (result) => {
      if (result.unrecordedRetried > 0) console.log(`[cron] Hubtel reconciliation: retried ledger posting for ${result.unrecordedRetried} collected charge(s)`);
      return result.checked > 0
        ? `Hubtel reconciliation: checked ${result.checked}, succeeded ${result.succeeded}, failed ${result.failed}, still waiting ${result.stillPending}`
          + (result.statusCheckErrors > 0 ? ` (status check failed for ${result.statusCheckErrors})` : '')
        : null;
    });
    await job('reconcilePendingPreapprovals', 'check unanswered direct debit approvals', reconcilePendingPreapprovals,
      (result) => (result.checked > 0 ? `Hubtel mandate reconciliation: checked ${result.checked}, resolved ${result.resolved}` : null));
    await job('retryFulfilmentCallbacks', 'tell Hubtel the outcome of USSD payments', retryFulfilmentCallbacks,
      (result) => (result.sent + result.gaveUp > 0 ? `USSD fulfilment callbacks: sent ${result.sent}, gave up on ${result.gaveUp}` : null));
    await job('pruneExpiredUssdSessions', 'clear expired USSD sessions', pruneExpiredUssdSessions);
  });

  // Which contracts have a PayTrigger phone, so a payment hook knows at once
  // whether it has anything to do (src/lib/paytrigger/notify.ts).
  const linked = await loadPayTriggerRegistry();
  if (linked > 0) console.log(`[instrumentation] PayTrigger: ${linked} contract(s) with a locked phone`);

  console.log('[instrumentation] Scheduled jobs registered (overdue sweep and collections @ 08:00, PayTrigger @ 08:36, reminders @ 09:00 and 10:00, debit notices @ 16:00, owner summary @ 19:00, Hubtel reconciliation every 5 minutes).');
}
