import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { contractSearchWhere } from '../utils/search';

export class FollowUpError extends Error {}

export const CONTACT_OUTCOMES = ['NO_ANSWER', 'SPOKE', 'PROMISED', 'VISITED', 'OTHER'] as const;
export type ContactOutcome = (typeof CONTACT_OUTCOMES)[number];

export const COLLECTIONS_FILTERS = ['ALL', 'FOLLOW_UP_DUE', 'PROMISES', 'NOT_CONTACTED'] as const;
export type CollectionsFilter = (typeof COLLECTIONS_FILTERS)[number];

const DAY_MS = 24 * 3_600_000;
const startOfToday = () => new Date(new Date().setHours(0, 0, 0, 0));
const endOfToday = () => new Date(new Date().setHours(23, 59, 59, 999));

type Scope = { branchId?: string; createdById?: string };

/**
 * A contract is in arrears when an instalment is overdue, or — a device
 * loan, which has no instalments — when it has defaulted on its interest.
 * The same line the arrears report and the DEFAULTED sweep draw.
 */
const IN_ARREARS: Prisma.ContractWhereInput = {
  OR: [
    { status: { in: ['ACTIVE', 'DEFAULTED'] }, instalments: { some: { status: 'OVERDUE' } } },
    { status: 'DEFAULTED' },
  ],
};

/**
 * Whether a promise to pay was kept: the customer paid at least what they
 * promised between making the promise and the end of the promised day.
 * PENDING until that day has passed.
 */
function promiseState(
  note: { createdAt: Date; promisedAmountMinor: number | null; promisedDate: Date | null },
  payments: { amountMinor: number; receivedAt: Date | null; createdAt: Date }[],
) {
  if (!note.promisedDate) return null;
  const deadline = new Date(new Date(note.promisedDate).setHours(23, 59, 59, 999));
  const paidMinor = payments
    .filter((p) => { const at = p.receivedAt ?? p.createdAt; return at >= note.createdAt && at <= deadline; })
    .reduce((s, p) => s + p.amountMinor, 0);
  const kept = paidMinor > 0 && paidMinor >= (note.promisedAmountMinor ?? 1);
  return { status: kept ? 'KEPT' as const : deadline < new Date() ? 'BROKEN' as const : 'PENDING' as const, paidMinor };
}

/**
 * The work queue for whoever chases late payers: every contract in arrears,
 * worst first, with what is overdue, how long, and where the last
 * conversation left it — so the next call starts from the last one, and a
 * promise to pay is checked against what was actually paid.
 */
export async function listCollectionsQueue(params: { scope: Scope; filter?: CollectionsFilter; q?: string }) {
  const contracts = await prisma.contract.findMany({
    where: { ...params.scope, AND: [IN_ARREARS, ...(params.q ? contractSearchWhere(params.q) : [])] },
    select: {
      id: true, contractNumber: true, contractType: true, status: true, balanceMinor: true, paymentMethod: true,
      customer: { select: { id: true, firstName: true, lastName: true, phone: true, phone2: true, phone3: true, guarantorName: true, guarantorPhone: true } },
      instalments: { where: { status: 'OVERDUE' }, select: { dueDate: true, amountDueMinor: true, amountPaidMinor: true } },
      penalties: { where: { isPaid: false }, select: { amountMinor: true, appliedDate: true } },
      collectionNotes: { orderBy: { createdAt: 'desc' }, take: 1, include: { createdBy: { select: { firstName: true, lastName: true } } } },
      payments: {
        where: { status: 'SUCCESS', reversesPaymentId: null, reversedById: null, entryType: { not: 'WITHDRAWAL' } },
        orderBy: { createdAt: 'desc' }, take: 20, select: { amountMinor: true, receivedAt: true, createdAt: true },
      },
    },
    take: 500,
  });

  const now = Date.now();
  const rows = contracts.map((c) => {
    const overdueInstalmentsMinor = c.instalments.reduce((s, i) => s + (i.amountDueMinor - i.amountPaidMinor), 0);
    const unpaidChargesMinor = c.penalties.reduce((s, p) => s + p.amountMinor, 0);
    const oldest = [...c.instalments.map((i) => i.dueDate), ...(c.instalments.length ? [] : c.penalties.map((p) => p.appliedDate))]
      .reduce<Date | null>((min, d) => (!min || d < min ? d : min), null);
    const lastNote = c.collectionNotes[0] ?? null;
    return {
      id: c.id, contractNumber: c.contractNumber, contractType: c.contractType, status: c.status,
      balanceMinor: c.balanceMinor, paymentMethod: c.paymentMethod, customer: c.customer,
      overdueMinor: overdueInstalmentsMinor + unpaidChargesMinor,
      overdueInstalments: c.instalments.length,
      daysOverdue: oldest ? Math.max(0, Math.floor((now - oldest.getTime()) / DAY_MS)) : 0,
      lastPayment: c.payments[0] ?? null,
      lastNote: lastNote && {
        outcome: lastNote.outcome, note: lastNote.note, createdAt: lastNote.createdAt, followUpAt: lastNote.followUpAt,
        promisedAmountMinor: lastNote.promisedAmountMinor, promisedDate: lastNote.promisedDate,
        by: `${lastNote.createdBy.firstName} ${lastNote.createdBy.lastName}`,
        promise: promiseState(lastNote, c.payments),
      },
    };
  });

  const followUpDue = (r: (typeof rows)[number]) => !!r.lastNote?.followUpAt && r.lastNote.followUpAt <= endOfToday();
  const openPromise = (r: (typeof rows)[number]) => !!r.lastNote?.promise && r.lastNote.promise.status !== 'KEPT';
  const summary = {
    contracts: rows.length,
    overdueMinor: rows.reduce((s, r) => s + r.overdueMinor, 0),
    followUpDue: rows.filter(followUpDue).length,
    brokenPromises: rows.filter((r) => r.lastNote?.promise?.status === 'BROKEN').length,
    notContacted: rows.filter((r) => !r.lastNote).length,
  };

  const filter = params.filter ?? 'ALL';
  const shown = rows.filter((r) =>
    filter === 'FOLLOW_UP_DUE' ? followUpDue(r)
      : filter === 'PROMISES' ? openPromise(r)
      : filter === 'NOT_CONTACTED' ? !r.lastNote
      : true);
  // Longest overdue first; among equals, the most money.
  shown.sort((a, b) => b.daysOverdue - a.daysOverdue || b.overdueMinor - a.overdueMinor);
  return { rows: shown, summary };
}

/** How many follow-ups fall due today or earlier — for the Needs attention panel. */
export async function countFollowUpsDue(scope: Scope): Promise<number> {
  return (await listCollectionsQueue({ scope, filter: 'FOLLOW_UP_DUE' })).rows.length;
}

export async function listCollectionNotes(contractId: string) {
  const [notes, payments] = await Promise.all([
    prisma.collectionNote.findMany({
      where: { contractId }, orderBy: { createdAt: 'desc' }, take: 100,
      include: { createdBy: { select: { firstName: true, lastName: true } } },
    }),
    prisma.payment.findMany({
      where: { contractId, status: 'SUCCESS', reversesPaymentId: null, reversedById: null, entryType: { not: 'WITHDRAWAL' } },
      select: { amountMinor: true, receivedAt: true, createdAt: true },
    }),
  ]);
  return notes.map((n) => ({ ...n, promise: promiseState(n, payments) }));
}

export async function addCollectionNote(params: {
  contractId: string; userId: string; outcome: string; note?: string;
  promisedAmountMinor?: number | null; promisedDate?: string | null; followUpAt?: string | null;
}) {
  if (!(CONTACT_OUTCOMES as readonly string[]).includes(params.outcome)) {
    throw new FollowUpError(`outcome must be one of: ${CONTACT_OUTCOMES.join(', ')}`);
  }
  const note = params.note?.trim() ?? '';
  const date = (value: string | null | undefined, label: string) => {
    if (!value) return null;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new FollowUpError(`${label} is not a valid date`);
    return d;
  };
  const promisedDate = date(params.promisedDate, 'The promised date');
  let followUpAt = date(params.followUpAt, 'The follow-up date');

  if (params.outcome === 'PROMISED') {
    if (!promisedDate) throw new FollowUpError('Say what date the customer promised to pay by');
    if (promisedDate < startOfToday()) throw new FollowUpError('The promised date cannot be in the past');
    if (params.promisedAmountMinor != null && (!Number.isInteger(params.promisedAmountMinor) || params.promisedAmountMinor <= 0)) {
      throw new FollowUpError('The promised amount must be more than zero');
    }
    // A promise is its own follow-up: the day after, somebody checks it was kept.
    followUpAt ??= new Date(promisedDate.getTime() + DAY_MS);
  } else if (!note) {
    throw new FollowUpError('Write what happened');
  }

  return prisma.collectionNote.create({
    data: {
      contractId: params.contractId, createdById: params.userId, outcome: params.outcome,
      note: note || 'Promised to pay',
      promisedAmountMinor: params.outcome === 'PROMISED' ? params.promisedAmountMinor ?? null : null,
      promisedDate: params.outcome === 'PROMISED' ? promisedDate : null,
      followUpAt,
    },
    include: { createdBy: { select: { firstName: true, lastName: true } } },
  });
}
