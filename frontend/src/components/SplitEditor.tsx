import { useState } from 'react';
import type { BudgetCategory, TransactionSplit } from '../lib/api';
import { budgetCategoryLabel } from '../lib/categoryLabels';
import { computeSplitBalance, hasIncompleteRow } from '../lib/splitValidation';

interface DraftSplit {
  budget_category_id: string;
  amount: string;
}

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

export function SplitEditor({
  totalAmount,
  budgetCategories,
  initialSplits,
  onSave,
  onClear,
  onCancel,
}: {
  totalAmount: number;
  budgetCategories: BudgetCategory[];
  initialSplits: TransactionSplit[];
  onSave: (splits: { budget_category_id: string; amount: number }[]) => Promise<void>;
  onClear: () => Promise<void>;
  onCancel: () => void;
}) {
  const [rows, setRows] = useState<DraftSplit[]>(() =>
    initialSplits.length > 0
      ? initialSplits.map((s) => ({ budget_category_id: s.budget_category_id, amount: String(s.amount) }))
      : [
          { budget_category_id: '', amount: '' },
          { budget_category_id: '', amount: '' },
        ]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { remaining, balanced } = computeSplitBalance(rows, totalAmount);

  function updateRow(index: number, fields: Partial<DraftSplit>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...fields } : r)));
  }

  function addRow() {
    setRows((prev) => [...prev, { budget_category_id: '', amount: '' }]);
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    setError(null);
    if (hasIncompleteRow(rows)) {
      setError('Every split needs a category and a positive amount');
      return;
    }
    if (!balanced) {
      setError(`Splits must add up to ${formatCurrency(totalAmount)}`);
      return;
    }
    setSaving(true);
    try {
      await onSave(rows.map((r) => ({ budget_category_id: r.budget_category_id, amount: Number(r.amount) })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save splits');
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    setError(null);
    try {
      await onClear();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear splits');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="split-editor">
      {rows.map((row, i) => (
        <div key={i} className="split-editor-row">
          <select
            value={row.budget_category_id}
            onChange={(e) => updateRow(i, { budget_category_id: e.target.value })}
          >
            <option value="">Choose category…</option>
            {budgetCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {budgetCategoryLabel(c)}
              </option>
            ))}
          </select>
          <input
            type="number"
            min="0"
            step="0.01"
            value={row.amount}
            onChange={(e) => updateRow(i, { amount: e.target.value })}
            placeholder="0.00"
          />
          <button type="button" className="link-button" onClick={() => removeRow(i)} disabled={rows.length <= 2}>
            Remove
          </button>
        </div>
      ))}
      <div className="split-editor-actions">
        <button type="button" className="link-button" onClick={addRow}>
          + Add line
        </button>
        <span className={balanced ? 'split-editor-remaining balanced' : 'split-editor-remaining'}>
          {balanced
            ? 'Balanced'
            : remaining > 0
              ? `${formatCurrency(remaining)} left to allocate`
              : `${formatCurrency(Math.abs(remaining))} over`}
        </span>
      </div>
      {error && <p className="error split-editor-error">{error}</p>}
      <div className="split-editor-buttons">
        <button type="button" onClick={handleSave} disabled={saving || !balanced}>
          {saving ? 'Saving…' : 'Save splits'}
        </button>
        <button type="button" className="link-button" onClick={onCancel} disabled={saving}>
          Cancel
        </button>
        {initialSplits.length > 0 && (
          <button type="button" className="link-button" onClick={handleClear} disabled={saving}>
            Remove splits
          </button>
        )}
      </div>
    </div>
  );
}
