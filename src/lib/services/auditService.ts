import { prisma } from '../db/prisma';

/**
 * Records who did what, to which record, for the audit-trail report (mission
 * §10.11). Called after the action succeeds, outside any financial
 * transaction — an audit-log write failing must never roll back a payment or
 * contract action, same reasoning as SMS (docs/00-legacy-study.md §8).
 */
export async function logAudit(params: {
  userId: string | null;
  action: string;
  entityType: string;
  entityId?: string;
  oldValues?: unknown;
  newValues?: unknown;
}) {
  try {
    await prisma.auditLog.create({
      data: {
        userId: params.userId,
        action: params.action,
        entityType: params.entityType,
        entityId: params.entityId,
        oldValues: params.oldValues !== undefined ? JSON.stringify(params.oldValues) : undefined,
        newValues: params.newValues !== undefined ? JSON.stringify(params.newValues) : undefined,
      },
    });
  } catch (e) {
    console.error('Audit log write failed (non-blocking):', e);
  }
}
