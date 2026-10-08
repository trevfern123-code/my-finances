import { formatCurrencyWhole as formatCurrency } from '../lib/currency';
import type { SummaryView } from '../lib/semanticModel';
import { SemanticNotice } from './SemanticNotice';

function formatMonth(month: string) {
  const [year, monthNum] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
}

/** Role-aware spending per month (design §5 C3), as the server reports it. A month whose refunds
 *  exceed its purchases has negative spending: it gets no bar, and its figure says "refund". */
export function MonthlySpendingChart({ semantics, onRetry }: { semantics: SummaryView; onRetry?: () => void }) {
  if (semantics.kind !== 'ok') {
    return (
      <div className="card">
        <h2>Monthly spending</h2>
        <SemanticNotice state={semantics} onRetry={onRetry} />
      </div>
    );
  }

  const months = semantics.months;
  const maxSpending = Math.max(...months.map((m) => m.spending), 1);

  return (
    <div className="card">
      <h2>Monthly spending</h2>
      {months.length === 0 ? (
        <p className="hint">No transaction history yet.</p>
      ) : (
        <>
          <div className="spending-chart">
            {months.map((m) => (
              <div key={m.month} className="spending-bar-col">
                <span className="spending-bar-value">
                  {formatCurrency(m.spending)}
                  {m.spending < 0 && ' (refund)'}
                </span>
                <div className="spending-bar-track">
                  <div
                    className="spending-bar"
                    style={{ height: `${Math.max((m.spending / maxSpending) * 100, m.spending > 0 ? 2 : 0)}%` }}
                  />
                </div>
                <span className="spending-bar-label">{formatMonth(m.month)}</span>
              </div>
            ))}
          </div>
          <p className="hint">Excludes transfers, card payments and debt payments.</p>
        </>
      )}
    </div>
  );
}
