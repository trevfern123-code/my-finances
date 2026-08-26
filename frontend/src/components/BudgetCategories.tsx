import { useState } from 'react';
import type { BudgetCategory, TransactionItem } from '../lib/api';
import { getCurrentMonthCategoryItems } from '../lib/budgetDrilldown';
import { computeReorder } from '../lib/reorder';
import { formatCurrency } from '../lib/currency';
import { EmojiPicker } from './EmojiPicker';
import { ColorPicker, ColorDot } from './ColorPicker';

function currentMonthLabel() {
  return new Date().toLocaleDateString('en-US', { month: 'long' });
}

function formatDrilldownDate(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
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
  onCreate: (name: string, budgetAmount: number, emoji: string | null, color: string | null) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number(amount);
    if (!name || Number.isNaN(parsed)) return;
    onCreate(name, parsed, emoji, color);
  }

  return (
    <form className="card new-category-card" onSubmit={handleSubmit}>
      <h3>Add a budget category</h3>
      <div className="new-category-form-grid">
        <label className="new-category-emoji-label">
          Emoji
          <EmojiPicker value={emoji} onChange={setEmoji} label="Choose an emoji for this category" />
        </label>
        <label className="new-category-color-label">
          Color
          <ColorPicker value={color} onChange={setColor} label="Choose a color for this category" />
        </label>
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

function CategoryDrilldown({
  categoryId,
  transactions,
  totalSpent,
}: {
  categoryId: string;
  transactions: TransactionItem[];
  totalSpent: number;
}) {
  const items = getCurrentMonthCategoryItems(transactions, categoryId);
  const shownTotal = items.reduce((sum, item) => sum + item.amount, 0);
  const missing = totalSpent - shownTotal;

  return (
    <div className="category-drilldown">
      {items.length === 0 ? (
        <p className="hint">No transactions this month.</p>
      ) : (
        items.map((item, i) => (
          <div key={i} className="drilldown-row">
            <span className="drilldown-date">{formatDrilldownDate(item.date)}</span>
            <span className="drilldown-name">
              {item.name}
              {item.isSplit && <span className="split-badge">split</span>}
            </span>
            <span className="drilldown-amount">{formatCurrency(item.amount)}</span>
          </div>
        ))
      )}
      {missing > 0.01 && (
        <p className="hint drilldown-mismatch">
          Showing {formatCurrency(shownTotal)} of {formatCurrency(totalSpent)} — older transactions may not be
          loaded.
        </p>
      )}
    </div>
  );
}

export function BudgetCategories({
  categories,
  transactions,
  onCreate,
  onUpdate,
  onUpdateEmoji,
  onUpdateColor,
  onReorder,
  onArchive,
  onUnarchive,
}: {
  categories: BudgetCategory[];
  transactions: TransactionItem[];
  onCreate: (name: string, budgetAmount: number, emoji: string | null, color: string | null) => void;
  onUpdate: (id: string, budgetAmount: number) => void;
  onUpdateEmoji: (id: string, emoji: string | null) => void;
  onUpdateColor: (id: string, color: string | null) => void;
  onReorder: (id: string, sortOrder: number) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
}) {
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Always render in sort_order regardless of the order the array arrived in, so a reorder
  // takes effect immediately once the underlying values update, with no separate refetch.
  const sorted = categories.filter((c) => c.archived_at === null).sort((a, b) => a.sort_order - b.sort_order);
  const archived = categories.filter((c) => c.archived_at !== null).sort((a, b) => a.name.localeCompare(b.name));

  function handleCreate(name: string, budgetAmount: number, emoji: string | null, color: string | null) {
    onCreate(name, budgetAmount, emoji, color);
    setShowAddForm(false);
  }

  function handleMove(id: string, direction: 'up' | 'down') {
    computeReorder(sorted, id, direction).forEach((update) => onReorder(update.id, update.sort_order));
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
                        onClick={() => handleMove(c.id, 'up')}
                        aria-label={`Move ${c.name} up`}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className="reorder-btn"
                        disabled={index === sorted.length - 1}
                        onClick={() => handleMove(c.id, 'down')}
                        aria-label={`Move ${c.name} down`}
                      >
                        ▼
                      </button>
                    </div>
                    <EmojiPicker
                      value={c.emoji}
                      onChange={(emoji) => onUpdateEmoji(c.id, emoji)}
                      label={`Choose an emoji for ${c.name}`}
                    />
                    <ColorPicker
                      value={c.color}
                      onChange={(color) => onUpdateColor(c.id, color)}
                      label={`Choose a color for ${c.name}`}
                    />
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
                      <button className="link-button" onClick={() => onArchive(c.id)}>
                        Archive
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
                    <button
                      type="button"
                      className="link-button drilldown-toggle"
                      onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                    >
                      {expandedId === c.id ? 'Hide transactions ▴' : 'Show transactions ▾'}
                    </button>
                  </div>
                  {expandedId === c.id && <CategoryDrilldown categoryId={c.id} transactions={transactions} totalSpent={c.spent} />}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {archived.length > 0 && (
        <div className="card archived-categories-card">
          <button
            type="button"
            className="link-button archived-categories-toggle"
            onClick={() => setShowArchived((v) => !v)}
            aria-expanded={showArchived}
          >
            {showArchived ? 'Hide' : 'Show'} archived categories ({archived.length})
          </button>
          {showArchived && (
            <div className="archived-categories-list">
              {archived.map((c) => (
                <div key={c.id} className="archived-category-row">
                  <ColorDot color={c.color} />
                  <span className="archived-category-name">
                    {c.emoji && <span className="archived-category-emoji">{c.emoji}</span>}
                    {c.name}
                  </span>
                  <button type="button" className="link-button" onClick={() => onUnarchive(c.id)}>
                    Unarchive
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showAddForm && <AddCategoryForm onCreate={handleCreate} onCancel={() => setShowAddForm(false)} />}
    </div>
  );
}
