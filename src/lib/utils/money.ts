/** Minor units (pesewas) -> a "123.45" decimal string for display/SMS. Never used for calculation. */
export function formatMoney(amountMinor: number): string {
  return (amountMinor / 100).toFixed(2);
}

export function currencyCode(): string {
  return process.env.CURRENCY_CODE || 'GHS';
}
