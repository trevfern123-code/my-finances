import { useState } from 'react';
import { useUpdateGuard } from '../hooks/useAppUpdate';
import type { BudgetCategory } from '../lib/api';
import { currentMonthRange } from '../lib/budgetDrilldown';
import { computeReorder } from '../lib/reorder';
import { formatCurrency } from '../lib/currency';
import type { BudgetView } from '../lib/semanticModel';
import { formatSpending } from '../lib/semanticPresentation';
import { EffectsDrilldown } from './EffectsDrilldown';
import { SemanticNotice } from './SemanticNotice';
import { EmojiPicker } from './EmojiPicker';
import { ColorPicker, ColorDot } from './ColorPicker';

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
  onCreate: (name: string, budgetAmount: number, emoji: string | null, color: string | null) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [color, setColor] = useState<string | null>(null);
  // Unsaved edits hold off an automatic app-update reload (lib/appUpdate.ts).
  useUpdateGuard('unsaved_edit', name !== '' || amount !== '' || emoji !== null || color !== null);

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

/**
 * Budget categories (design §5 C6). The category list, names and budgeted amounts are the user's own
 * settings. Each category's spending and recent average are the server's role-aware figures: signed
 * (a negative amount is net refunds) and never clamped. When those figures are withheld the list
 * stays, with a dash in place of every figure.
 */
export function BudgetCategories({
  categories,
  semantics,
  recentAvgMonths,
  onCreate,
  onUpdate,
  onUpdateEmoji,
  onUpdateColor,
  onReorder,
  onArchive,
  onUnarchive,
  onRetry,
}: {
  categories: BudgetCategory[];
  /** The role-aware spending per category, or the state in which no figure is shown. */
  semantics: BudgetView;
  /** Window (Settings → Financial preferences) the server used to compute the recent average —
   *  purely for labeling here, since the number itself already reflects it. */
  recentAvgMonths: number;
  onCreate: (name: string, budgetAmount: number, emoji: string | null, color: string | null) => void;
  onUpdate: (id: string, budgetAmount: number) => void;
  onUpdateEmoji: (id: string, emoji: string | null) => void;
  onUpdateColor: (id: string, color: string | null) => void;
  onReorder: (id: string, sortOrder: number) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  /** Reloads the categories and their figures. */
  onRetry?: () => void;
}) {
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [showAddForm, setShowAddForm] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  // Always render in sort_order regardless of the order the array arrived in, so a reorder
  // takes effect immediately once the underlying values update, with no separate refetch.
  const sorted = categories.filter((c) => c.archived_at === null).sort((a, b) => a.sort_order - b.sort_order);
  const archived = categories.filter((c) => c.archived_at !== null).sort((a, b) => a.name.localeCompare(b.name));
  // A typed amount that is not (yet) the saved one — mid-edit, or left behind by a failed save —
  // holds off an automatic app-update reload (lib/appUpdate.ts).
  useUpdateGuard(
    'unsaved_edit',
    categories.some((c) => editing[c.id] !== undefined && Number(editing[c.id]) !== c.budget_amount)
  );

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
        {semantics.kind !== 'ok' && sorted.length > 0 && <SemanticNotice state={semantics} onRetry={onRetry} />}
        {sorted.length === 0 ? (
          <p className="hint">No budget categories yet.</p>
        ) : (
          <div className="budget-categories">
            {sorted.map((c, index) => {
              // No figure for this category means no figure on screen: never the frozen `spent`.
              const figures = semantics.kind === 'ok' ? (semantics.byCategoryId.get(c.id) ?? null) : null;
              const spending = figures?.spending ?? null;
              const recentAvg = figures?.recent_avg_spending ?? null;
              // The bar is a picture of the figure: it cannot go below empty or above full.
              const pct = spending !== null && c.budget_amount > 0 ? Math.min(Math.max((spending / c.budget_amount) * 100, 0), 100) : 0;
              const tier = spending !== null ? progressTier(spending, c.budget_amount) : 'good';
              const recentAvgPct =
                recentAvg !== null && c.budget_amount > 0 ? Math.min(Math.max((recentAvg / c.budget_amount) * 100, 0), 100) : 0;
              const overRecentAvg = recentAvg !== null && recentAvg > c.budget_amount;
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
                    {recentAvg !== null && recentAvg > 0 && (
                      <div
                        className={overRecentAvg ? 'recent-avg-marker over' : 'recent-avg-marker'}
                        style={{ left: `${recentAvgPct}%` }}
                        title={`Recent average (last ${recentAvgMonths} mo${recentAvgMonths === 1 ? '' : 's'}): ${formatCurrency(recentAvg)}/mo`}
                      />
                    )}
                  </div>
                  <div className="budget-category-footer">
                    {spending !== null ? (
                      <span className={`budget-category-summary budget-category-summary-${tier}`}>
                        {formatSpending(spending)} of {formatCurrency(c.budget_amount)} spent
                      </span>
                    ) : (
                      <span className="budget-category-summary">— of {formatCurrency(c.budget_amount)} spent</span>
                    )}
                    {recentAvg !== null && recentAvg !== 0 && (
                      <span className={overRecentAvg ? 'recent-avg-text over' : 'recent-avg-text'}>
                        Recent avg (last {recentAvgMonths} mo{recentAvgMonths === 1 ? '' : 's'}): {formatSpending(recentAvg)}/mo
                      </span>
                    )}
                    {spending !== null && (
                      <button
                        type="button"
                        className="link-button drilldown-toggle"
                        aria-expanded={expandedId === c.id}
                        aria-label={`${expandedId === c.id ? 'Hide' : 'Show'} transactions for ${c.name}`}
                        onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                      >
                        {expandedId === c.id ? 'Hide transactions ▴' : 'Show transactions ▾'}
                      </button>
                    )}
                  </div>
                  {expandedId === c.id && spending !== null && (
                    <EffectsDrilldown
                      query={{ ...currentMonthRange(), measure: 'spending', bucket: { kind: 'budget_category', id: c.id } }}
                      parentAmount={spending}
                      onRefreshParent={onRetry}
                      emptyText="No transactions this month."
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
        {sorted.length > 0 && <p className="hint">Spending excludes transfers, card payments and debt payments.</p>}
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
