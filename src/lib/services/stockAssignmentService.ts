import { prisma } from '../db/prisma';
import { logAudit } from './auditService';

/**
 * Stock held by agents. A unit assigned to an agent is theirs to sell: an
 * AGENT sees and sells only the units assigned to them (contractService,
 * the inventory list), while other staff may sell any unit in their branch.
 * Every hand-over is kept (InventoryAssignment), so who held a phone when is
 * always known.
 */

export class StockAssignmentError extends Error {}

/** Units on a customer's contract (reserved or sold) belong to that sale and are never moved. */
const MOVABLE_STATUSES = ['AVAILABLE'];

/**
 * Hands units to an agent, or takes them back into the shop (agentId null).
 * The agent must be an active AGENT in the units' branch. Refused as a whole,
 * listing the serials, if any unit cannot be moved; units already with that
 * agent are left alone.
 */
export async function assignStock(params: {
  inventoryItemIds: string[];
  agentId: string | null;
  reason?: string;
  actor: { id: string; branchId: string | null };
}): Promise<{ moved: number; alreadyThere: number }> {
  const ids = [...new Set(params.inventoryItemIds)];
  if (ids.length === 0) throw new StockAssignmentError('Choose at least one unit');
  if (ids.length > 500) throw new StockAssignmentError('Assign at most 500 units at a time');

  const items = await prisma.inventoryItem.findMany({ where: { id: { in: ids } }, select: { id: true, serialNumber: true, status: true, branchId: true, assignedAgentId: true } });
  if (items.length !== ids.length) throw new StockAssignmentError('Some of these units no longer exist');
  if (params.actor.branchId && items.some((i) => i.branchId !== params.actor.branchId)) {
    throw new StockAssignmentError('You can only assign stock in your own branch');
  }
  const onContract = items.filter((i) => !MOVABLE_STATUSES.includes(i.status));
  if (onContract.length > 0) {
    throw new StockAssignmentError(`These units are on a customer's contract and stay with that sale: ${onContract.map((i) => `${i.serialNumber} (${i.status.toLowerCase()})`).join(', ')}`);
  }

  let agentName: string | null = null;
  if (params.agentId) {
    const agent = await prisma.user.findUnique({ where: { id: params.agentId }, select: { isActive: true, branchId: true, firstName: true, lastName: true, role: { select: { name: true } } } });
    if (!agent || agent.role.name !== 'AGENT') throw new StockAssignmentError('Stock can only be assigned to an agent');
    if (!agent.isActive) throw new StockAssignmentError('That agent is deactivated');
    const elsewhere = items.filter((i) => i.branchId !== agent.branchId);
    if (elsewhere.length > 0) {
      throw new StockAssignmentError(`The agent works in another branch than these units: ${elsewhere.map((i) => i.serialNumber).join(', ')}. Transfer them to the agent's branch first.`);
    }
    agentName = `${agent.firstName} ${agent.lastName}`;
  }

  const toMove = items.filter((i) => i.assignedAgentId !== params.agentId);
  if (toMove.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.inventoryItem.updateMany({ where: { id: { in: toMove.map((i) => i.id) } }, data: { assignedAgentId: params.agentId } });
      await tx.inventoryAssignment.createMany({
        data: toMove.map((i) => ({
          inventoryItemId: i.id, fromAgentId: i.assignedAgentId, toAgentId: params.agentId,
          assignedById: params.actor.id, reason: params.reason?.trim() || null,
        })),
      });
    });
    await logAudit({
      userId: params.actor.id, action: params.agentId ? 'ASSIGN_STOCK' : 'UNASSIGN_STOCK', entityType: 'InventoryItem',
      newValues: { agentId: params.agentId, agentName, serials: toMove.map((i) => i.serialNumber), reason: params.reason ?? null },
    });
  }
  return { moved: toMove.length, alreadyThere: items.length - toMove.length };
}

/** Why `agentId` may not sell this unit, or null. Only checked for AGENT sellers. */
export function agentSaleProblem(item: { assignedAgentId: string | null }, agentId: string): string | null {
  if (item.assignedAgentId === agentId) return null;
  return item.assignedAgentId
    ? 'This unit is assigned to another agent: only they can sell it.'
    : 'This unit is not assigned to you. Ask your branch manager to assign it to you before selling it.';
}

/** Every agent in the caller's branches, with how many units each holds by status. */
export async function agentStockOverview(branchId: string | null) {
  const agents = await prisma.user.findMany({
    where: { role: { name: 'AGENT' }, isActive: true, ...(branchId && { branchId }) },
    select: { id: true, firstName: true, lastName: true, branchId: true, branch: { select: { name: true } } },
    orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
  });
  const counts = await prisma.inventoryItem.groupBy({
    by: ['assignedAgentId', 'status'], where: { assignedAgentId: { in: agents.map((a) => a.id) } }, _count: true,
  });
  return agents.map((a) => {
    const held = counts.filter((c) => c.assignedAgentId === a.id);
    const count = (status: string) => held.find((c) => c.status === status)?._count ?? 0;
    return { ...a, available: count('AVAILABLE'), reserved: count('RESERVED'), issued: count('ISSUED') };
  });
}

/** Who held a unit, newest first, with names. */
export async function assignmentHistory(inventoryItemId: string) {
  const rows = await prisma.inventoryAssignment.findMany({ where: { inventoryItemId }, orderBy: { createdAt: 'desc' }, take: 100 });
  const userIds = [...new Set(rows.flatMap((r) => [r.fromAgentId, r.toAgentId, r.assignedById]).filter((id): id is string => !!id))];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, firstName: true, lastName: true } });
  const name = (id: string | null) => {
    const u = users.find((x) => x.id === id);
    return u ? `${u.firstName} ${u.lastName}` : null;
  };
  return rows.map((r) => ({ ...r, fromAgentName: name(r.fromAgentId), toAgentName: name(r.toAgentId), assignedByName: name(r.assignedById) }));
}
