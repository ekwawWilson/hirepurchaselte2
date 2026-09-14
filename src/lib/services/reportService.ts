import { prisma } from '../db/prisma';
import { CUSTOMER_SUMMARY_SELECT } from './customerService';
import { getDeviceLoanState } from './paymentService';

/** Optional branch scoping (server-applied only, per RBAC — never client-trusted beyond what the caller already resolved). */
type Scope = { branchId?: string };

function dayRange(from?: string, to?: string) {
  const start = from ? new Date(from) : new Date(new Date().setHours(0, 0, 0, 0));
  const end = to ? new Date(new Date(to).setHours(23, 59, 59, 999)) : new Date(new Date().setHours(23, 59, 59, 999));
  return { start, end };
}

/**
 * The set of payment rows that actually count toward a period's cash total:
 * effective (non-reversal) rows contribute positively, reversal rows negate
 * whatever they reversed — both counted in the period they were CREATED in,
 * not the period of the original payment. This is what "reconciles against
 * the payment ledger for that day" (mission §13) means concretely.
 */
async function netPaymentsInRange(scope: Scope, start: Date, end: Date, channel?: string) {
  const where: Record<string, unknown> = {
    status: 'SUCCESS',
    createdAt: { gte: start, lte: end },
    ...(channel && { channel }),
    ...(scope.branchId && { contract: { branchId: scope.branchId } }),
  };
  return prisma.payment.findMany({ where, include: { createdBy: true, contract: true } });
}

// 1. Daily cash received — by cashier, by branch, cash vs USSD split.
export async function dailyCashReceivedReport(scope: Scope, from?: string, to?: string) {
  const { start, end } = dayRange(from, to);
  const payments = await netPaymentsInRange(scope, start, end);

  let totalMinor = 0;
  const byChannel: Record<string, number> = { CASH: 0, USSD: 0 };
  const byCashier = new Map<string, { name: string; amountMinor: number; count: number }>();

  for (const p of payments) {
    // A WITHDRAWAL is cash actually handed back to the customer — it reduces
    // the day's net cash position the same way a reversal does. Both signs
    // can combine (a reversed withdrawal flips back to positive), matching
    // paymentService.recomputeContract's own sign convention exactly.
    const magnitude = p.entryType === 'WITHDRAWAL' ? -p.amountMinor : p.amountMinor;
    const signed = p.reversesPaymentId ? -magnitude : magnitude;
    totalMinor += signed;
    byChannel[p.channel] = (byChannel[p.channel] ?? 0) + signed;

    const key = p.createdById ?? 'system';
    const name = p.createdBy ? `${p.createdBy.firstName} ${p.createdBy.lastName}` : 'System/USSD';
    const entry = byCashier.get(key) ?? { name, amountMinor: 0, count: 0 };
    entry.amountMinor += signed;
    entry.count += 1;
    byCashier.set(key, entry);
  }

  return {
    range: { start, end },
    totalMinor,
    byChannel,
    byCashier: Array.from(byCashier.entries()).map(([userId, v]) => ({ userId, ...v })),
    transactionCount: payments.length,
  };
}

// 2. Contracts created today — by type, by user, by branch.
export async function contractsCreatedReport(scope: Scope, from?: string, to?: string) {
  const { start, end } = dayRange(from, to);
  const contracts = await prisma.contract.findMany({
    where: { createdAt: { gte: start, lte: end }, ...(scope.branchId && { branchId: scope.branchId }) },
    include: { createdBy: true },
  });

  const byType = new Map<string, { count: number; totalMinor: number }>();
  const byUser = new Map<string, { name: string; count: number; totalMinor: number }>();

  for (const c of contracts) {
    // null for SAVE_TO_OWN — open-ended savings has no target total (see
    // paymentService.recomputeContract) — counted, but contributes 0 here.
    const totalPayableMinor = c.totalPayableMinor ?? 0;
    const t = byType.get(c.contractType) ?? { count: 0, totalMinor: 0 };
    t.count += 1;
    t.totalMinor += totalPayableMinor;
    byType.set(c.contractType, t);

    const u = byUser.get(c.createdById) ?? { name: `${c.createdBy.firstName} ${c.createdBy.lastName}`, count: 0, totalMinor: 0 };
    u.count += 1;
    u.totalMinor += totalPayableMinor;
    byUser.set(c.createdById, u);
  }

  return {
    range: { start, end },
    count: contracts.length,
    totalMinor: contracts.reduce((s, c) => s + (c.totalPayableMinor ?? 0), 0),
    byType: Array.from(byType.entries()).map(([contractType, v]) => ({ contractType, ...v })),
    byUser: Array.from(byUser.entries()).map(([userId, v]) => ({ userId, ...v })),
  };
}

// 3. Daily collections vs expected.
export async function collectionsVsExpectedReport(scope: Scope, from?: string, to?: string) {
  const { start, end } = dayRange(from, to);
  const [expectedInstalments, collected] = await Promise.all([
    prisma.instalment.findMany({
      where: { dueDate: { gte: start, lte: end }, ...(scope.branchId && { contract: { branchId: scope.branchId } }) },
    }),
    dailyCashReceivedReport(scope, from, to),
  ]);
  const expectedMinor = expectedInstalments.reduce((s, i) => s + i.amountDueMinor, 0);
  return { range: { start, end }, expectedMinor, collectedMinor: collected.totalMinor, varianceMinor: collected.totalMinor - expectedMinor };
}

// 4. Payments register.
export async function paymentsRegisterReport(scope: Scope, from?: string, to?: string) {
  const { start, end } = dayRange(from, to);
  const payments = await prisma.payment.findMany({
    where: { createdAt: { gte: start, lte: end }, ...(scope.branchId && { contract: { branchId: scope.branchId } }) },
    include: { createdBy: true, contract: { select: { contractNumber: true } } },
    orderBy: { createdAt: 'desc' },
  });
  return { range: { start, end }, payments };
}

// 5. Outstanding balances / portfolio. DEPOSIT_INSTALMENT only — SAVE_TO_OWN
// is open-ended savings with no target, and DEVICE_LOAN is an open-ended
// daily-interest loan with no fixed target either (both null balanceMinor,
// see paymentService.recomputeContract) — DEVICE_LOAN's own outstanding
// amount (principal + accrued interest) is covered by loanBookReport instead.
export async function outstandingBalancesReport(scope: Scope) {
  const contracts = await prisma.contract.findMany({
    where: {
      status: { in: ['ACTIVE', 'PENDING_DEPOSIT', 'DEFAULTED'] },
      contractType: 'DEPOSIT_INSTALMENT',
      ...(scope.branchId && { branchId: scope.branchId }),
    },
    include: { customer: true },
    orderBy: { balanceMinor: 'desc' },
  });
  return {
    totalOutstandingMinor: contracts.reduce((s, c) => s + (c.balanceMinor ?? 0), 0),
    contracts: contracts.map((c) => ({
      contractId: c.id, contractNumber: c.contractNumber, customerName: `${c.customer.firstName} ${c.customer.lastName}`,
      contractType: c.contractType, balanceMinor: c.balanceMinor, totalPayableMinor: c.totalPayableMinor,
    })),
  };
}

// 6. Arrears ageing — 1-30 / 31-60 / 61-90 / 90+.
export async function arrearsAgeingReport(scope: Scope) {
  const overdue = await prisma.instalment.findMany({
    where: { status: 'OVERDUE', ...(scope.branchId && { contract: { branchId: scope.branchId } }) },
    include: { contract: { include: { customer: true } } },
  });

  const buckets = { '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 } as Record<string, number>;
  const rows = overdue.map((i) => {
    const daysPastDue = Math.floor((Date.now() - i.dueDate.getTime()) / (1000 * 60 * 60 * 24));
    const outstanding = i.amountDueMinor - i.amountPaidMinor;
    const bucket = daysPastDue <= 30 ? '1-30' : daysPastDue <= 60 ? '31-60' : daysPastDue <= 90 ? '61-90' : '90+';
    buckets[bucket] += outstanding;
    return {
      contractNumber: i.contract.contractNumber, customerName: `${i.contract.customer.firstName} ${i.contract.customer.lastName}`,
      instalmentNo: i.instalmentNo, dueDate: i.dueDate, daysPastDue, outstandingMinor: outstanding, bucket,
    };
  });

  return { buckets, rows };
}

// 7. Contract status summary.
export async function contractStatusSummaryReport(scope: Scope) {
  const contracts = await prisma.contract.findMany({ where: scope.branchId ? { branchId: scope.branchId } : {} });
  const byStatus = new Map<string, { count: number; totalMinor: number }>();
  for (const c of contracts) {
    const s = byStatus.get(c.status) ?? { count: 0, totalMinor: 0 };
    s.count += 1;
    s.totalMinor += c.totalPayableMinor ?? 0; // null for SAVE_TO_OWN — open-ended savings has no target total
    byStatus.set(c.status, s);
  }
  return Array.from(byStatus.entries()).map(([status, v]) => ({ status, ...v }));
}

// 8. Inventory position — on hand / reserved / issued, by product and location.
export async function inventoryPositionReport(scope: Scope) {
  const items = await prisma.inventoryItem.findMany({
    where: scope.branchId ? { branchId: scope.branchId } : {},
    include: { product: true, branch: true },
  });
  const key = (productId: string, branchId: string) => `${productId}::${branchId}`;
  const grouped = new Map<string, { productName: string; branchName: string; AVAILABLE: number; RESERVED: number; ISSUED: number; RETURNED: number; WRITTEN_OFF: number }>();
  for (const item of items) {
    const k = key(item.productId, item.branchId);
    const entry = grouped.get(k) ?? { productName: item.product.name, branchName: item.branch.name, AVAILABLE: 0, RESERVED: 0, ISSUED: 0, RETURNED: 0, WRITTEN_OFF: 0 };
    entry[item.status as 'AVAILABLE' | 'RESERVED' | 'ISSUED' | 'RETURNED' | 'WRITTEN_OFF'] += 1;
    grouped.set(k, entry);
  }
  return Array.from(grouped.values());
}

// 9. Devices pending release — completed SAVE_TO_OWN contracts not yet RELEASED.
export async function devicesPendingReleaseReport(scope: Scope) {
  return prisma.contract.findMany({
    where: { contractType: 'SAVE_TO_OWN', status: 'COMPLETED', ...(scope.branchId && { branchId: scope.branchId }) },
    include: { customer: { select: CUSTOMER_SUMMARY_SELECT }, inventoryItem: true },
    orderBy: { completedAt: 'asc' },
  });
}

// 10. Loan book report — Type C only.
// DEVICE_LOAN has no instalment schedule at all under the daily-simple-interest
// model (contractService.ts) — every figure here comes from
// paymentService.getDeviceLoanState instead, the same ledger-derived view
// postDeviceLoanPayment validates against.
export async function loanBookReport(scope: Scope) {
  const contracts = await prisma.contract.findMany({
    where: { contractType: 'DEVICE_LOAN', ...(scope.branchId && { branchId: scope.branchId }) },
    include: { customer: true },
  });

  const rows = await Promise.all(contracts.map(async (c) => {
    const state = await getDeviceLoanState(c.id);
    return {
      contractId: c.id, contractNumber: c.contractNumber, customerName: `${c.customer.firstName} ${c.customer.lastName}`,
      status: c.status, principalMinor: state.principalMinor,
      // DEVICE_LOAN is ACTIVE (and cash disbursed) immediately at creation — activatedAt
      // is the disbursement timestamp, the one point this report tracks money leaving
      // the till rather than coming in (docs/01-plan.md §20).
      disbursedAt: c.activatedAt,
      principalOutstandingMinor: state.principalOutstanding ? state.principalMinor : 0,
      interestEarnedMinor: state.interestPaidMinor,
      interestOutstandingMinor: state.accruedInterestMinor,
    };
  }));

  return {
    rows,
    totals: rows.reduce(
      (acc, r) => ({
        principalOutstandingMinor: acc.principalOutstandingMinor + r.principalOutstandingMinor,
        interestEarnedMinor: acc.interestEarnedMinor + r.interestEarnedMinor,
        interestOutstandingMinor: acc.interestOutstandingMinor + r.interestOutstandingMinor,
      }),
      { principalOutstandingMinor: 0, interestEarnedMinor: 0, interestOutstandingMinor: 0 },
    ),
  };
}

// 11. User activity / audit trail.
export async function auditTrailReport(from?: string, to?: string) {
  const { start, end } = dayRange(from, to);
  const entries = await prisma.auditLog.findMany({
    where: { createdAt: { gte: start, lte: end } },
    include: { user: { select: { firstName: true, lastName: true, email: true } } },
    orderBy: { createdAt: 'desc' },
    take: 500,
  });

  // Resolve a customer's name for any Customer-entity entry — the raw id
  // means nothing to a reviewer scanning the report without cross-referencing
  // the Customers page by hand for every row.
  const customerIds = [...new Set(entries.filter((e) => e.entityType === 'Customer' && e.entityId).map((e) => e.entityId as string))];
  const customers = customerIds.length
    ? await prisma.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, firstName: true, lastName: true } })
    : [];
  const customerNameById = new Map(customers.map((c) => [c.id, `${c.firstName} ${c.lastName}`]));

  return entries.map((e) => ({
    ...e,
    entityName: e.entityType === 'Customer' && e.entityId ? customerNameById.get(e.entityId) ?? null : null,
  }));
}

// 12. Customer registrations.
export async function customerRegistrationsReport(scope: Scope, from?: string, to?: string) {
  const { start, end } = dayRange(from, to);
  const customers = await prisma.customer.findMany({
    where: { createdAt: { gte: start, lte: end }, ...(scope.branchId && { branchId: scope.branchId }) },
    include: { createdBy: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' },
  });
  const byUser = new Map<string, { name: string; count: number }>();
  for (const c of customers) {
    const entry = byUser.get(c.createdById) ?? { name: `${c.createdBy.firstName} ${c.createdBy.lastName}`, count: 0 };
    entry.count += 1;
    byUser.set(c.createdById, entry);
  }
  return { count: customers.length, byUser: Array.from(byUser.entries()).map(([userId, v]) => ({ userId, ...v })), customers };
}

// Dashboard summary.
export async function dashboardSummary(scope: Scope) {
  const [cash, contractsToday, arrears, inventory] = await Promise.all([
    dailyCashReceivedReport(scope),
    contractsCreatedReport(scope),
    arrearsAgeingReport(scope),
    inventoryPositionReport(scope),
  ]);
  const arrearsTotalMinor = Object.values(arrears.buckets).reduce((s, v) => s + v, 0);
  const stockAvailable = inventory.reduce((s, i) => s + i.AVAILABLE, 0);

  return {
    todayCashMinor: cash.totalMinor,
    todayContractsCount: contractsToday.count,
    todayContractsValueMinor: contractsToday.totalMinor,
    arrearsTotalMinor,
    stockAvailable,
  };
}

/**
 * Today's payments, for the staff notification bell and banner (the legacy
 * app's DailyPaymentsBanner / NotificationBell). The count and the list are
 * money received — a reversal or a withdrawal is not "a payment came in".
 * The total is the day's net cash, the same figure as the dashboard's
 * Today's Cash, and is only computed for callers allowed to see takings.
 */
export async function todaysPaymentsFeed(scope: Scope, opts: { includeTotal: boolean; take?: number }) {
  const { start, end } = dayRange();
  const incoming = {
    status: 'SUCCESS',
    createdAt: { gte: start, lte: end },
    reversesPaymentId: null,
    entryType: { not: 'WITHDRAWAL' },
    ...(scope.branchId && { contract: { branchId: scope.branchId } }),
  };

  const [count, payments, cash] = await Promise.all([
    prisma.payment.count({ where: incoming }),
    prisma.payment.findMany({
      where: incoming,
      orderBy: { createdAt: 'desc' },
      take: opts.take ?? 10,
      select: {
        id: true, amountMinor: true, channel: true, entryType: true, receiptNumber: true, createdAt: true,
        contract: {
          select: {
            id: true, contractNumber: true,
            customer: { select: { firstName: true, lastName: true, membershipId: true } },
          },
        },
      },
    }),
    opts.includeTotal ? dailyCashReceivedReport(scope) : Promise.resolve(null),
  ]);

  return {
    date: start.toISOString().slice(0, 10),
    count,
    ...(cash && { totalMinor: cash.totalMinor }),
    payments,
  };
}
