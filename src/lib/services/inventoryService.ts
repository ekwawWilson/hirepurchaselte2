import { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';

type Db = Prisma.TransactionClient | typeof prisma;

/** Legal (fromStatus -> toStatus) transitions per movement type. ADJUSTMENT's target is caller-supplied. */
const TRANSITIONS: Record<string, { from: string[]; to?: string }> = {
  RESERVE: { from: ['AVAILABLE'], to: 'RESERVED' },
  ISSUE: { from: ['AVAILABLE', 'RESERVED'], to: 'ISSUED' },
  RETURN: { from: ['ISSUED', 'RESERVED'], to: 'AVAILABLE' },
  TRANSFER: { from: ['AVAILABLE'], to: 'AVAILABLE' },
  ADJUSTMENT: { from: ['AVAILABLE', 'RESERVED', 'ISSUED', 'RETURNED', 'WRITTEN_OFF'] },
};

export async function receiveInventoryItem(params: {
  productId: string;
  branchId: string;
  serialNumber: string;
  createdById: string;
  description?: string;
  reason?: string;
}) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.inventoryItem.create({
      data: {
        productId: params.productId,
        branchId: params.branchId,
        serialNumber: params.serialNumber,
        description: params.description || null,
        status: 'AVAILABLE',
      },
    });
    await tx.stockMovement.create({
      data: {
        inventoryItemId: item.id,
        productId: params.productId,
        branchId: params.branchId,
        type: 'RECEIPT',
        reason: params.reason,
        createdById: params.createdById,
      },
    });
    return item;
  });
}

/**
 * The single place inventory status changes and stock-movement rows get written together —
 * keeps InventoryItem.status and the stock_movements ledger from ever drifting apart.
 * Accepts an optional transaction client so callers (e.g. contract creation) can include
 * the movement atomically in their own transaction.
 */
export async function applyStockMovement(params: {
  inventoryItemId: string;
  type: 'RESERVE' | 'ISSUE' | 'RETURN' | 'TRANSFER' | 'ADJUSTMENT';
  toStatus?: string; // required for ADJUSTMENT
  toBranchId?: string; // required for TRANSFER
  referenceType?: string;
  referenceId?: string;
  reason?: string;
  createdById: string;
  tx?: Db;
}) {
  const db: Db = params.tx ?? prisma;

  const item = await db.inventoryItem.findUniqueOrThrow({ where: { id: params.inventoryItemId } });
  const transition = TRANSITIONS[params.type];

  if (!transition.from.includes(item.status)) {
    throw new Error(`Cannot ${params.type} an item in status ${item.status} (must be one of: ${transition.from.join(', ')})`);
  }

  let toStatus = transition.to;
  if (params.type === 'ADJUSTMENT') {
    if (!params.toStatus) throw new Error('toStatus is required for an ADJUSTMENT movement');
    toStatus = params.toStatus;
  }
  if (params.type === 'TRANSFER' && !params.toBranchId) {
    throw new Error('toBranchId is required for a TRANSFER movement');
  }

  const updated = await db.inventoryItem.update({
    where: { id: item.id },
    data: {
      ...(toStatus && { status: toStatus }),
      ...(params.type === 'TRANSFER' && { branchId: params.toBranchId }),
    },
  });

  await db.stockMovement.create({
    data: {
      inventoryItemId: item.id,
      productId: item.productId,
      branchId: updated.branchId,
      type: params.type,
      fromBranchId: params.type === 'TRANSFER' ? item.branchId : undefined,
      toBranchId: params.type === 'TRANSFER' ? params.toBranchId : undefined,
      referenceType: params.referenceType,
      referenceId: params.referenceId,
      reason: params.reason,
      createdById: params.createdById,
    },
  });

  return updated;
}
