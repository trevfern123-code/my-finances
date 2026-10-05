import type { TransactionItem } from './api';

/** Mirrors the backend's aggregateByMonth grouping (calendar month + Plaid's own category,
 *  positive amounts only) so the drill-down list lines up with the category total it's under.
 *
 *  NOT USED BY THE UI since Financial Semantics Phase B (integration slice I2): the Monthly
 *  Breakdown drill-down lists the server's effect rows (components/EffectsDrilldown.tsx). This
 *  sign-based filter explains only the frozen `by_category` totals, which this client no longer
 *  shows; it must not be used for a role-aware figure. Kept, with its tests, until the frozen
 *  fields are retired. */
export function transactionsForMonthCategory(
  transactions: TransactionItem[],
  month: string,
  category: string
): TransactionItem[] {
  return transactions
    .filter((t) => t.date.slice(0, 7) === month && t.amount > 0 && (t.category ?? 'Uncategorized') === category)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
