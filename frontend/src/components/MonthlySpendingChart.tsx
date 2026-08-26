import type { SpendingSummary } from '../lib/api';
import { formatCurrencyWhole as formatCurrency } from '../lib/currency';

function formatMonth(month: string) {
  const [year, monthNum] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
}

export function MonthlySpendingChart({ summary }: { summary: SpendingSummary }) {
  const maxSpent = Math.max(...summary.monthly_spending.map((m) => m.spent), 1);

  return (
    <div className="card">
      <h2>Monthly spending</h2>
      {summary.monthly_spending.length === 0 ? (
        <p className="hint">No transaction history yet.</p>
      ) : (
        <div className="spending-chart">
          {summary.monthly_spending.map((m) => (
            <div key={m.month} className="spending-bar-col">
              <span className="spending-bar-value">{formatCurrency(m.spent)}</span>
              <div className="spending-bar-track">
                <div
                  className="spending-bar"
                  style={{ height: `${Math.max((m.spent / maxSpent) * 100, m.spent > 0 ? 2 : 0)}%` }}
                />
              </div>
              <span className="spending-bar-label">{formatMonth(m.month)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
