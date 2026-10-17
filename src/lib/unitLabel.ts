/**
 * How a stock unit is named wherever it is shown: its product, then its own
 * model name if it has one — "HP Laptop — HP Envy". Its specification and
 * serial number are shown beside this, never folded into it.
 */
export function unitTitle(productName: string | null | undefined, unitName: string | null | undefined): string {
  const product = productName?.trim() ?? '';
  const unit = unitName?.trim() ?? '';
  if (!unit || unit.toLowerCase() === product.toLowerCase()) return product;
  return product ? `${product} — ${unit}` : unit;
}
