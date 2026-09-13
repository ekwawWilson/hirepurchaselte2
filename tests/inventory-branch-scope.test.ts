/**
 * A branch-scoped user may only adjust or transfer stock their own branch
 * holds — the per-item routes check the item's branch server-side.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, makeParams } from './helpers';
import { prisma } from '@/lib/db/prisma';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as adjustPOST } from '@/app/api/inventory/[id]/adjust/route';
import { POST as transferPOST } from '@/app/api/inventory/[id]/transfer/route';

const runId = Date.now().toString().slice(-8) + Math.floor(Math.random() * 1000);

async function login(email: string): Promise<string> {
  const res = await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email, password: 'Passw0rd!123' } }));
  return (await res.json()).token as string;
}

describe('Inventory item routes are branch-scoped', () => {
  let manager: string;
  let admin: string;
  let managerBranchId: string;
  let otherBranchItemId: string;

  beforeAll(async () => {
    manager = await login('branchmanager@example.test');
    admin = await login('admin@example.test');
    const managerUser = await prisma.user.findFirstOrThrow({ where: { email: 'branchmanager@example.test' } });
    managerBranchId = managerUser.branchId!;

    const otherBranch = await prisma.branch.create({ data: { name: `Other ${runId}`, code: `OTH-${runId}` } });
    const product = await prisma.product.create({ data: { sku: `INVSCOPE-${runId}`, name: 'Scope Phone', cashPriceMinor: 100000 } });
    const item = await prisma.inventoryItem.create({
      data: { productId: product.id, branchId: otherBranch.id, serialNumber: `INVSCOPE-SN-${runId}` },
    });
    otherBranchItemId = item.id;
  });

  it("refuses a branch manager adjusting or transferring another branch's item", async () => {
    const adjust = await adjustPOST(
      makeRequest('POST', `/api/inventory/${otherBranchItemId}/adjust`, { token: manager, body: { toStatus: 'WRITTEN_OFF', reason: 'Lost' } }),
      makeParams({ id: otherBranchItemId }),
    );
    expect(adjust.status).toBe(403);

    const transfer = await transferPOST(
      makeRequest('POST', `/api/inventory/${otherBranchItemId}/transfer`, { token: manager, body: { toBranchId: managerBranchId, reason: 'Take it' } }),
      makeParams({ id: otherBranchItemId }),
    );
    expect(transfer.status).toBe(403);

    const untouched = await prisma.inventoryItem.findUniqueOrThrow({ where: { id: otherBranchItemId } });
    expect(untouched.status).toBe('AVAILABLE');
    expect(untouched.branchId).not.toBe(managerBranchId);
  });

  it('still lets an all-branch admin adjust it, and 404s an unknown item', async () => {
    const adjust = await adjustPOST(
      makeRequest('POST', `/api/inventory/${otherBranchItemId}/adjust`, { token: admin, body: { toStatus: 'RETURNED', reason: 'Recount' } }),
      makeParams({ id: otherBranchItemId }),
    );
    expect(adjust.status).toBe(200);

    const missing = await adjustPOST(
      makeRequest('POST', '/api/inventory/does-not-exist/adjust', { token: admin, body: { toStatus: 'RETURNED', reason: 'Recount' } }),
      makeParams({ id: 'does-not-exist' }),
    );
    expect(missing.status).toBe(404);
  });
});
