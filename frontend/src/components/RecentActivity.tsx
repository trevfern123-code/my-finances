import type { BudgetCategory, TransactionItem } from '../lib/api';

function formatAmount(amount: number, currency: string | null) {
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency ?? 'USD',
  }).format(Math.abs(amount));
  // Plaid convention: positive amount = money out (spend), negative = money in (credit/refund).
  return amount >= 0 ? `-${formatted}` : `+${formatted}`;
}

function formatDate(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function RecentActivity({
  transactions,
  budgetCategories,
  onViewAll,
}: {
  transactions: TransactionItem[];
  budgetCategories: BudgetCategory[];
  onViewAll: () => void;
}) {
  const recent = transactions.slice(0, 5);
  const categoryById = new Map(budgetCategories.map((c) => [c.id, c]));

  return (
    <div className="card">
      <div className="section-header">
        <h2>Recent activity</h2>
        <button className="link-button" onClick={onViewAll}>
          View all
        </button>
      </div>
      {recent.length === 0 ? (
        <p className="hint">No transactions yet.</p>
      ) : (
        <div className="quick-view-list">
          {recent.map((t) => {
            const emoji = t.budget_category_id ? categoryById.get(t.budget_category_id)?.emoji : null;
            return (
              <div key={t.id} className="recent-activity-row">
                <div className="transaction-card-main">
                  <span className="transaction-name">
                    {emoji && <span className="transaction-emoji">{emoji}</span>}
                    {t.merchant_name ?? t.name}
                  </span>
                  <span className="hint">{formatDate(t.date)}</span>
                </div>
                <span className={t.amount >= 0 ? 'amount-debit' : 'amount-credit'}>
                  {formatAmount(t.amount, t.iso_currency_code)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
