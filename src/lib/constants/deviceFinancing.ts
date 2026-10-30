/**
 * Device Financing phones: products marked as TECNO, Infinix or itel, which
 * PayTrigger can lock. Kept apart from every other product: sold only on
 * Device Financing (paytrigger/saleGuard.ts), and badged wherever products
 * and stock are listed. Shared by the server and the pages.
 */

export const DEVICE_FINANCING_BRANDS = ['TECNO', 'INFINIX', 'ITEL'] as const;
export type DeviceFinancingBrand = (typeof DEVICE_FINANCING_BRANDS)[number];

export const DEVICE_FINANCING_BRAND_LABELS: Record<DeviceFinancingBrand, string> = { TECNO: 'TECNO', INFINIX: 'Infinix', ITEL: 'itel' };

/** ?financing= on the product, inventory and price chart lists. */
export type FinancingFilter = 'device' | 'regular';

const BRAND_IN_NAME = /\b(tecno|infinix|itel)\b/i;

/** The brand a product's name suggests, for the form to offer. Only a suggestion: a product is marked by a person, never by its name. */
export function suggestDeviceFinancingBrand(text: string): DeviceFinancingBrand | null {
  const match = text.match(BRAND_IN_NAME);
  return match ? (match[1].toUpperCase() as DeviceFinancingBrand) : null;
}

export function isDeviceFinancingBrand(value: unknown): value is DeviceFinancingBrand {
  return typeof value === 'string' && (DEVICE_FINANCING_BRANDS as readonly string[]).includes(value);
}
