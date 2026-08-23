import { useState } from 'react';
import type { BudgetCategory } from '../lib/api';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function currentMonthLabel() {
  return new Date().toLocaleDateString('en-US', { month: 'long' });
}

export function BudgetCategories({
  categories,
  onCreate,
  onUpdate,
  onDelete,
}: {
  categories: BudgetCategory[];
  onCreate: (name: string, budgetAmount: number) => void;
  onUpdate: (id: string, budgetAmount: number) => void;
  onDelete: (id: string) => void;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [editing, setEditing] = useState<Record<string, string>>({});

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number(amount);
    if (!name || Number.isNaN(parsed)) return;
    onCreate(name, parsed);
    setName('');
    setAmount('');
  }

  return (
    <div>
      <div className="section-header">
        <h2>Budget categories</h2>
        <span className="hint">{currentMonthLabel()}</span>
      </div>
      {categories.length === 0 ? (
        <p>No budget categories yet.</p>
      ) : (
        <div className="budget-categories">
          {categories.map((c) => {
            const pct = c.budget_amount > 0 ? Math.min((c.spent / c.budget_amount) * 100, 100) : 0;
            const over = c.spent > c.budget_amount;
            return (
              <div key={c.id} className="budget-category-row">
                <div className="budget-category-header">
                  <span>{c.name}</span>
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
                  <div
                    className={over ? 'progress-fill over' : 'progress-fill'}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <span className="budget-category-summary">
                  {formatCurrency(c.spent)} of {formatCurrency(c.budget_amount)} spent
                </span>
              </div>
            );
          })}
        </div>
      )}

      <form className="new-category-form" onSubmit={handleCreate}>
        <input
          placeholder="Category name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          type="number"
          placeholder="Monthly budget"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          required
          min="0"
        />
        <button type="submit">Add category</button>
      </form>
    </div>
  );
}
