/**
 * USSD payments through Hubtel's own checkout, as its Programmable Services
 * API documents: the menu answers AddToCart, Hubtel takes the money and
 * reports it to the Service Fulfilment URL, the payment is posted to the
 * contract, and Hubtel is told within the hour that it was.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, freshPhone, withLiveHubtel, hubtelHttp, type HubtelCall } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as ussdGatewayPOST } from '@/app/api/ussd/[token]/route';
import { POST as fulfilmentPOST } from '@/app/api/payments/hubtel/service-fulfilment/route';
import { createContract } from '@/lib/services/contractService';
import { reconcilePendingHubtelTransactions } from '@/lib/services/hubtelPaymentService';
import { retryFulfilmentCallbacks } from '@/lib/services/ussdCheckoutService';
import { ussdSafeText } from '@/lib/services/ussdGatewayService';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
const token = () => process.env.WEBHOOK_SHARED_TOKEN!;
const isCallback = (call: HubtelCall) => call.url.startsWith('https://gs-callback.hubtel.com:9055/callback');

beforeAll(enableOptionalContractTypes);

describe('USSD payments through Hubtel\'s checkout', () => {
  let branchId: string;
  let adminUserId: string;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
  });

  async function makeSaver(names: { firstName?: string; lastName?: string } = {}) {
    counter += 1;
    const phone = await freshPhone('024');
    const customer = await prisma.customer.create({
      data: { membershipId: `CHK-${runId}-${counter}`, firstName: names.firstName ?? 'Checkout', lastName: names.lastName ?? `Payer${counter}`, phone, branchId, createdById: adminUserId },
    });
    const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId: customer.id, branchId, createdById: adminUserId });
    return { customer, contract, phone, sessionId: `chk${runId}${counter}`.padEnd(32, '0') };
  }

  /** One step of a dial-in, exactly as Hubtel's gateway sends it to the registered address. */
  async function dial(sessionId: string, phone: string, type: 'Initiation' | 'Response', message: string) {
    const res = await ussdGatewayPOST(
      makeRequest('POST', `/api/ussd/${token()}`, {
        body: { Type: type, Mobile: `233${phone.slice(1)}`, SessionId: sessionId, ServiceCode: '713', Message: message, Operator: 'mtn', Sequence: 1, ClientState: '', Platform: 'USSD' },
      }),
      makeParams({ token: token() }),
    );
    return res.json();
  }

  /** Dial, type an amount in cedis, confirm — in live mode — and return the last answer and every outbound call made. */
  async function payThroughMenu(sessionId: string, phone: string, amountGhs: string, respond: (call: HubtelCall) => unknown = () => ({})) {
    let last: Record<string, unknown> = {};
    const calls = await withLiveHubtel(respond, async () => {
      await dial(sessionId, phone, 'Initiation', '*713#');
      await dial(sessionId, phone, 'Response', amountGhs);
      last = await dial(sessionId, phone, 'Response', '1');
    });
    return { last, calls };
  }

  /** What Hubtel posts to the Service Fulfilment URL once the customer has paid. */
  const fulfilment = (sessionId: string, orderId: string, priceGhs: number, phone: string, overrides: Record<string, unknown> = {}) => ({
    SessionId: sessionId, OrderId: orderId, ExtraData: {},
    OrderInfo: {
      CustomerMobileNumber: `233${phone.slice(1)}`, CustomerEmail: null, CustomerName: 'John Doe', Status: 'Paid',
      OrderDate: '2026-10-13T09:16:50.3581338+00:00', Currency: 'GHS', BranchName: 'Main', IsRecurring: false, RecurringInvoiceId: null,
      Subtotal: priceGhs + 1,
      Items: [{ ItemId: 'item-1', Name: 'Payment', Quantity: 1, UnitPrice: priceGhs }],
      Payment: {
        PaymentType: 'mobilemoney', AmountPaid: priceGhs + 1, AmountAfterCharges: priceGhs, PaymentDate: '2026-10-13T09:16:50.3581338+00:00',
        PaymentDescription: 'The MTN Mobile Money payment has been approved and processed successfully.', IsSuccessful: true,
      },
      ...overrides,
    },
  });
  async function fulfil(body: unknown, respond: (call: HubtelCall) => unknown = () => ({}), query = `?token=${token()}`) {
    let status = 0;
    const calls = await withLiveHubtel(respond, async () => {
      status = (await fulfilmentPOST(makeRequest('POST', `/api/payments/hubtel/service-fulfilment${query}`, { body }))).status;
    });
    return { status, calls };
  }
  const txnFor = (sessionId: string) => prisma.hubtelTransaction.findUniqueOrThrow({ where: { clientReference: sessionId } });
  const paid = async (contractId: string) => (await prisma.contract.findUniqueOrThrow({ where: { id: contractId } })).totalPaidMinor;

  it('the menu ends by handing the customer to Hubtel\'s checkout — AddToCart with the item and price — and charges nothing itself', async () => {
    const { contract, phone, sessionId } = await makeSaver();
    const { last, calls } = await payThroughMenu(sessionId, phone, '50.5');

    expect(last).toEqual({
      SessionId: sessionId,
      Type: 'AddToCart',
      Message: 'Your request has been submitted. Please wait for the payment prompt and approve it with your mobile money PIN.',
      Item: { ItemName: `Payment ${contract.contractNumber}`, Qty: 1, Price: 50.5 },
      Label: 'Approve the payment prompt',
      DataType: 'display',
      FieldType: 'text',
    });
    expect(calls).toEqual([]); // no Receive Money request — that API is not used

    // Recorded against Hubtel's own session id, waiting to hear the customer paid.
    expect(await txnFor(sessionId)).toMatchObject({ contractId: contract.id, amountMinor: 5050, status: 'PENDING', channel: 'USSD', hubtelOrderId: null });
    expect(await paid(contract.id)).toBe(0);
    expect(await prisma.ussdSession.findUnique({ where: { sessionId } })).toBeNull();
  });

  it('when Hubtel reports the payment, it is posted to the contract and Hubtel is told the service was rendered', async () => {
    const { contract, phone, sessionId } = await makeSaver();
    await payThroughMenu(sessionId, phone, '150.5');
    const orderId = `order-${runId}-a`;

    // The address carries the shared secret; without it the report is refused.
    expect((await fulfil(fulfilment(sessionId, orderId, 150.5, phone), () => ({}), '')).status).toBe(401);
    expect(await paid(contract.id)).toBe(0);

    const { status, calls } = await fulfil(fulfilment(sessionId, orderId, 150.5, phone));
    expect(status).toBe(200);
    // Credited with the price the customer agreed to — not what they paid including Hubtel's fee.
    expect(await paid(contract.id)).toBe(15050);
    const payment = await prisma.payment.findFirstOrThrow({ where: { contractId: contract.id } });
    expect(payment).toMatchObject({ amountMinor: 15050, channel: 'USSD', status: 'SUCCESS', transactionRef: sessionId });

    expect(calls.filter(isCallback)).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', body: { SessionId: sessionId, OrderId: orderId, ServiceStatus: 'success', MetaData: null } });
    expect(await txnFor(sessionId)).toMatchObject({
      status: 'SUCCESS', paymentId: payment.id, hubtelOrderId: orderId, fulfilmentStatus: 'success', fulfilmentCallbackState: 'SENT',
    });

    // Hubtel reporting it a second time posts nothing more, and is simply answered again.
    const again = await fulfil(fulfilment(sessionId, orderId, 150.5, phone));
    expect(again.status).toBe(200);
    expect(await paid(contract.id)).toBe(15050);
    expect(await prisma.payment.count({ where: { contractId: contract.id } })).toBe(1);
    expect(again.calls.filter(isCallback)).toHaveLength(1);
  });

  it('an answer Hubtel does not accept is sent again, and raised as an alert once the hour allowed has passed', async () => {
    const { contract, phone, sessionId } = await makeSaver();
    await payThroughMenu(sessionId, phone, '20');
    const orderId = `order-${runId}-b`;
    const refused = (call: HubtelCall) => (isCallback(call) ? hubtelHttp(403, '<html>403 Forbidden</html>') : {});

    // The server's IP is not whitelisted: the payment is still applied.
    expect((await fulfil(fulfilment(sessionId, orderId, 20, phone), refused)).status).toBe(200);
    expect(await paid(contract.id)).toBe(2000);
    expect(await txnFor(sessionId)).toMatchObject({ fulfilmentStatus: 'success', fulfilmentCallbackState: 'PENDING', fulfilmentCallbackAttempts: 1 });

    // The sweep keeps trying...
    await withLiveHubtel(refused, async () => { await retryFulfilmentCallbacks(); });
    expect(await txnFor(sessionId)).toMatchObject({ fulfilmentCallbackState: 'PENDING', fulfilmentCallbackAttempts: 2 });
    // ...and it goes through once Hubtel lets it.
    const retried = await withLiveHubtel(() => ({}), async () => { await retryFulfilmentCallbacks(); });
    expect(retried.filter(isCallback).map((c) => c.body)).toContainEqual({ SessionId: sessionId, OrderId: orderId, ServiceStatus: 'success', MetaData: null });
    expect((await txnFor(sessionId)).fulfilmentCallbackState).toBe('SENT');

    // One that never gets through inside the hour stops being sent and is put in front of a person.
    const late = await makeSaver();
    await payThroughMenu(late.sessionId, late.phone, '30');
    await fulfil(fulfilment(late.sessionId, `order-${runId}-late`, 30, late.phone), refused);
    await prisma.hubtelTransaction.update({ where: { clientReference: late.sessionId }, data: { fulfilmentReceivedAt: new Date(Date.now() - 61 * 60_000) } });
    const afterTheHour = await withLiveHubtel(() => ({}), async () => { await retryFulfilmentCallbacks(); });
    expect(afterTheHour.filter((c) => isCallback(c) && c.body?.SessionId === late.sessionId)).toEqual([]);
    const lateTxn = await txnFor(late.sessionId);
    expect(lateTxn.fulfilmentCallbackState).toBe('UNDELIVERED');
    const alert = await prisma.systemAlert.findUnique({ where: { dedupeKey: `fulfilment-undelivered:${lateTxn.id}` } });
    expect(alert?.message).toMatch(/could not be told within the hour/);
    expect(await paid(late.contract.id)).toBe(3000); // the customer's payment stands regardless
  });

  it('a payment that cannot be applied is held for staff, and one this server has no record of is reported as not fulfilled', async () => {
    // The contract closed between the customer confirming and Hubtel taking the money.
    const closed = await makeSaver();
    await payThroughMenu(closed.sessionId, closed.phone, '40');
    await prisma.contract.update({ where: { id: closed.contract.id }, data: { status: 'CANCELLED' } });
    const held = await fulfil(fulfilment(closed.sessionId, `order-${runId}-c`, 40, closed.phone));
    expect(await txnFor(closed.sessionId)).toMatchObject({ status: 'NEEDS_REVIEW', paymentId: null, fulfilmentStatus: 'success' });
    // Told "success": the money is accounted for here, in the review queue, not to be refunded behind staff's back.
    expect(held.calls[0].body).toMatchObject({ ServiceStatus: 'success' });

    // Hubtel says a different amount was bought than the customer confirmed.
    const odd = await makeSaver();
    await payThroughMenu(odd.sessionId, odd.phone, '60');
    await fulfil(fulfilment(odd.sessionId, `order-${runId}-d`, 6, odd.phone));
    expect(await txnFor(odd.sessionId)).toMatchObject({ status: 'NEEDS_REVIEW', amountMinor: 6000, paymentId: null });
    expect(await paid(odd.contract.id)).toBe(0);

    // Reported as not paid after all.
    const unpaid = await makeSaver();
    await payThroughMenu(unpaid.sessionId, unpaid.phone, '70');
    const notPaid = await fulfil(fulfilment(unpaid.sessionId, `order-${runId}-e`, 70, unpaid.phone, { Status: 'Unpaid' }));
    expect(await txnFor(unpaid.sessionId)).toMatchObject({ status: 'FAILED', fulfilmentStatus: 'failed' });
    expect(notPaid.calls[0].body).toMatchObject({ ServiceStatus: 'failed' });
    expect(await paid(unpaid.contract.id)).toBe(0);

    // A session nobody here started.
    const strangerOrder = `order-${runId}-x`;
    const stranger = await fulfil(fulfilment(`unknown${runId}`.padEnd(32, '0'), strangerOrder, 25, '0240000000'));
    expect(stranger.status).toBe(200);
    expect(stranger.calls[0].body).toMatchObject({ OrderId: strangerOrder, ServiceStatus: 'failed' });
    const alert = await prisma.systemAlert.findUnique({ where: { dedupeKey: `fulfilment-unmatched:${strangerOrder}` } });
    expect(alert?.message).toMatch(/GHS 26\.00 from 233240000000 that matches no session here/);

    expect((await fulfil({ OrderId: 'no-session' })).status).toBe(400);
  });

  it('if Hubtel\'s report never arrives, the status check — asked by session id — still gets the payment recorded', async () => {
    const { contract, phone, sessionId } = await makeSaver();
    await payThroughMenu(sessionId, phone, '80');
    await prisma.hubtelTransaction.update({ where: { clientReference: sessionId }, data: { createdAt: new Date(Date.now() - 6 * 60_000) } });

    const calls = await withLiveHubtel(
      (call) => (call.url.includes(`clientReference=${sessionId}`)
        ? { message: 'Successful', responseCode: '0000', data: { status: 'Paid', clientReference: sessionId, amount: 80 } }
        : { message: 'Successful', responseCode: '0000', data: { status: 'Unpaid' } }),
      async () => { await reconcilePendingHubtelTransactions(); },
    );
    expect(calls.some((c) => c.url.includes('api-txnstatus.hubtel.com') && c.url.includes(`clientReference=${sessionId}`))).toBe(true);
    expect(await txnFor(sessionId)).toMatchObject({ status: 'SUCCESS' });
    expect(await paid(contract.id)).toBe(8000);

    // The report turning up late changes nothing but lets Hubtel be answered.
    const late = await fulfil(fulfilment(sessionId, `order-${runId}-f`, 80, phone));
    expect(await paid(contract.id)).toBe(8000);
    expect(late.calls[0].body).toMatchObject({ ServiceStatus: 'success' });
  });

  it('nothing but plain text reaches a USSD screen, whatever a name contains', async () => {
    expect(ussdSafeText('Kɔfi Ésí “Nana” Ɔbɛŋ — GH₵5…\nHi')).toBe('Kofi Esi "Nana" Oben - GHS5...\nHi');

    const { phone, sessionId } = await makeSaver({ firstName: 'Kɔfi', lastName: 'Ésí-Ɔbɛŋ' });
    let first: Record<string, string> = {};
    await withLiveHubtel(() => ({}), async () => { first = await dial(sessionId, phone, 'Initiation', '*713#'); });
    expect(first.Message).toContain('Hi Kofi'); // the first name; the screen also stays plain text
    // Nothing outside plain ASCII and line breaks.
    expect(first.Message).toMatch(/^[\x20-\x7E\n]+$/);
  });

  it('can be switched back to sending the prompt itself', async () => {
    const { phone, sessionId } = await makeSaver();
    process.env.HUBTEL_USSD_PAYMENT = 'receive-money';
    try {
      const { last, calls } = await payThroughMenu(sessionId, phone, '10', (call) => ({
        Message: 'Transaction pending. Expect callback request for final state', ResponseCode: '0001', Data: { ClientReference: call.body?.ClientReference },
      }));
      expect(last.Type).toBe('release');
      expect(last).not.toHaveProperty('Item');
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toContain('receive/mobilemoney');
    } finally {
      delete process.env.HUBTEL_USSD_PAYMENT;
    }
  });
});
