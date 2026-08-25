import { useState } from 'react';
import type { BudgetCategory } from '../lib/api';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function currentMonthLabel() {
  return new Date().toLocaleDateString('en-US', { month: 'long' });
}

/** Traffic-light tiers so a glance at the bar's color says as much as the numbers do. */
function progressTier(spent: number, budgetAmount: number): 'good' | 'warn' | 'over' {
  if (budgetAmount <= 0) return spent > 0 ? 'over' : 'good';
  const pct = spent / budgetAmount;
  if (pct >= 1) return 'over';
  if (pct >= 0.7) return 'warn';
  return 'good';
}

function AddCategoryForm({
  onCreate,
  onCancel,
}: {
  onCreate: (name: string, budgetAmount: number) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number(amount);
    if (!name || Number.isNaN(parsed)) return;
    onCreate(name, parsed);
  }

  return (
    <form className="card new-category-card" onSubmit={handleSubmit}>
      <h3>Add a budget category</h3>
      <div className="new-category-form-grid">
        <label>
          Name
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Groceries"
            required
          />
        </label>
        <label>
          Monthly budget
          <input
            type="number"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            required
          />
        </label>
      </div>
      <div className="new-category-form-actions">
        <button type="submit">Add category</button>
        <button type="button" className="link-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

export function BudgetCategories({
  categories,
  onCreate,
  onUpdate,
  onReorder,
  onDelete,
}: {
  categories: BudgetCategory[];
  onCreate: (name: string, budgetAmount: number) => void;
  onUpdate: (id: string, budgetAmount: number) => void;
  onReorder: (id: string, sortOrder: number) => void;
  onDelete: (id: string) => void;
}) {
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [showAddForm, setShowAddForm] = useState(false);

  // Always render in sort_order regardless of the order the array arrived in, so a reorder
  // takes effect immediately once the underlying values update, with no separate refetch.
  const sorted = [...categories].sort((a, b) => a.sort_order - b.sort_order);

  function handleCreate(name: string, budgetAmount: number) {
    onCreate(name, budgetAmount);
    setShowAddForm(false);
  }

  function handleMove(index: number, direction: 'up' | 'down') {
    const swapWith = direction === 'up' ? index - 1 : index + 1;
    if (swapWith < 0 || swapWith >= sorted.length) return;

    const reordered = [...sorted];
    [reordered[index], reordered[swapWith]] = [reordered[swapWith], reordered[index]];

    // Renumber sequentially and persist only what actually changed — on a freshly-created set
    // of categories sort_order may all be 0, so the first move establishes a real baseline for
    // every row, not just the two that were swapped.
    reordered.forEach((c, i) => {
      if (c.sort_order !== i) onReorder(c.id, i);
    });
  }

  return (
    <div className="tab-panel">
      <div className="card">
        <div className="section-header">
          <h2>Budget categories</h2>
          <div className="budget-header-actions">
            <span className="hint">{currentMonthLabel()}</span>
            <button onClick={() => setShowAddForm(true)}>Add category</button>
          </div>
        </div>
        {sorted.length === 0 ? (
          <p className="hint">No budget categories yet.</p>
        ) : (
          <div className="budget-categories">
            {sorted.map((c, index) => {
              const pct = c.budget_amount > 0 ? Math.min((c.spent / c.budget_amount) * 100, 100) : 0;
              const tier = progressTier(c.spent, c.budget_amount);
              const recentAvgPct =
                c.budget_amount > 0 ? Math.min((c.recent_avg_spent / c.budget_amount) * 100, 100) : 0;
              const overRecentAvg = c.recent_avg_spent > c.budget_amount;
              return (
                <div key={c.id} className="budget-category-row">
                  <div className="budget-category-header">
                    <div className="budget-category-reorder">
                      <button
                        type="button"
                        className="reorder-btn"
                        disabled={index === 0}
                        onClick={() => handleMove(index, 'up')}
                        aria-label={`Move ${c.name} up`}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className="reorder-btn"
                        disabled={index === sorted.length - 1}
                        onClick={() => handleMove(index, 'down')}
                        aria-label={`Move ${c.name} down`}
                      >
                        ▼
                      </button>
                    </div>
                    <span className="budget-category-name">{c.name}</span>
                    <div className="budget-category-actions">
                      <input
                        type="number"
                        className="budget-amount-input"
                        value={editing[c.id] ?? c.budget_amount}
                        onChange={(e) => setEditing({ ...editing, [c.id]: e.target.value })}
                        onBlur={() => {
                          const value = Number(editing[c.id]);
                          if (editing[c.id] !== undefined && !Number.isNaN(value)) {
                            onUpdate(c.id, value);
                          }
                        }}
                      />
                      <button className="link-button" onClick={() => onDelete(c.id)}>
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="progress-track">
                    <div className={`progress-fill progress-${tier}`} style={{ width: `${pct}%` }} />
                    {c.recent_avg_spent > 0 && (
                      <div
                        className={overRecentAvg ? 'recent-avg-marker over' : 'recent-avg-marker'}
                        style={{ left: `${recentAvgPct}%` }}
                        title={`Recent average: ${formatCurrency(c.recent_avg_spent)}/mo`}
                      />
                    )}
                  </div>
                  <div className="budget-category-footer">
                    <span className={`budget-category-summary budget-category-summary-${tier}`}>
                      {formatCurrency(c.spent)} of {formatCurrency(c.budget_amount)} spent
                    </span>
                    {c.recent_avg_spent > 0 && (
                      <span className={overRecentAvg ? 'recent-avg-text over' : 'recent-avg-text'}>
                        Recent avg: {formatCurrency(c.recent_avg_spent)}/mo
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {showAddForm && <AddCategoryForm onCreate={handleCreate} onCancel={() => setShowAddForm(false)} />}
    </div>
  );
}
