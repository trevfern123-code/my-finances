import type { TransactionItem } from './api';
import { todayUtc } from './recurringDates';

export interface DrilldownItem {
  date: string;
  name: string;
  amount: number;
  isSplit: boolean;
}

/** The [start, end) calendar-month range containing `now`, in UTC — mirrors the backend's
 *  getCurrentMonthRange so this matches exactly what BudgetCategory.spent counts. Exported (and
 *  `now` is overridable) purely so this can be tested deterministically without depending on the
 *  actual wall-clock date. */
export function currentMonthRange(now: Date = todayUtc()): { start: string; end: string } {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const end = new Date(Date.UTC(year, month + 1, 1)).toISOString().slice(0, 10);
  return { start, end };
}

/** Mirrors the backend's getCategorySpendRows two-source combine: a split transaction
 *  contributes its split line items (not its own row) toward whichever budget category each
 *  split targets; an unsplit transaction contributes its own row as-is. Scoped to the current
 *  calendar month and positive (spend) amounts only, matching what BudgetCategory.spent counts. */
export function getCurrentMonthCategoryItems(
  transactions: TransactionItem[],
  budgetCategoryId: string,
  now: Date = todayUtc()
): DrilldownItem[] {
  const { start, end } = currentMonthRange(now);
  const items: DrilldownItem[] = [];

  for (const t of transactions) {
    if (t.date < start || t.date >= end) continue;

    if (t.splits.length > 0) {
      for (const s of t.splits) {
        if (s.budget_category_id === budgetCategoryId && s.amount > 0) {
          items.push({ date: t.date, name: t.merchant_name ?? t.name, amount: s.amount, isSplit: true });
        }
      }
    } else if (t.budget_category_id === budgetCategoryId && t.amount > 0) {
      items.push({ date: t.date, name: t.merchant_name ?? t.name, amount: t.amount, isSplit: false });
    }
  }

  return items.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
