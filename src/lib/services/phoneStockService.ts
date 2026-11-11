import type { Prisma } from '@prisma/client';
import { prisma } from '../db/prisma';
import { generateProductSku } from '../utils/idGenerators';
import { isDeviceFinancingBrand, DEVICE_FINANCING_BRANDS } from '../constants/deviceFinancing';
import { enrolPhones, type EnrolOutcome } from '../paytrigger/admin';
import { logAudit } from './auditService';
import { receiveInventoryItemInTx } from './inventoryService';
import { assignStock } from './stockAssignmentService';
import { plansProblem, savePlans, type PlanInput } from './deviceFinancingPlanService';

/**
 * Device Financing phones kept apart from every other product: their own
 * models (each with price plans) and their own stock, one unit per IMEI,
 * enrolled with PayTrigger as it comes in.
 */

export class PhoneStockError extends Error {
  constructor(message: string, readonly serials: string[] = []) {
    super(message);
  }
}

const IMEI = /^\d{15}$/;
/** Most phones received in one go. */
export const MAX_PHONES_PER_BATCH = 200;

/** Whose phones these are: the models marked as TECNO, Infinix or itel. */
async function phoneProductIds(): Promise<string[]> {
  return (await prisma.payTriggerProduct.findMany({ select: { productId: true } })).map((m) => m.productId);
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** Every phone model, with its brand, plans and how many are in stock and free to sell. */
export async function listPhones(opts: { includeInactive?: boolean; q?: string } = {}) {
  const ids = await phoneProductIds();
  const products = await prisma.product.findMany({
    where: {
      id: { in: ids },
      ...(!opts.includeInactive && { isActive: true }),
      ...(opts.q?.trim() && { OR: [{ name: { contains: opts.q.trim(), mode: 'insensitive' as const } }, { model: { contains: opts.q.trim(), mode: 'insensitive' as const } }] }),
    },
    include: { category: { select: { id: true, name: true } }, financingPlans: { orderBy: { months: 'asc' } } },
    orderBy: { name: 'asc' },
  });
  const [marks, counts] = await Promise.all([
    prisma.payTriggerProduct.findMany({ where: { productId: { in: products.map((p) => p.id) } }, select: { productId: true, brand: true } }),
    prisma.inventoryItem.groupBy({ by: ['productId', 'status'], where: { productId: { in: products.map((p) => p.id) } }, _count: true }),
  ]);
  return products.map((p) => {
    const mine = counts.filter((c) => c.productId === p.id);
    return {
      ...p,
      deviceFinancingBrand: marks.find((m) => m.productId === p.id)?.brand ?? null,
      stock: { total: mine.reduce((s, c) => s + c._count, 0), available: mine.find((c) => c.status === 'AVAILABLE')?._count ?? 0 },
    };
  });
}

export interface NewPhone {
  name: string;
  brand: string;
  model?: string;
  description?: string;
  categoryId?: string | null;
  cashPriceMinor: number;
  plans: PlanInput[];
}

/** A new phone model, marked for PayTrigger and with its plans, all saved together or not at all. */
export async function createPhone(input: NewPhone, actorId: string) {
  const name = input.name?.trim();
  if (!name) throw new PhoneStockError('Give the phone a name, e.g. Tecno Pop 20 (64/3)');
  if (!isDeviceFinancingBrand(input.brand)) throw new PhoneStockError(`The brand must be one of ${DEVICE_FINANCING_BRANDS.join(', ')}`);
  if (!Number.isInteger(input.cashPriceMinor) || input.cashPriceMinor <= 0) throw new PhoneStockError('Give the cash price, above 0');
  if (input.plans.length === 0) throw new PhoneStockError('Give the phone at least one plan');
  const problem = plansProblem(input.plans);
  if (problem) throw new PhoneStockError(problem);
  if (await prisma.product.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } })) {
    throw new PhoneStockError(`A product called ${name} already exists`);
  }

  const sku = await generateProductSku();
  const product = await prisma.$transaction(async (tx) => {
    const created = await tx.product.create({
      data: {
        sku, name, brand: input.brand, model: input.model?.trim() || null, description: input.description?.trim() || null,
        categoryId: input.categoryId || null, cashPriceMinor: input.cashPriceMinor,
      },
    });
    await tx.payTriggerProduct.create({ data: { productId: created.id, brand: input.brand, addedById: actorId } });
    await tx.deviceFinancingPlan.createMany({ data: input.plans.map((p) => ({ productId: created.id, ...p, updatedById: actorId })) });
    return created;
  });
  await logAudit({ userId: actorId, action: 'CREATE_PHONE', entityType: 'Product', entityId: product.id, newValues: { name, brand: input.brand, cashPriceMinor: input.cashPriceMinor, plans: input.plans } });
  return product;
}

/** Changes a phone model's details, and its plans when given (savePlans checks and audits them). */
export async function updatePhone(productId: string, change: { name?: string; model?: string; cashPriceMinor?: number; categoryId?: string | null; isActive?: boolean; plans?: PlanInput[] }, actorId: string) {
  const before = await prisma.product.findUnique({ where: { id: productId } });
  if (!before || !(await prisma.payTriggerProduct.findUnique({ where: { productId } }))) throw new PhoneStockError('Phone model not found');
  if (change.name !== undefined && !change.name.trim()) throw new PhoneStockError('The name cannot be empty');
  if (change.cashPriceMinor !== undefined && (!Number.isInteger(change.cashPriceMinor) || change.cashPriceMinor <= 0)) throw new PhoneStockError('Give the cash price, above 0');
  if (change.plans) {
    const problem = plansProblem(change.plans);
    if (problem) throw new PhoneStockError(problem);
  }
  const data: Prisma.ProductUpdateInput = {
    ...(change.name !== undefined && { name: change.name.trim() }),
    ...(change.model !== undefined && { model: change.model.trim() || null }),
    ...(change.cashPriceMinor !== undefined && { cashPriceMinor: change.cashPriceMinor }),
    ...(change.categoryId !== undefined && { category: change.categoryId ? { connect: { id: change.categoryId } } : { disconnect: true } }),
    ...(change.isActive !== undefined && { isActive: change.isActive }),
  };
  const after = await prisma.product.update({ where: { id: productId }, data });
  if (change.plans) await savePlans(productId, change.plans, actorId);
  await logAudit({
    userId: actorId, action: 'UPDATE_PHONE', entityType: 'Product', entityId: productId,
    oldValues: { name: before.name, model: before.model, cashPriceMinor: before.cashPriceMinor, categoryId: before.categoryId, isActive: before.isActive },
    newValues: { name: after.name, model: after.model, cashPriceMinor: after.cashPriceMinor, categoryId: after.categoryId, isActive: after.isActive },
  });
  return after;
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

/** IMEIs as typed or pasted: one per line, or separated by spaces or commas; repeats dropped. */
export function parseImeis(input: string | string[]): { imeis: string[]; invalid: string[] } {
  const raw = (Array.isArray(input) ? input : input.split(/[\s,;]+/)).map((s) => String(s).trim()).filter(Boolean);
  const imeis = [...new Set(raw)];
  return { imeis: imeis.filter((i) => IMEI.test(i)), invalid: imeis.filter((i) => !IMEI.test(i)) };
}

/**
 * Receives phones of one model into a branch, optionally straight to an
 * agent, and enrols them with PayTrigger. All are received or none: one
 * IMEI already in stock, or not an IMEI, refuses the batch and names it.
 * Enrolling never undoes the receipt: a failure is recorded on the phone,
 * and enrolment can be tried again.
 */
export async function receivePhones(params: {
  productId: string; branchId: string; imeis: string | string[]; agentId?: string | null; description?: string;
  actor: { id: string; branchId: string | null };
}): Promise<{ received: Array<{ id: string; serialNumber: string }>; enrolment: EnrolOutcome[] }> {
  const product = await prisma.product.findUnique({ where: { id: params.productId }, select: { id: true, name: true, isActive: true } });
  if (!product || !(await prisma.payTriggerProduct.findUnique({ where: { productId: params.productId } }))) throw new PhoneStockError('Choose a Device Financing phone model');
  if (!product.isActive) throw new PhoneStockError(`${product.name} is no longer sold: reactivate it first`);

  const { imeis, invalid } = parseImeis(params.imeis);
  if (invalid.length > 0) throw new PhoneStockError(`Not a 15-digit IMEI: ${invalid.join(', ')}`, invalid);
  if (imeis.length === 0) throw new PhoneStockError('Enter at least one IMEI');
  if (imeis.length > MAX_PHONES_PER_BATCH) throw new PhoneStockError(`Receive at most ${MAX_PHONES_PER_BATCH} phones at a time`);
  const taken = await prisma.inventoryItem.findMany({ where: { serialNumber: { in: imeis } }, select: { serialNumber: true } });
  if (taken.length > 0) throw new PhoneStockError(`Already in stock: ${taken.map((t) => t.serialNumber).join(', ')}`, taken.map((t) => t.serialNumber));

  if (params.agentId) {
    const agent = await prisma.user.findUnique({ where: { id: params.agentId }, select: { isActive: true, branchId: true, role: { select: { name: true } } } });
    if (!agent || agent.role.name !== 'AGENT' || !agent.isActive) throw new PhoneStockError('Phones can only be given to an active agent');
    if (agent.branchId !== params.branchId) throw new PhoneStockError('That agent works in another branch than these phones');
  }

  const received = await prisma.$transaction(async (tx) => {
    const items = [];
    for (const serialNumber of imeis) {
      items.push(await receiveInventoryItemInTx(tx, {
        productId: params.productId, branchId: params.branchId, serialNumber, description: params.description, createdById: params.actor.id,
        reason: 'Received as Device Financing stock',
      }));
    }
    return items;
  }, { timeout: 60_000 });
  await logAudit({ userId: params.actor.id, action: imeis.length === 1 ? 'ADD_PHONE' : 'BULK_ADD_PHONES', entityType: 'Product', entityId: params.productId, newValues: { count: imeis.length, imeis } });

  const ids = received.map((i) => i.id);
  if (params.agentId) await assignStock({ inventoryItemIds: ids, agentId: params.agentId, actor: params.actor, reason: 'Given to the agent on receipt' });
  const enrolment = await enrolPhones(ids, params.actor.id).catch((e: unknown) =>
    received.map((i): EnrolOutcome => ({ inventoryItemId: i.id, imei: i.serialNumber, ok: false, message: e instanceof Error ? e.message : 'PayTrigger could not be reached', dryRun: false })));
  return { received: received.map((i) => ({ id: i.id, serialNumber: i.serialNumber })), enrolment };
}

/** The phone stock, newest first: each unit with its model, agent, sale and PayTrigger state. An agent sees their own. */
export async function listPhoneStock(user: { id: string; roleName: string; branchId: string | null }, filters: {
  productId?: string; status?: string; enrolment?: 'ENROLLED' | 'NOT_ENROLLED'; agentId?: string; q?: string; page?: number;
}) {
  const ids = await phoneProductIds();
  // Enrolled: PayTrigger holds the phone, waiting for its first switch-on or switched on.
  const enrolledIds = filters.enrolment
    ? (await prisma.payTriggerDevice.findMany({ where: { enrollmentStatus: { in: ['QUEUED', 'ACTIVE'] } }, select: { inventoryItemId: true } })).map((d) => d.inventoryItemId)
    : [];
  const q = filters.q?.trim();
  const where: Prisma.InventoryItemWhereInput = {
    productId: filters.productId && ids.includes(filters.productId) ? filters.productId : { in: ids },
    ...(user.branchId && { branchId: user.branchId }),
    ...(user.roleName === 'AGENT' ? { assignedAgentId: user.id } : filters.agentId ? { assignedAgentId: filters.agentId === 'none' ? null : filters.agentId } : {}),
    ...(filters.status && { status: filters.status }),
    AND: [
      ...(filters.enrolment === 'ENROLLED' ? [{ id: { in: enrolledIds } }] : []),
      ...(filters.enrolment === 'NOT_ENROLLED' ? [{ id: { notIn: enrolledIds } }] : []),
      ...(q ? [{ OR: [{ serialNumber: { contains: q } }, { product: { name: { contains: q, mode: 'insensitive' as const } } }] }] : []),
    ],
  };
  const PAGE = 50;
  const page = Math.max(1, filters.page ?? 1);
  const [items, total] = await Promise.all([
    prisma.inventoryItem.findMany({
      where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * PAGE, take: PAGE,
      include: { product: { select: { id: true, name: true } }, assignedAgent: { select: { id: true, firstName: true, lastName: true } } },
    }),
    prisma.inventoryItem.count({ where }),
  ]);
  const devices = await prisma.payTriggerDevice.findMany({
    where: { inventoryItemId: { in: items.map((i) => i.id) } },
    select: { id: true, inventoryItemId: true, enrollmentStatus: true, committedState: true, lastError: true },
  });
  const contracts = await prisma.contract.findMany({
    where: { inventoryItemId: { in: items.map((i) => i.id) }, status: { notIn: ['CANCELLED'] } },
    select: { id: true, inventoryItemId: true, contractNumber: true, status: true, createdBy: { select: { firstName: true, lastName: true } } },
  });
  return {
    items: items.map((i) => ({ ...i, device: devices.find((d) => d.inventoryItemId === i.id) ?? null, contract: contracts.find((c) => c.inventoryItemId === i.id) ?? null })),
    total, pageSize: PAGE,
  };
}
