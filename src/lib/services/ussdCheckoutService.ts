import { prisma } from '../db/prisma';
import { isHubtelLiveMode, sendServiceFulfilmentCallback } from './hubtelClient';
import { processHubtelCallback, HubtelError } from './hubtelPaymentService';
import { raiseAlert } from './alertService';
import { logAudit } from './auditService';

/**
 * USSD payments through Hubtel's own checkout — the flow Hubtel's
 * Programmable Services API documents (docs/01-plan.md §24):
 *
 *   1. The menu's last step answers `AddToCart` with what is being paid for.
 *      Nothing is asked of Hubtel's payment APIs; the session simply ends.
 *   2. Hubtel prompts the customer, takes the money, and reports it to the
 *      Service Fulfilment URL with the SessionId and an OrderId.
 *   3. The payment is posted to the contract, and Hubtel is told within the
 *      hour whether that was done (the Service Fulfilment Callback).
 *
 * The transaction is recorded when the menu answers, keyed on Hubtel's
 * SessionId, so everything that already watches a mobile money attempt works
 * unchanged: the Mobile Money screen lists it, the five-minute sweep asks
 * Hubtel's status check about it by that same SessionId if no fulfilment
 * arrives, and a payment that cannot be applied goes to the review queue.
 *
 * This replaces sending a Direct Receive Money prompt from the menu, which
 * needs an API scope a merchant account may not have. Setting
 * HUBTEL_USSD_PAYMENT=receive-money goes back to that.
 */
export function ussdUsesHubtelCheckout(): boolean {
  return isHubtelLiveMode() && process.env.HUBTEL_USSD_PAYMENT !== 'receive-money';
}

/** How long Hubtel allows for the Service Fulfilment Callback. */
const CALLBACK_WINDOW_MS = 60 * 60_000;

/**
 * Records the payment the customer has just confirmed in the menu, before
 * the menu hands them to Hubtel's checkout. Returns what goes in the cart.
 */
export async function beginUssdCheckout(params: { sessionId: string; contractId: string; msisdn: string; amountMinor: number }) {
  const contract = await prisma.contract.findUniqueOrThrow({ where: { id: params.contractId }, select: { contractNumber: true } });
  const existing = await prisma.hubtelTransaction.findUnique({ where: { clientReference: params.sessionId } });
  // A session id is Hubtel's and is never reused; one seen before is the
  // same confirmation arriving twice, which must not become two payments.
  if (existing && (existing.contractId !== params.contractId || existing.amountMinor !== params.amountMinor)) {
    throw new HubtelError('This session has already been used for a different payment. Please dial again.');
  }
  if (!existing) {
    await prisma.hubtelTransaction.create({
      data: {
        clientReference: params.sessionId, contractId: params.contractId, msisdn: params.msisdn,
        amountMinor: params.amountMinor, status: 'PENDING', channel: 'USSD',
        rawCallbackPayload: JSON.stringify({ checkout: true, addedToCartAt: new Date().toISOString() }),
      },
    });
  }
  return { itemName: `Payment ${contract.contractNumber}`, amountMinor: params.amountMinor };
}

interface FulfilmentPayload {
  SessionId?: string;
  OrderId?: string;
  OrderInfo?: {
    Status?: string;
    CustomerMobileNumber?: string;
    Items?: { UnitPrice?: number; Quantity?: number }[];
    Payment?: { IsSuccessful?: boolean; AmountPaid?: number; AmountAfterCharges?: number };
  };
}

const toMinor = (ghs: number) => Math.round(ghs * 100);

/**
 * Handles what Hubtel sends to the Service Fulfilment URL once a customer
 * has paid, and decides what Hubtel is told back:
 *
 *  - posted to the contract                         -> success
 *  - collected but not applicable (contract closed,
 *    amounts disagree): held for staff in the
 *    review queue, so the money is accounted for    -> success
 *  - not actually paid, or a session this server
 *    has no record of, so nothing can be credited   -> failed
 *
 * Safe to receive twice: the payment posts once, and the answer to Hubtel
 * is simply sent again.
 */
export async function processServiceFulfilment(body: FulfilmentPayload): Promise<{ matched: boolean; serviceStatus: 'success' | 'failed' }> {
  const sessionId = body.SessionId?.trim();
  const orderId = body.OrderId?.trim();
  if (!sessionId || !orderId) throw new HubtelError('SessionId and OrderId are required');

  const txn = await prisma.hubtelTransaction.findUnique({ where: { clientReference: sessionId } });
  if (!txn) {
    // Hubtel holds a payment this server knows nothing about. There is no
    // contract to credit, so say so — and make sure a person hears of it.
    const paid = body.OrderInfo?.Payment?.AmountPaid;
    await raiseAlert({
      kind: 'FULFILMENT_UNMATCHED',
      message: `Hubtel reported a USSD payment${typeof paid === 'number' ? ` of GHS ${paid.toFixed(2)}` : ''} from ${body.OrderInfo?.CustomerMobileNumber ?? 'an unknown number'} that matches no session here (order ${orderId}). It was reported back to Hubtel as not fulfilled.`,
      dedupeKey: `fulfilment-unmatched:${orderId}`,
    });
    await logAudit({ userId: null, action: 'HUBTEL_FULFILMENT_UNMATCHED', entityType: 'HubtelServiceFulfilment', entityId: orderId, newValues: body });
    try {
      await sendServiceFulfilmentCallback({ sessionId, orderId, serviceStatus: 'failed' });
    } catch (e) {
      console.error(`[hubtel] could not report unmatched order ${orderId} as failed:`, e);
    }
    return { matched: false, serviceStatus: 'failed' };
  }

  const rawPayload = JSON.stringify(body);
  const paid = (body.OrderInfo?.Status ?? '').toLowerCase() === 'paid' && body.OrderInfo?.Payment?.IsSuccessful !== false;
  // What Hubtel says was bought must be what the customer confirmed in the
  // menu. If it is not, the money is real but which figure to credit is a
  // person's call, not this code's.
  const items = body.OrderInfo?.Items ?? [];
  const itemsMinor = items.reduce((sum, i) => sum + toMinor((i.UnitPrice ?? 0) * (i.Quantity ?? 1)), 0);
  const amountDisagrees = paid && items.length > 0 && Math.abs(itemsMinor - txn.amountMinor) > 1;

  let settled;
  if (!paid) {
    settled = await processHubtelCallback({ clientReference: sessionId, status: 'FAILED', rawPayload });
  } else if (amountDisagrees) {
    const held = await prisma.hubtelTransaction.updateMany({
      where: { id: txn.id, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'NEEDS_REVIEW', rawCallbackPayload: rawPayload },
    });
    if (held.count > 0) {
      await raiseAlert({
        kind: 'PAYMENT_NEEDS_REVIEW',
        message: `A USSD payment was collected for GHS ${(itemsMinor / 100).toFixed(2)} but the customer confirmed GHS ${(txn.amountMinor / 100).toFixed(2)} (order ${orderId}). See Mobile Money > Needs review.`,
        dedupeKey: `payment-needs-review:${txn.id}`,
      });
      await logAudit({
        userId: null, action: 'HUBTEL_PAYMENT_UNRECORDED', entityType: 'HubtelTransaction', entityId: txn.id,
        newValues: { clientReference: sessionId, orderId, confirmedMinor: txn.amountMinor, paidForMinor: itemsMinor, reason: 'amount mismatch' },
      });
    }
    settled = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txn.id } });
  } else {
    settled = await processHubtelCallback({ clientReference: sessionId, status: 'SUCCESS', rawPayload });
  }

  const serviceStatus = settled.status === 'SUCCESS' || settled.status === 'NEEDS_REVIEW' ? 'success' : 'failed';
  await prisma.hubtelTransaction.update({
    where: { id: txn.id },
    data: {
      hubtelOrderId: orderId, fulfilmentStatus: serviceStatus,
      fulfilmentReceivedAt: txn.fulfilmentReceivedAt ?? new Date(),
      // Sent again even if Hubtel accepted it before: it is asking again.
      fulfilmentCallbackState: 'PENDING',
    },
  });
  await deliverFulfilmentCallback(txn.id);
  return { matched: true, serviceStatus };
}

/** Tells Hubtel the outcome of one fulfilled order. Never throws: a failure leaves it PENDING for the next sweep. */
async function deliverFulfilmentCallback(txnId: string): Promise<boolean> {
  const txn = await prisma.hubtelTransaction.findUniqueOrThrow({ where: { id: txnId } });
  if (!txn.hubtelOrderId || !txn.fulfilmentStatus) return false;
  try {
    await sendServiceFulfilmentCallback({
      sessionId: txn.clientReference, orderId: txn.hubtelOrderId, serviceStatus: txn.fulfilmentStatus as 'success' | 'failed',
    });
    await prisma.hubtelTransaction.update({
      where: { id: txn.id }, data: { fulfilmentCallbackState: 'SENT', fulfilmentCallbackAttempts: { increment: 1 } },
    });
    return true;
  } catch (e) {
    console.error(`[hubtel] service fulfilment callback for order ${txn.hubtelOrderId} was not accepted:`, e instanceof Error ? e.message : e);
    await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { fulfilmentCallbackAttempts: { increment: 1 } } });
    return false;
  }
}

/**
 * Sends again every fulfilment answer Hubtel has not yet accepted. Run on
 * the five-minute sweep. Once the hour Hubtel allows has passed there is no
 * point trying further: it is marked UNDELIVERED and raised as an alert,
 * since Hubtel may then treat a payment this server did apply as unfulfilled.
 */
export async function retryFulfilmentCallbacks(): Promise<{ sent: number; gaveUp: number }> {
  const waiting = await prisma.hubtelTransaction.findMany({ where: { fulfilmentCallbackState: 'PENDING' } });
  let sent = 0;
  let gaveUp = 0;
  for (const txn of waiting) {
    if (txn.fulfilmentReceivedAt && Date.now() - txn.fulfilmentReceivedAt.getTime() > CALLBACK_WINDOW_MS) {
      await prisma.hubtelTransaction.update({ where: { id: txn.id }, data: { fulfilmentCallbackState: 'UNDELIVERED' } });
      await raiseAlert({
        kind: 'FULFILMENT_CALLBACK_UNDELIVERED',
        message: `Hubtel could not be told within the hour that USSD order ${txn.hubtelOrderId} was ${txn.fulfilmentStatus === 'success' ? 'fulfilled' : 'not fulfilled'}. Check that Hubtel has whitelisted this server's IP address, and confirm the order with Hubtel.`,
        dedupeKey: `fulfilment-undelivered:${txn.id}`,
      });
      gaveUp += 1;
      continue;
    }
    if (await deliverFulfilmentCallback(txn.id)) sent += 1;
  }
  return { sent, gaveUp };
}
