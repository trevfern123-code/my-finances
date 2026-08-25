import { useMemo, useState } from 'react';
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
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function categoryLabel(category: BudgetCategory) {
  return category.emoji ? `${category.emoji} ${category.name}` : category.name;
}

export function TransactionsFeed({
  transactions,
  budgetCategories,
  syncing,
  onSync,
  onCategorize,
  onApprove,
}: {
  transactions: TransactionItem[];
  budgetCategories: BudgetCategory[];
  syncing: boolean;
  onSync: () => void;
  onCategorize: (transactionId: string, budgetCategoryId: string | null) => void;
  onApprove: (transactionId: string) => void;
}) {
  const [accountFilter, setAccountFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);

  const categoryById = useMemo(() => {
    const map = new Map<string, BudgetCategory>();
    for (const c of budgetCategories) map.set(c.id, c);
    return map;
  }, [budgetCategories]);

  const needsReviewCount = useMemo(() => transactions.filter((t) => t.needs_review).length, [transactions]);

  const accountNames = useMemo(
    () => Array.from(new Set(transactions.map((t) => t.accounts?.name).filter((n): n is string => !!n))).sort(),
    [transactions]
  );

  const filtered = useMemo(() => {
    return transactions.filter((t) => {
      if (needsReviewOnly && !t.needs_review) return false;
      if (accountFilter && t.accounts?.name !== accountFilter) return false;
      if (categoryFilter === 'uncategorized' && t.budget_category_id !== null) return false;
      if (categoryFilter && categoryFilter !== 'uncategorized' && t.budget_category_id !== categoryFilter) {
        return false;
      }
      if (dateFrom && t.date < dateFrom) return false;
      if (dateTo && t.date > dateTo) return false;
      return true;
    });
  }, [transactions, needsReviewOnly, accountFilter, categoryFilter, dateFrom, dateTo]);

  const filtersActive = accountFilter || categoryFilter || dateFrom || dateTo || needsReviewOnly;

  function clearFilters() {
    setAccountFilter('');
    setCategoryFilter('');
    setDateFrom('');
    setDateTo('');
    setNeedsReviewOnly(false);
  }

  return (
    <div className="card">
      <div className="section-header">
        <h2>Recent transactions</h2>
        <div className="transactions-header-actions">
          {needsReviewCount > 0 && (
            <button
              type="button"
              className={needsReviewOnly ? 'needs-review-toggle active' : 'needs-review-toggle'}
              onClick={() => setNeedsReviewOnly((prev) => !prev)}
            >
              {needsReviewCount} need{needsReviewCount === 1 ? 's' : ''} review
            </button>
          )}
          <button onClick={onSync} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync transactions'}
          </button>
        </div>
      </div>

      {transactions.length === 0 ? (
        <p className="hint">No transactions yet — link an account or sync to fetch history.</p>
      ) : (
        <>
          <div className="transaction-filters">
            <select value={accountFilter} onChange={(e) => setAccountFilter(e.target.value)}>
              <option value="">All accounts</option>
              {accountNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}>
              <option value="">All categories</option>
              <option value="uncategorized">Uncategorized</option>
              {budgetCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
            <label className="transaction-filter-date">
              From
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
            </label>
            <label className="transaction-filter-date">
              To
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
            </label>
            {filtersActive && (
              <button type="button" className="link-button" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </div>

          {filtered.length === 0 ? (
            <p className="hint">No transactions match these filters.</p>
          ) : (
            <div className="transaction-cards">
              {filtered.map((t) => {
                const category = t.budget_category_id ? categoryById.get(t.budget_category_id) : undefined;
                const cardClass = [
                  'transaction-card',
                  t.pending && 'pending',
                  t.needs_review && 'needs-review',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <div key={t.id} className={cardClass}>
                    <div className="transaction-card-main">
                      <span className="transaction-name">
                        {category?.emoji && <span className="transaction-emoji">{category.emoji}</span>}
                        {t.merchant_name ?? t.name}
                        {t.pending && <span className="pending-badge">pending</span>}
                      </span>
                      <span className="hint">
                        {formatDate(t.date)} · {t.accounts?.name ?? '—'}
                      </span>
                    </div>
                    <span className={t.amount >= 0 ? 'amount-debit' : 'amount-credit'}>
                      {formatAmount(t.amount, t.iso_currency_code)}
                    </span>
                    <select
                      value={t.budget_category_id ?? ''}
                      onChange={(e) => onCategorize(t.id, e.target.value || null)}
                    >
                      <option value="">Uncategorized</option>
                      {budgetCategories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {categoryLabel(c)}
                        </option>
                      ))}
                    </select>
                    {t.needs_review && (
                      <button type="button" className="approve-button" onClick={() => onApprove(t.id)}>
                        Approve
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
