/** The one currency-formatting helper for the whole app — was previously redefined identically
 *  in 13 different component files. `currency` defaults to USD (matching this app's
 *  USD-only assumption, see the README's currency-audit note); a null amount renders as an
 *  em dash rather than throwing, for the several call sites that display a possibly-absent
 *  balance. */
export function formatCurrency(amount: number | null, currency?: string | null): string {
  if (amount === null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(amount);
}

/** Whole-dollar variant (no cents) for large headline figures — net worth, the net worth chart,
 *  and the monthly spending chart. */
export function formatCurrencyWhole(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}
