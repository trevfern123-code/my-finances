export interface CategorizedTransaction {
  date: string;
  amount: number;
  category: string | null;
}

export interface CategoryAmount {
  category: string;
  amount: number;
}

export interface MonthBreakdown {
  month: string;
  total_spent: number;
  total_income: number;
  by_category: CategoryAmount[];
}

/**
 * Groups transactions by calendar month (YYYY-MM) and, within each month, by Plaid's own
 * category — separately tracking spend (positive amounts) and income (negative amounts, per
 * Plaid's sign convention) so a month's "total_spent" isn't quietly netted against refunds
 * or paychecks landing in the same account.
 */
export function aggregateByMonth(transactions: CategorizedTransaction[]): MonthBreakdown[] {
  const months = new Map<string, { total_spent: number; total_income: number; byCategory: Map<string, number> }>();

  for (const t of transactions) {
    const month = t.date.slice(0, 7);
    const bucket = months.get(month) ?? { total_spent: 0, total_income: 0, byCategory: new Map() };

    if (t.amount > 0) {
      bucket.total_spent += t.amount;
      const category = t.category ?? 'Uncategorized';
      bucket.byCategory.set(category, (bucket.byCategory.get(category) ?? 0) + t.amount);
    } else if (t.amount < 0) {
      bucket.total_income += -t.amount;
    }

    months.set(month, bucket);
  }

  return Array.from(months.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, bucket]) => ({
      month,
      total_spent: bucket.total_spent,
      total_income: bucket.total_income,
      by_category: Array.from(bucket.byCategory.entries())
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount),
    }));
}
