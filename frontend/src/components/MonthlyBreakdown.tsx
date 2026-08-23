import type { MonthBreakdown } from '../lib/api';

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

function formatCategoryLabel(category: string) {
  if (category === 'Uncategorized') return category;
  return category
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function MonthlyBreakdown({ months }: { months: MonthBreakdown[] }) {
  if (months.length === 0) {
    return (
      <div className="card">
        <h2>Monthly breakdown</h2>
        <p className="hint">No transaction history yet.</p>
      </div>
    );
  }

  // Most recent month first — that's the one you actually want to check in on.
  const ordered = [...months].reverse();

  return (
    <div className="months-breakdown">
      {ordered.map((m) => {
        const net = m.total_income - m.total_spent;
        return (
          <div key={m.month} className="card">
            <div className="section-header">
              <h2>{formatMonthLabel(m.month)}</h2>
              <div className="month-totals">
                <span className="month-total-spent">{formatCurrency(m.total_spent)} spent</span>
                {m.total_income > 0 && (
                  <span className="month-total-income">{formatCurrency(m.total_income)} in</span>
                )}
                <span className={net >= 0 ? 'month-total-net-pos' : 'month-total-net-neg'}>
                  {net >= 0 ? '+' : ''}
                  {formatCurrency(net)} net
                </span>
              </div>
            </div>

            {m.by_category.length === 0 ? (
              <p className="hint">No spending recorded.</p>
            ) : (
              <div className="category-breakdown">
                {m.by_category.map((c, i) => {
                  const pct = m.total_spent > 0 ? (c.amount / m.total_spent) * 100 : 0;
                  const color = CATEGORY_COLORS[i % CATEGORY_COLORS.length];
                  return (
                    <div key={c.category} className="cat-row">
                      <span className="cat-dot" style={{ background: color }} />
                      <span className="cat-name">{formatCategoryLabel(c.category)}</span>
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
        );
      })}
    </div>
  );
}
