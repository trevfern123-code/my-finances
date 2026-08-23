import type { BudgetCategory, TransactionItem } from '../lib/api';

function formatAmount(amount: number, currency: string | null) {
  const formatted = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: currency ?? 'USD',
  }).format(Math.abs(amount));
  // Plaid convention: positive amount = money out (spend), negative = money in (credit/refund).
  return amount >= 0 ? `-${formatted}` : `+${formatted}`;
}

export function TransactionsFeed({
  transactions,
  budgetCategories,
  syncing,
  onSync,
  onCategorize,
}: {
  transactions: TransactionItem[];
  budgetCategories: BudgetCategory[];
  syncing: boolean;
  onSync: () => void;
  onCategorize: (transactionId: string, budgetCategoryId: string | null) => void;
}) {
  return (
    <div className="card">
      <div className="section-header">
        <h2>Recent transactions</h2>
        <button onClick={onSync} disabled={syncing}>
          {syncing ? 'Syncing...' : 'Sync transactions'}
        </button>
      </div>
      {transactions.length === 0 ? (
        <p className="hint">No transactions yet — link an account or sync to fetch history.</p>
      ) : (
        <div className="table-scroll">
          <table className="transactions-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Description</th>
                <th>Account</th>
                <th>Amount</th>
                <th>Category</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id} className={t.pending ? 'pending' : ''}>
                  <td>{t.date}</td>
                  <td>
                    {t.merchant_name ?? t.name}
                    {t.pending && <span className="pending-badge">pending</span>}
                  </td>
                  <td>{t.accounts?.name ?? '—'}</td>
                  <td className={t.amount >= 0 ? 'amount-debit' : 'amount-credit'}>
                    {formatAmount(t.amount, t.iso_currency_code)}
                  </td>
                  <td>
                    <select
                      value={t.budget_category_id ?? ''}
                      onChange={(e) => onCategorize(t.id, e.target.value || null)}
                    >
                      <option value="">Uncategorized</option>
                      {budgetCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
