/**
 * Runs once when the server starts. Registers the scheduled jobs that mirror
 * the legacy app's daily cron sweeps (docs/00-legacy-study.md §3/§8): marking
 * overdue instalments and reconciling any Hubtel transaction stuck PENDING.
 * Guarded to the Node.js runtime (this file also loads under the Edge
 * runtime, where node-cron and Prisma aren't available), and to only
 * register once even across dev-mode hot reloads.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerScheduledJobs } = await import('./instrumentation-node');
    await registerScheduledJobs();
  }
}
