import { prisma } from '../db/prisma';
import { PLAN_MONTHS_MAX, PLAN_MONTHS_MIN } from '../constants/deviceFinancing';
import { logAudit } from './auditService';

/**
 * A Device Financing phone's price list: one plan per length in months, each
 * the total the customer pays (deposit included) and the deposit. A sale
 * takes its price and deposit from the plan chosen (contractService.ts).
 */

export class PlanError extends Error {}

export interface PlanInput {
  months: number;
  totalPriceMinor: number;
  depositMinor: number;
}

const cedis = (minor: number) => `GHS ${(minor / 100).toFixed(2)}`;

/** Why these plans cannot be saved, or null. Checked on the server whatever the form allowed. */
export function plansProblem(plans: PlanInput[]): string | null {
  const seen = new Set<number>();
  for (const p of plans) {
    if (!Number.isInteger(p.months) || p.months < PLAN_MONTHS_MIN || p.months > PLAN_MONTHS_MAX) {
      return `A plan must be ${PLAN_MONTHS_MIN} to ${PLAN_MONTHS_MAX} months`;
    }
    if (seen.has(p.months)) return `The ${p.months}-month plan is given twice`;
    seen.add(p.months);
    if (!Number.isInteger(p.totalPriceMinor) || p.totalPriceMinor <= 0) return `The ${p.months}-month plan needs a total price above 0`;
    if (!Number.isInteger(p.depositMinor) || p.depositMinor < 0) return `The ${p.months}-month plan's deposit cannot be negative`;
    if (p.depositMinor >= p.totalPriceMinor) return `The ${p.months}-month plan's deposit must be less than its total price`;
  }
  const byLength = [...plans].sort((a, b) => a.months - b.months);
  for (let i = 1; i < byLength.length; i++) {
    if (byLength[i].totalPriceMinor < byLength[i - 1].totalPriceMinor) {
      return `The ${byLength[i].months}-month plan cannot cost less than the ${byLength[i - 1].months}-month plan`;
    }
  }
  return null;
}

export function listPlans(productId: string) {
  return prisma.deviceFinancingPlan.findMany({ where: { productId }, orderBy: { months: 'asc' } });
}

/** Every Device Financing phone on sale, with its plans, for the price chart. */
export async function allPlans() {
  return prisma.product.findMany({
    where: { isActive: true, financingPlans: { some: {} } },
    select: { id: true, name: true, financingPlans: { orderBy: { months: 'asc' } } },
    orderBy: { name: 'asc' },
  });
}

/** Replaces a phone's plans with these: plans left out are removed. Only a Device Financing phone has plans. */
export async function savePlans(productId: string, plans: PlanInput[], actorId: string) {
  const product = await prisma.product.findUnique({ where: { id: productId }, select: { id: true, name: true, brand: true } });
  if (!product) throw new PlanError('Product not found');
  const marked = await prisma.payTriggerProduct.findUnique({ where: { productId } });
  if (!marked) throw new PlanError('Mark this product as a Device Financing phone before giving it plans');
  const problem = plansProblem(plans);
  if (problem) throw new PlanError(problem);

  const before = await listPlans(productId);
  await prisma.$transaction(async (tx) => {
    await tx.deviceFinancingPlan.deleteMany({ where: { productId, months: { notIn: plans.map((p) => p.months) } } });
    for (const p of plans) {
      await tx.deviceFinancingPlan.upsert({
        where: { productId_months: { productId, months: p.months } },
        create: { productId, months: p.months, totalPriceMinor: p.totalPriceMinor, depositMinor: p.depositMinor, updatedById: actorId },
        update: { totalPriceMinor: p.totalPriceMinor, depositMinor: p.depositMinor, updatedById: actorId },
      });
    }
  });
  const after = await listPlans(productId);
  const shape = (rows: typeof after) => rows.map((r) => ({ months: r.months, totalPriceMinor: r.totalPriceMinor, depositMinor: r.depositMinor }));
  await logAudit({ userId: actorId, action: 'DEVICE_FINANCING_PLANS_UPDATE', entityType: 'Product', entityId: productId, oldValues: shape(before), newValues: shape(after) });
  return after;
}

/** The plan a sale is on, or why there is none. */
export async function planForSale(productId: string, months: number | undefined) {
  if (months === undefined || !Number.isInteger(months)) throw new PlanError('Choose a plan: how many months the customer will pay over');
  const plan = await prisma.deviceFinancingPlan.findUnique({ where: { productId_months: { productId, months } } });
  if (!plan) {
    const offered = (await listPlans(productId)).map((p) => `${p.months}`);
    throw new PlanError(offered.length > 0
      ? `This phone has no ${months}-month plan. It is sold on ${offered.join(', ')} months.`
      : 'This phone has no price plans yet. Add them on its product page.');
  }
  return plan;
}

export function describePlan(plan: { months: number; totalPriceMinor: number; depositMinor: number }): string {
  return `the ${plan.months}-month plan: ${cedis(plan.totalPriceMinor)} with a ${cedis(plan.depositMinor)} deposit`;
}
