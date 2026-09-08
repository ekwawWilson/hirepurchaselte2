import { prisma } from '../db/prisma';

export type HubtelSampleKind = 'USSD' | 'PREAPPROVAL_CALLBACK' | 'STATUS_CHECK';

/**
 * Captures the most recent real request/response for a Hubtel integration
 * point that has no other durable record to source an example from (see
 * schema.prisma's HubtelSampleLog — the payment callback already has one via
 * HubtelTransaction.rawCallbackPayload, so it doesn't go through here). One
 * row per kind, overwritten each time so this stays a live example rather
 * than an unbounded log. Best-effort: a failure here must never break the
 * actual USSD/webhook flow it's observing.
 */
export async function recordHubtelSample(kind: HubtelSampleKind, requestPayload: unknown, responsePayload: unknown): Promise<void> {
  try {
    const request = JSON.stringify(requestPayload);
    const response = JSON.stringify(responsePayload);
    await prisma.hubtelSampleLog.upsert({
      where: { kind },
      create: { kind, requestPayload: request, responsePayload: response },
      update: { requestPayload: request, responsePayload: response, capturedAt: new Date() },
    });
  } catch (e) {
    console.error(`[hubtel] Failed to record ${kind} sample:`, e);
  }
}
