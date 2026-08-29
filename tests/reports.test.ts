import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams } from './helpers';
import { prisma } from '@/lib/db/prisma';

import { POST as loginPOST } from '@/app/api/auth/login/route';
import { GET as branchesGET } from '@/app/api/branches/route';
import { POST as productsPOST } from '@/app/api/products/route';
import { POST as priceChartPOST } from '@/app/api/price-chart/route';
import { POST as customersPOST } from '@/app/api/customers/route';
import { POST as inventoryPOST } from '@/app/api/inventory/route';
import { POST as contractsPOST } from '@/app/api/contracts/route';
import { POST as paymentsCashPOST } from '@/app/api/payments/cash/route';
import { POST as paymentReversePOST } from '@/app/api/payments/[id]/reverse/route';
import { GET as dailyCashGET } from '@/app/api/reports/daily-cash/route';
import { GET as arrearsGET } from '@/app/api/reports/arrears-ageing/route';
import { GET as auditTrailGET } from '@/app/api/reports/audit-trail/route';
import { GET as dashboardGET } from '@/app/api/dashboard/route';

const PASSWORD = 'Passw0rd!123';
const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);
let counter = 0;
function uniquePhone() {
  counter += 1;
  return `027${runId}${counter}`;
}

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: PASSWORD } }));
  return (await res.json()).token as string;
}

describe('Reports', () => {
  let admin: string;
  let cashier: string;
  let sales: string;
  let branchId: string;
  let productId: string;

  beforeAll(async () => {
    admin = await login('admin@zple.test');
    cashier = await login('cashier@zple.test');
    sales = await login('sales@zple.test');

    branchId = (await (await branchesGET(makeRequest('GET', '/api/branches', { token: admin }))).json()).branches[0].id;

    const product = await productsPOST(makeRequest('POST', '/api/products', {
      token: admin, body: { sku: `REPORT-SKU-${runId}`, name: 'Report Test Phone', cashPriceMinor: 240000 },
    }));
    productId = (await product.json()).product.id;

    await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'SAVE_TO_OWN', termMonths: 6, depositAmountMinor: 0, totalPayableMinor: 240000 },
    }));
    // SAVE_TO_OWN has no instalment schedule (free-form savings — see contractService.ts) —
    // the arrears test below needs a real Instalment row to backdate, so it uses this
    // DEPOSIT_INSTALMENT entry instead (0% deposit keeps its finance amount identical).
    await priceChartPOST(makeRequest('POST', '/api/price-chart', {
      token: admin, body: { productId, contractType: 'DEPOSIT_INSTALMENT', termMonths: 6, depositAmountMinor: 0, totalPayableMinor: 240000 },
    }));
  });

  async function setupContract(label: string, contractType: string = 'SAVE_TO_OWN') {
    const phone = uniquePhone();
    const customer = await customersPOST(makeRequest('POST', '/api/customers', {
      token: cashier, body: { firstName: 'Report', lastName: label, phone },
    }));
    const custId = (await customer.json()).customer.id;
    const item = await inventoryPOST(makeRequest('POST', '/api/inventory', {
      token: admin, body: { productId, serialNumber: `IMEI-RPT-${label}-${runId}`, branchId },
    }));
    const itemId = (await item.json()).item.id;
    const contract = await contractsPOST(makeRequest('POST', '/api/contracts', {
      token: cashier, body: { contractType, customerId: custId, inventoryItemId: itemId, termMonths: 6 },
    }));
    return (await contract.json()).contract;
  }

  it('daily cash report total reconciles exactly against the raw payment ledger for the day, including a reversal', async () => {
    const c1 = await setupContract('Cash1');
    const c2 = await setupContract('Cash2');

    const p1 = await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: c1.id, amountMinor: 15000, entryType: 'INSTALMENT_PAYMENT' },
    }));
    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: c2.id, amountMinor: 22000, entryType: 'INSTALMENT_PAYMENT' },
    }));
    const paymentId1 = (await p1.json()).payment.id;

    // Reverse one of them — the reconciliation must reflect the net effect.
    await paymentReversePOST(
      makeRequest('POST', `/api/payments/${paymentId1}/reverse`, { token: admin, body: { reason: 'test' } }),
      makeParams({ id: paymentId1 }),
    );

    const today = new Date().toISOString().slice(0, 10);
    const reportRes = await dailyCashGET(makeRequest('GET', `/api/reports/daily-cash?from=${today}&to=${today}`, { token: admin }));
    expect(reportRes.status).toBe(200);
    const report = await reportRes.json();

    // Independently sum the raw ledger for today the same way the mission's acceptance test would:
    // all SUCCESS payments created today, effective rows positive, reversal rows negative.
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);
    const rawPayments = await prisma.payment.findMany({ where: { status: 'SUCCESS', createdAt: { gte: start, lte: end } } });
    const expectedTotal = rawPayments.reduce((sum, p) => sum + (p.reversesPaymentId ? -p.amountMinor : p.amountMinor), 0);

    expect(report.totalMinor).toBe(expectedTotal);
    // Sanity: our two payments (15000 + 22000) minus the reversed one (15000) nets to at least 22000 among today's total.
    expect(report.totalMinor).toBeGreaterThanOrEqual(22000);
  });

  it('arrears ageing report buckets an overdue instalment correctly', async () => {
    const contract = await setupContract('Arrears', 'DEPOSIT_INSTALMENT');
    // Force the first instalment's due date into the past and mark it OVERDUE directly (simulating the cron sweep).
    const inst = await prisma.instalment.findFirstOrThrow({ where: { contractId: contract.id, instalmentNo: 1 } });
    await prisma.instalment.update({ where: { id: inst.id }, data: { dueDate: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000), status: 'OVERDUE' } });

    const res = await arrearsGET(makeRequest('GET', '/api/reports/arrears-ageing', { token: admin }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.buckets['31-60']).toBeGreaterThanOrEqual(inst.amountDueMinor);
    expect(body.rows.some((r: { contractNumber: string; bucket: string }) => r.contractNumber === contract.contractNumber && r.bucket === '31-60')).toBe(true);
  });

  it('audit trail captures contract creation and payment recording with the acting user', async () => {
    const contract = await setupContract('Audit');
    await paymentsCashPOST(makeRequest('POST', '/api/payments/cash', {
      token: cashier, body: { contractId: contract.id, amountMinor: 5000, entryType: 'INSTALMENT_PAYMENT' },
    }));

    const res = await auditTrailGET(makeRequest('GET', '/api/reports/audit-trail', { token: admin }));
    expect(res.status).toBe(200);
    const { entries } = await res.json();
    expect(entries.some((e: { action: string; entityId: string }) => e.action === 'CONTRACT_CREATE' && e.entityId === contract.id)).toBe(true);
    expect(entries.some((e: { action: string }) => e.action === 'PAYMENT_CASH_RECORD')).toBe(true);
  });

  it('RBAC: SALES (no report permission) gets 403 on reports and dashboard; ADMIN gets 200', async () => {
    const forbidden = await dailyCashGET(makeRequest('GET', '/api/reports/daily-cash', { token: sales }));
    expect(forbidden.status).toBe(403);

    const forbiddenDash = await dashboardGET(makeRequest('GET', '/api/dashboard', { token: sales }));
    expect(forbiddenDash.status).toBe(403);

    const allowed = await dashboardGET(makeRequest('GET', '/api/dashboard', { token: admin }));
    expect(allowed.status).toBe(200);
    const summary = await allowed.json();
    expect(typeof summary.todayCashMinor).toBe('number');
  });

  it('RBAC: only audit.view holders (not plain report.view.branch) can read the audit trail', async () => {
    const forbidden = await auditTrailGET(makeRequest('GET', '/api/reports/audit-trail', { token: cashier }));
    expect(forbidden.status).toBe(403); // CASHIER has report.view.branch but not audit.view
  });
});
