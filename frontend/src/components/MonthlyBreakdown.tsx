import { useState } from 'react';
import type { CategoryAmount, MonthBreakdown } from '../lib/api';
import { formatPlaidCategoryLabel } from '../lib/categoryLabels';

const CATEGORY_COLORS = [
  '#60a5fa',
  '#f59e0b',
  '#34d399',
  '#c084fc',
  '#f87171',
  '#22d3ee',
  '#a3a380',
  '#f472b6',
];

const UNCATEGORIZED_COLOR = '#6b7280';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function formatMonthLabel(month: string) {
  const [year, monthNum] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatShortMonth(month: string) {
  const [year, monthNum] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
}

/** Assigns each category a color by its name, from a stable alphabetical ordering across every
 *  month in view — not by position within a single month's own sorted list, which is what let
 *  the same category (e.g. FOOD_AND_DRINK) show up as a different color from one month to the
 *  next depending on how it happened to rank that month. */
function buildCategoryColors(months: MonthBreakdown[]): Map<string, string> {
  const names = Array.from(
    new Set(months.flatMap((m) => m.by_category.map((c) => c.category)))
  )
    .filter((name) => name !== 'Uncategorized')
    .sort();

  const colors = new Map<string, string>();
  names.forEach((name, i) => colors.set(name, CATEGORY_COLORS[i % CATEGORY_COLORS.length]));
  return colors;
}

/** Uncategorized spending isn't a real category the user chose — push it to the bottom
 *  regardless of amount so actual categories aren't crowded out by an catch-all bucket. */
function sortWithUncategorizedLast(categories: CategoryAmount[]): CategoryAmount[] {
  return [...categories].sort((a, b) => {
    if (a.category === 'Uncategorized') return 1;
    if (b.category === 'Uncategorized') return -1;
    return b.amount - a.amount;
  });
}

function SpendingTrendChart({ months }: { months: MonthBreakdown[] }) {
  const maxSpent = Math.max(...months.map((m) => m.total_spent), 1);

  return (
    <div className="card">
      <h2>Spending trend</h2>
      <div className="spending-chart">
        {months.map((m) => (
          <div key={m.month} className="spending-bar-col">
            <span className="spending-bar-value">{formatCurrency(m.total_spent)}</span>
            <div className="spending-bar-track">
              <div
                className="spending-bar"
                style={{ height: `${Math.max((m.total_spent / maxSpent) * 100, m.total_spent > 0 ? 2 : 0)}%` }}
              />
            </div>
            <span className="spending-bar-label">{formatShortMonth(m.month)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthCard({
  month,
  categoryColors,
  expanded,
  onToggle,
}: {
  month: MonthBreakdown;
  categoryColors: Map<string, string>;
  expanded: boolean;
  onToggle: () => void;
}) {
  const net = month.total_income - month.total_spent;
  const sortedCategories = sortWithUncategorizedLast(month.by_category);

  return (
    <div className="card month-card">
      <button type="button" className="month-card-header" onClick={onToggle}>
        <h2>{formatMonthLabel(month.month)}</h2>
        <div className="month-totals">
          <span className="month-total-spent">{formatCurrency(month.total_spent)} spent</span>
          {month.total_income > 0 && (
            <span className="month-total-income">{formatCurrency(month.total_income)} in</span>
          )}
          <span className={net >= 0 ? 'month-total-net-pos' : 'month-total-net-neg'}>
            {net >= 0 ? '+' : ''}
            {formatCurrency(net)} net
          </span>
        </div>
        <span className="month-expand-icon">{expanded ? '−' : '+'}</span>
      </button>

      {expanded && (
        <div className="month-card-body">
          {sortedCategories.length === 0 ? (
            <p className="hint">No spending recorded.</p>
          ) : (
            <div className="category-breakdown">
              {sortedCategories.map((c) => {
                const pct = month.total_spent > 0 ? (c.amount / month.total_spent) * 100 : 0;
                const isUncategorized = c.category === 'Uncategorized';
                const color = isUncategorized ? UNCATEGORIZED_COLOR : categoryColors.get(c.category);
                return (
                  <div key={c.category} className={isUncategorized ? 'cat-row uncategorized' : 'cat-row'}>
                    <span className="cat-dot" style={{ background: color }} />
                    <span className="cat-name">{formatPlaidCategoryLabel(c.category)}</span>
                    <div className="cat-bar-track">
                      <div className="cat-bar-fill" style={{ width: `${pct}%`, background: color }} />
                    </div>
                    <span className="cat-pct">{pct.toFixed(0)}%</span>
                    <span className="cat-amount">{formatCurrency(c.amount)}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MonthlyBreakdown({ months }: { months: MonthBreakdown[] }) {
  // Most recent month first — that's the one you actually want to check in on, and the only
  // one expanded by default so 6+ months doesn't mean 6+ huge stacked cards on load.
  const ordered = [...months].reverse();
  const [expandedMonth, setExpandedMonth] = useState<string | null>(ordered[0]?.month ?? null);

  if (months.length === 0) {
    return (
      <div className="card">
        <h2>Monthly breakdown</h2>
        <p className="hint">No transaction history yet.</p>
      </div>
    );
  }

  const categoryColors = buildCategoryColors(months);

  return (
    <div className="tab-panel">
      {months.length > 1 && <SpendingTrendChart months={months} />}
      <div className="months-breakdown">
        {ordered.map((m) => (
          <MonthCard
            key={m.month}
            month={m}
            categoryColors={categoryColors}
            expanded={expandedMonth === m.month}
            onToggle={() => setExpandedMonth(expandedMonth === m.month ? null : m.month)}
          />
        ))}
      </div>
    </div>
  );
}
