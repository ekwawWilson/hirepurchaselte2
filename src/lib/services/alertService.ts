import { prisma } from '../db/prisma';

/**
 * Records something that needs a person — a payment collected but not
 * applied, a scheduled job that failed, Hubtel refusing this account — where
 * staff will see it (the Needs attention panel) instead of only in a server
 * log. `dedupeKey` folds a recurring fault into one open alert that counts
 * its occurrences, so a job failing every five minutes is one line, not 288.
 * Never throws: an alert about a failure must not cause another.
 */
export async function raiseAlert(params: { kind: string; message: string; dedupeKey: string }): Promise<void> {
  try {
    const existing = await prisma.systemAlert.findUnique({ where: { dedupeKey: params.dedupeKey } });
    if (existing && !existing.acknowledgedAt) {
      await prisma.systemAlert.update({
        where: { id: existing.id },
        data: { occurrences: { increment: 1 }, lastSeenAt: new Date(), message: params.message },
      });
      return;
    }
    // Seen before and acknowledged: it has come back, so it is open again.
    await prisma.systemAlert.upsert({
      where: { dedupeKey: params.dedupeKey },
      create: { kind: params.kind, message: params.message, dedupeKey: params.dedupeKey },
      update: { message: params.message, occurrences: 1, lastSeenAt: new Date(), acknowledgedAt: null, createdAt: new Date() },
    });
    await notifyOwner(params.message);
  } catch (e) {
    console.error('[alerts] could not record alert:', params.kind, e);
  }
}

/** Texts the owner the first time an alert opens — never on a repeat. */
async function notifyOwner(message: string): Promise<void> {
  const { sendOwnerSms } = await import('./ownerNotificationService');
  await sendOwnerSms('owner.alert', `Alert: ${message}`);
}

export async function listOpenAlerts() {
  return prisma.systemAlert.findMany({ where: { acknowledgedAt: null }, orderBy: { lastSeenAt: 'desc' }, take: 50 });
}

export async function acknowledgeAlert(id: string) {
  return prisma.systemAlert.update({ where: { id }, data: { acknowledgedAt: new Date() } });
}
