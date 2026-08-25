import type { TransactionItem } from './api';

/** Mirrors the backend's aggregateByMonth grouping (calendar month + Plaid's own category,
 *  positive amounts only) so the drill-down list lines up with the category total it's under. */
export function transactionsForMonthCategory(
  transactions: TransactionItem[],
  month: string,
  category: string
): TransactionItem[] {
  return transactions
    .filter((t) => t.date.slice(0, 7) === month && t.amount > 0 && (t.category ?? 'Uncategorized') === category)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
