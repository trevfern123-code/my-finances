import { useState } from 'react';
import type { BudgetCategory, CategoryMapping } from '../lib/api';
import { budgetCategoryLabel, formatPlaidCategoryLabel } from '../lib/categoryLabels';

export function CategoryMappings({
  plaidCategories,
  mappings,
  budgetCategories,
  onSave,
  onDelete,
}: {
  plaidCategories: string[];
  mappings: CategoryMapping[];
  budgetCategories: BudgetCategory[];
  onSave: (plaidCategory: string, budgetCategoryId: string, backfill: boolean) => Promise<number>;
  onDelete: (mappingId: string) => void;
}) {
  const [busyCategory, setBusyCategory] = useState<string | null>(null);
  const [backfillCounts, setBackfillCounts] = useState<Record<string, number>>({});

  const mappingByCategory = new Map(mappings.map((m) => [m.plaid_category, m]));
  // Union with already-mapped categories so a mapping never disappears from the list, even for
  // a category no current transaction happens to carry any more.
  const allCategories = Array.from(
    new Set([...plaidCategories, ...mappings.map((m) => m.plaid_category)])
  ).sort();

  async function handleChange(plaidCategory: string, budgetCategoryId: string) {
    const existing = mappingByCategory.get(plaidCategory);
    setBackfillCounts((prev) => {
      const { [plaidCategory]: _drop, ...rest } = prev;
      return rest;
    });

    if (!budgetCategoryId) {
      if (existing) onDelete(existing.id);
      return;
    }

    setBusyCategory(plaidCategory);
    try {
      await onSave(plaidCategory, budgetCategoryId, false);
    } finally {
      setBusyCategory(null);
    }
  }

  async function handleBackfill(plaidCategory: string) {
    const existing = mappingByCategory.get(plaidCategory);
    if (!existing) return;

    setBusyCategory(plaidCategory);
    try {
      const count = await onSave(plaidCategory, existing.budget_category_id, true);
      setBackfillCounts((prev) => ({ ...prev, [plaidCategory]: count }));
    } finally {
      setBusyCategory(null);
    }
  }

  return (
    <div className="tab-panel">
      <div className="card">
        <div className="section-header">
          <h2>Category mapping</h2>
        </div>
        <p className="hint">
          Map each of Plaid's categories to one of your budget categories, and every future
          transaction in that category is assigned automatically — no manual categorizing needed.
        </p>
        {allCategories.length === 0 ? (
          <p className="hint">No categorized transactions yet — sync some transactions first.</p>
        ) : (
          <div className="category-mapping-list">
            {allCategories.map((plaidCategory) => {
              const existing = mappingByCategory.get(plaidCategory);
              const backfillCount = backfillCounts[plaidCategory];
              const busy = busyCategory === plaidCategory;
              return (
                <div key={plaidCategory} className="category-mapping-row">
                  <span className="category-mapping-name">{formatPlaidCategoryLabel(plaidCategory)}</span>
                  <select
                    value={existing?.budget_category_id ?? ''}
                    disabled={busy}
                    onChange={(e) => handleChange(plaidCategory, e.target.value)}
                  >
                    <option value="">Unmapped</option>
                    {budgetCategories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {budgetCategoryLabel(c)}
                      </option>
                    ))}
                  </select>
                  {existing && (
                    <button
                      type="button"
                      className="link-button"
                      disabled={busy}
                      onClick={() => handleBackfill(plaidCategory)}
                    >
                      Apply to existing transactions
                    </button>
                  )}
                  {backfillCount !== undefined && (
                    <span className="hint category-mapping-backfill-result">
                      {backfillCount === 0
                        ? 'No unmapped transactions matched'
                        : `Updated ${backfillCount} transaction${backfillCount === 1 ? '' : 's'}`}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
