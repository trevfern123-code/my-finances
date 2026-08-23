export interface DateRange {
  /** Inclusive, YYYY-MM-DD */
  start: string;
  /** Exclusive, YYYY-MM-DD */
  end: string;
}

function toDateOnly(year: number, monthIndex0: number, day: number): string {
  const date = new Date(Date.UTC(year, monthIndex0, day));
  return date.toISOString().slice(0, 10);
}

/**
 * The calendar-month range [start, end) containing `now`, in UTC. `transactions.date` is a
 * plain SQL date with no timezone, so comparing against UTC-derived boundaries avoids the
 * range silently shifting by a day depending on the server's local timezone.
 */
export function getCurrentMonthRange(now: Date = new Date()): DateRange {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: toDateOnly(year, month, 1),
    end: toDateOnly(year, month + 1, 1),
  };
}

/**
 * The range covering `monthsBack` full calendar months immediately before the month containing
 * `now` — e.g. monthsBack=2 in August covers June and July, excluding the in-progress current
 * month so a "recent average" isn't skewed by comparing a partial month against full ones.
 */
export function getRecentMonthsRange(monthsBack: number, now: Date = new Date()): DateRange {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: toDateOnly(year, month - monthsBack, 1),
    end: toDateOnly(year, month, 1),
  };
}

export interface SpendRow {
  budget_category_id: string | null;
  amount: number;
}

/**
 * Sums transaction amounts per budget category. Only counts categorized, positive-amount
 * (i.e. actual spend, not income/refunds/credits — see Plaid's amount sign convention)
 * transactions; everything else is ignored rather than netted in, so a category's total
 * only ever reflects money that left the account for that purpose.
 */
export function aggregateSpendByCategory(rows: SpendRow[]): Map<string, number> {
  const spendByCategory = new Map<string, number>();

  for (const row of rows) {
    if (!row.budget_category_id || row.amount <= 0) continue;
    spendByCategory.set(
      row.budget_category_id,
      (spendByCategory.get(row.budget_category_id) ?? 0) + row.amount
    );
  }

  return spendByCategory;
}
