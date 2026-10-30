import { prisma } from '../db/prisma';
import { setProductBrand, PayTriggerError } from './admin';
import { isDeviceFinancingBrand, DEVICE_FINANCING_BRANDS, type FinancingFilter } from '../constants/deviceFinancing';

/**
 * Device Financing phones on the product, inventory and price chart pages:
 * each product's mark (PayTriggerProduct) attached as deviceFinancingBrand,
 * a ?financing= filter, and marking a product from its own form.
 */

/** Product id → brand, for the products marked. */
async function brandsByProduct(productIds?: string[]): Promise<Map<string, string>> {
  const marked = await prisma.payTriggerProduct.findMany({ where: productIds ? { productId: { in: productIds } } : {}, select: { productId: true, brand: true } });
  return new Map(marked.map((m) => [m.productId, m.brand]));
}

/** The same products, each with its brand if it is a Device Financing phone, else null. */
export async function withDeviceFinancingBrand<T extends { id: string }>(products: T[]): Promise<(T & { deviceFinancingBrand: string | null })[]> {
  const brands = await brandsByProduct(products.map((p) => p.id));
  return products.map((p) => ({ ...p, deviceFinancingBrand: brands.get(p.id) ?? null }));
}

export function parseFinancingFilter(value: string | null): FinancingFilter | null {
  return value === 'device' || value === 'regular' ? value : null;
}

/** The product ids a ?financing= filter allows, as a Prisma `in`/`notIn`; null for no filter. */
export async function financingProductIds(filter: FinancingFilter | null): Promise<{ in: string[] } | { notIn: string[] } | null> {
  if (!filter) return null;
  const ids = [...(await brandsByProduct()).keys()];
  return filter === 'device' ? { in: ids } : { notIn: ids };
}

/**
 * Marks a product as a Device Financing phone, or changes or removes its
 * mark, from the product form. Anyone who may add products may mark one: it
 * only adds the lock. Changing or removing a mark needs settings.manage, as
 * on PayTrigger > Products, since it is what keeps those phones locked.
 */
export async function setDeviceFinancingFromForm(productId: string, brand: unknown, actor: { id: string; canChangeMarks: boolean }) {
  if (brand !== null && !isDeviceFinancingBrand(brand)) throw new PayTriggerError(`deviceFinancingBrand must be one of ${DEVICE_FINANCING_BRANDS.join(', ')}, or null`);
  const current = (await prisma.payTriggerProduct.findUnique({ where: { productId }, select: { brand: true } }))?.brand ?? null;
  if (current === brand) return;
  if (current !== null && !actor.canChangeMarks) {
    throw new PayTriggerError('Only an admin who can change settings may change or remove a Device Financing mark: phones sold on Device Financing depend on it to stay locked.');
  }
  await setProductBrand(productId, brand, actor.id);
}
