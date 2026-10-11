/**
 * What happens after a customer falls behind, or a contract is cancelled:
 * the collections queue (who to chase, what was last said, whether a promise
 * was kept), rescheduling what is still owed, and refunds that stay on
 * record until someone says what was handed back.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams, enableOptionalContractTypes, freshPhone } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as collectionsGET } from '@/app/api/collections/route';
import { GET as notesGET, POST as notesPOST } from '@/app/api/contracts/[id]/collection-notes/route';
import { POST as reschedulePOST } from '@/app/api/contracts/[id]/reschedule/route';
import { POST as refundPOST } from '@/app/api/contracts/[id]/refund/route';
import { POST as cancelPOST } from '@/app/api/contracts/[id]/cancel/route';
import { GET as refundsGET } from '@/app/api/refunds/route';
import { createContract } from '@/lib/services/contractService';
import { postPayment } from '@/lib/services/paymentService';
import { markOverdueInstalments, markDefaultedContracts } from '@/lib/services/overdueService';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
const DAY = 24 * 3_600_000;
const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!123' } }));
  return (await res.json()).token as string;
}

beforeAll(enableOptionalContractTypes);

describe('After a customer falls behind', () => {
  let branchId: string;
  let adminUserId: string;
  let cashier: string;
  let manager: string;
  let auditor: string;

  beforeAll(async () => {
    branchId = (await prisma.branch.findFirstOrThrow({ where: { code: 'MAIN' } })).id;
    adminUserId = (await prisma.user.findFirstOrThrow({ where: { email: 'admin@example.test' } })).id;
    cashier = await login('cashier@example.test');
    manager = await login('branchmanager@example.test');
    auditor = await login('auditor@example.test');
  });

  /** GHS 600 phone, GHS 120 deposit paid, twelve weekly instalments of GHS 40 — started `weeksAgo` weeks back. */
  async function lateContract(weeksAgo: number) {
    counter += 1;
    const lastName = `Arrears${runId}${counter}`;
    const product = await prisma.product.create({ data: { sku: `ARR-${runId}-${counter}`, name: 'Arrears Phone', cashPriceMinor: 100000 } });
    const customer = await prisma.customer.create({
      data: { membershipId: `ARR-${runId}-${counter}`, firstName: 'Late', lastName, phone: await freshPhone(), branchId, createdById: adminUserId },
    });
    const item = await prisma.inventoryItem.create({ data: { productId: product.id, branchId, serialNumber: `ARR-SN-${runId}-${counter}` } });
    const contract = await createContract({
      contractType: 'DEPOSIT_INSTALMENT', customerId: customer.id, inventoryItemId: item.id,
      totalPayableMinor: 60000, depositAmountMinor: 12000, termWeeks: 12, paymentFrequency: 'WEEKLY',
      branchId, createdById: adminUserId, startDate: new Date(Date.now() - weeksAgo * 7 * DAY - DAY),
    });
    await postPayment({ contractId: contract.id, amountMinor: 12000, entryType: 'DEPOSIT', channel: 'CASH', createdById: adminUserId });
    await markOverdueInstalments();
    return { contract, customer, lastName };
  }

  const queue = async (token: string, query: string) => {
    const res = await collectionsGET(makeRequest('GET', `/api/collections?${query}`, { token }));
    return { status: res.status, body: res.status === 200 ? await res.json() : null };
  };
  const logContact = (token: string, contractId: string, body: Record<string, unknown>) =>
    notesPOST(makeRequest('POST', `/api/contracts/${contractId}/collection-notes`, { token, body }), makeParams({ id: contractId }));

  describe('the collections queue', () => {
    it('lists a contract in arrears with what is overdue and for how long, and leaves out one that is up to date', async () => {
      const late = await lateContract(3);      // three instalments have fallen due
      const current = await lateContract(0);   // none has

      const found = await queue(cashier, `q=${late.lastName}`);
      expect(found.body.rows).toHaveLength(1);
      expect(found.body.rows[0]).toMatchObject({
        id: late.contract.id, overdueInstalments: 3, overdueMinor: 12000, lastNote: null,
        customer: { lastName: late.lastName },
      });
      expect(found.body.rows[0].daysOverdue).toBeGreaterThanOrEqual(14);
      expect(found.body.summary).toMatchObject({ contracts: 1, overdueMinor: 12000, notContacted: 1 });

      expect((await queue(cashier, `q=${current.lastName}`)).body.rows).toEqual([]);
      expect((await queue(cashier, 'filter=NONSENSE')).status).toBe(400);
      expect((await queue(await login('storekeeper@example.test'), '')).status).toBe(403);
    });

    it('keeps the history of contacts, and brings a follow-up back on its day', async () => {
      const { contract, lastName } = await lateContract(2);

      expect((await logContact(cashier, contract.id, { outcome: 'CALLED_MAYBE' })).status).toBe(400);
      expect((await logContact(cashier, contract.id, { outcome: 'NO_ANSWER' })).status).toBe(400); // must say what happened
      expect((await logContact(auditor, contract.id, { outcome: 'NO_ANSWER', note: 'x' })).status).toBe(403); // read-only role

      const first = await logContact(cashier, contract.id, { outcome: 'NO_ANSWER', note: 'Rang twice, no answer', followUpAt: isoDay(3) });
      expect(first.status).toBe(201);
      expect((await queue(cashier, `q=${lastName}&filter=NOT_CONTACTED`)).body.rows).toEqual([]);
      expect((await queue(cashier, `q=${lastName}&filter=FOLLOW_UP_DUE`)).body.rows).toEqual([]); // not for three days

      await logContact(manager, contract.id, { outcome: 'SPOKE', note: 'Travelling, back Friday', followUpAt: isoDay(0) });
      const due = await queue(cashier, `q=${lastName}&filter=FOLLOW_UP_DUE`);
      expect(due.body.rows[0].lastNote).toMatchObject({ outcome: 'SPOKE', note: 'Travelling, back Friday', by: 'Branch Manager' });
      expect(due.body.summary.followUpDue).toBe(1);

      const history = await (await notesGET(makeRequest('GET', `/api/contracts/${contract.id}/collection-notes`, { token: auditor }), makeParams({ id: contract.id }))).json();
      expect(history.notes.map((n: { outcome: string }) => n.outcome)).toEqual(['SPOKE', 'NO_ANSWER']);
    });

    it('checks a promise to pay against what was actually paid', async () => {
      const kept = await lateContract(3);   // GHS 120 overdue
      const broken = await lateContract(2);

      expect((await logContact(cashier, kept.contract.id, { outcome: 'PROMISED' })).status).toBe(400);                           // by when?
      expect((await logContact(cashier, kept.contract.id, { outcome: 'PROMISED', promisedDate: isoDay(-2) })).status).toBe(400); // not in the past
      const promise = await logContact(cashier, kept.contract.id, { outcome: 'PROMISED', promisedAmountMinor: 8000, promisedDate: isoDay(1) });
      expect(promise.status).toBe(201);
      // A promise is its own follow-up, for the day after it falls due.
      expect((await promise.json()).note.followUpAt.slice(0, 10)).toBe(isoDay(2));

      let row = (await queue(cashier, `q=${kept.lastName}&filter=PROMISES`)).body.rows[0];
      expect(row.lastNote.promise).toEqual({ status: 'PENDING', paidMinor: 0 });

      await postPayment({ contractId: kept.contract.id, amountMinor: 5000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
      row = (await queue(cashier, `q=${kept.lastName}`)).body.rows[0];
      expect(row.lastNote.promise).toEqual({ status: 'PENDING', paidMinor: 5000 }); // part of it, so far
      await postPayment({ contractId: kept.contract.id, amountMinor: 3000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
      row = (await queue(cashier, `q=${kept.lastName}`)).body.rows[0];
      expect(row.lastNote.promise).toEqual({ status: 'KEPT', paidMinor: 8000 });
      expect((await queue(cashier, `q=${kept.lastName}&filter=PROMISES`)).body.rows).toEqual([]); // nothing left to chase

      // A promise whose day has passed with nothing paid.
      await prisma.collectionNote.create({
        data: {
          contractId: broken.contract.id, createdById: adminUserId, outcome: 'PROMISED', note: 'Promised to pay',
          promisedAmountMinor: 4000, promisedDate: new Date(Date.now() - 2 * DAY), followUpAt: new Date(Date.now() - DAY), createdAt: new Date(Date.now() - 4 * DAY),
        },
      });
      const chased = await queue(cashier, `q=${broken.lastName}&filter=PROMISES`);
      expect(chased.body.rows[0].lastNote.promise).toEqual({ status: 'BROKEN', paidMinor: 0 });
      expect(chased.body.summary).toMatchObject({ brokenPromises: 1, followUpDue: 1 });
    });
  });

  describe('rescheduling what is still owed', () => {
    const reschedule = (token: string, id: string, body: Record<string, unknown>) =>
      reschedulePOST(makeRequest('POST', `/api/contracts/${id}/reschedule`, { token, body }), makeParams({ id }));
    const plan = { termWeeks: 8, paymentFrequency: 'WEEKLY', reason: 'Lost her job; agreed smaller weekly payments' };

    it('spreads the unpaid balance over a new term without changing what is owed or what was paid', async () => {
      const { contract, lastName } = await lateContract(4); // four of twelve GHS 40 instalments overdue
      // One and a half instalments paid: no. 1 in full, no. 2 half.
      await postPayment({ contractId: contract.id, amountMinor: 6000, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
      const before = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } });
      expect(before.balanceMinor).toBe(42000);

      expect((await reschedule(cashier, contract.id, plan)).status).toBe(403);                         // needs contract.reschedule
      expect((await reschedule(manager, contract.id, { ...plan, reason: ' ' })).status).toBe(400);
      expect((await reschedule(manager, contract.id, { ...plan, termWeeks: 30 })).status).toBe(400);
      expect((await reschedule(manager, contract.id, { ...plan, paymentFrequency: 'MONTHLY' })).status).toBe(400);

      const res = await reschedule(manager, contract.id, plan);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.outstandingMinor).toBe(42000);
      expect(body.schedule).toHaveLength(8);

      const after = await prisma.contract.findUniqueOrThrow({ where: { id: contract.id }, include: { instalments: { orderBy: { instalmentNo: 'asc' } } } });
      // The money is exactly as it was.
      expect(after).toMatchObject({ totalPayableMinor: 60000, totalPaidMinor: 18000, balanceMinor: 42000, status: 'ACTIVE', instalmentAmountMinor: 5250 });
      // No. 1 stays paid; no. 2 is closed at the GHS 20 paid on it; eight new ones carry the rest.
      expect(after.instalments.map((i) => [i.instalmentNo, i.amountDueMinor, i.amountPaidMinor, i.status])).toEqual([
        [1, 4000, 4000, 'PAID'], [2, 2000, 2000, 'PAID'],
        ...Array.from({ length: 8 }, (_, n) => [3 + n, 5250, 0, 'PENDING']),
      ]);
      expect(after.instalments.reduce((s, i) => s + i.amountDueMinor - i.amountPaidMinor, 0)).toBe(42000);
      expect(after.instalments.slice(2).every((i) => i.dueDate > new Date())).toBe(true);
      // Nothing is overdue any more, so it has left the collections queue.
      expect((await queue(cashier, `q=${lastName}`)).body.rows).toEqual([]);

      // The next payment lands on the new schedule.
      await postPayment({ contractId: contract.id, amountMinor: 5250, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
      expect((await prisma.instalment.findFirstOrThrow({ where: { contractId: contract.id, instalmentNo: 3 } })).status).toBe('PAID');

      const audit = await prisma.auditLog.findFirst({ where: { action: 'CONTRACT_RESCHEDULE', entityId: contract.id } });
      expect(JSON.parse(audit!.newValues!)).toMatchObject({ reason: plan.reason, outstandingMinor: 42000 });
    });

    it('brings a defaulted contract back to active, keeps a late fee owed, and refuses a type with no schedule', async () => {
      const { contract } = await lateContract(15); // more than ninety days behind
      await markDefaultedContracts();
      expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('DEFAULTED');
      const overdue = await prisma.instalment.findFirstOrThrow({ where: { contractId: contract.id, instalmentNo: 1 } });
      const fee = await prisma.penalty.create({ data: { contractId: contract.id, instalmentId: overdue.id, amountMinor: 500, reason: 'LATE_PENALTY' } });

      const res = await reschedule(manager, contract.id, { termWeeks: 2, paymentFrequency: 'DAILY', startDate: isoDay(1), reason: 'Agreed daily payments' });
      expect(res.status).toBe(200);
      expect((await res.json()).schedule).toHaveLength(14);
      expect((await prisma.contract.findUniqueOrThrow({ where: { id: contract.id } })).status).toBe('ACTIVE');
      expect(await prisma.penalty.findUniqueOrThrow({ where: { id: fee.id } })).toMatchObject({ isPaid: false, instalmentId: null });

      const customer = await prisma.customer.create({
        data: { membershipId: `ARR-S-${runId}`, firstName: 'Saver', lastName: 'NoSchedule', phone: await freshPhone(), branchId, createdById: adminUserId },
      });
      const savings = await createContract({ contractType: 'SAVE_TO_OWN', customerId: customer.id, branchId, createdById: adminUserId });
      expect((await reschedule(manager, savings.id, plan)).status).toBe(400);
    });
  });

  describe('refunds on cancelled contracts', () => {
    const refund = (token: string, id: string, body: Record<string, unknown>) =>
      refundPOST(makeRequest('POST', `/api/contracts/${id}/refund`, { token, body }), makeParams({ id }));
    const owed = async (token: string, status = 'OWED') => (await (await refundsGET(makeRequest('GET', `/api/refunds?status=${status}`, { token }))).json());

    async function cancelledWithMoney(amountMinor: number) {
      counter += 1;
      const customer = await prisma.customer.create({
        data: { membershipId: `REF-${runId}-${counter}`, firstName: 'Refund', lastName: `Due${runId}${counter}`, phone: await freshPhone(), branchId, createdById: adminUserId },
      });
      const contract = await createContract({ contractType: 'SAVE_TO_OWN', customerId: customer.id, branchId, createdById: adminUserId });
      await postPayment({ contractId: contract.id, amountMinor, entryType: 'INSTALMENT_PAYMENT', channel: 'CASH', createdById: adminUserId });
      const res = await cancelPOST(makeRequest('POST', `/api/contracts/${contract.id}/cancel`, { token: manager, body: { reason: 'Customer withdrew' } }), makeParams({ id: contract.id }));
      expect(res.status).toBe(200);
      return contract;
    }

    it('a refund stays owed, and listed, until someone records what was handed back', async () => {
      const contract = await cancelledWithMoney(15000);
      const before = await owed(cashier);
      expect(before.refunds.find((r: { id: string }) => r.id === contract.id)).toMatchObject({ refundDueMinor: 15000, refundedAt: null });
      expect(before.owedTotalMinor).toBeGreaterThanOrEqual(15000);

      expect((await refund(cashier, contract.id, { refundedMinor: 15000 })).status).toBe(403);        // not a cashier's to record
      expect((await refund(manager, contract.id, { refundedMinor: 20000 })).status).toBe(400);        // more than was due
      expect((await refund(manager, contract.id, { refundedMinor: 10000 })).status).toBe(400);        // less, with no reason
      const partial = await refund(manager, contract.id, { refundedMinor: 10000, note: 'GHS 50 kept as agreed cancellation fee' });
      expect(partial.status).toBe(200);
      expect((await partial.json()).refund).toMatchObject({ refundDueMinor: 15000, refundedMinor: 10000, refundNote: 'GHS 50 kept as agreed cancellation fee' });
      expect((await refund(manager, contract.id, { refundedMinor: 5000, note: 'again' })).status).toBe(400); // once only

      const after = await owed(cashier);
      expect(after.refunds.find((r: { id: string }) => r.id === contract.id)).toBeUndefined();
      expect(after.owedCount).toBe(before.owedCount - 1);
      const settled = await owed(cashier, 'SETTLED');
      expect(settled.refunds.find((r: { id: string }) => r.id === contract.id)).toMatchObject({ refundedMinor: 10000, refundedByName: 'Branch Manager' });
    });

    it('a full refund needs no explanation; a contract with nothing owed has nothing to record', async () => {
      const contract = await cancelledWithMoney(7000);
      expect((await refund(manager, contract.id, { refundedMinor: 7000 })).status).toBe(200);

      const customer = await prisma.customer.create({
        data: { membershipId: `REF-N-${runId}`, firstName: 'Nothing', lastName: 'Owed', phone: await freshPhone(), branchId, createdById: adminUserId },
      });
      const live = await createContract({ contractType: 'SAVE_TO_OWN', customerId: customer.id, branchId, createdById: adminUserId });
      expect((await refund(manager, live.id, { refundedMinor: 0, note: 'x' })).status).toBe(400);
    });
  });
});
