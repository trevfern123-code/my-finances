import type { BudgetCategory } from './api';

/** Turns a Plaid personal_finance_category primary value (e.g. "FOOD_AND_DRINK") into a
 *  human-readable label ("Food And Drink"). Left as-is for values that aren't shouting-case,
 *  like the synthetic "Uncategorized" bucket. */
export function formatPlaidCategoryLabel(category: string) {
  if (category === 'Uncategorized') return category;
  return category
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** A budget category's display label — its emoji prefixed onto its name when it has one, with an
 *  "(archived)" suffix when the category is archived, so it reads clearly wherever it surfaces in
 *  a historical context (a past transaction, a split, a filter). Never triggers for an active
 *  category, so this is safe to use everywhere a category label is shown. */
export function budgetCategoryLabel(category: BudgetCategory) {
  const base = category.emoji ? `${category.emoji} ${category.name}` : category.name;
  return category.archived_at ? `${base} (archived)` : base;
}

/** The categories selectable for a specific row/select — every active category, plus the
 *  currently-assigned one even if it's since been archived (so an existing selection never
 *  silently disappears from its own dropdown). Archived categories otherwise never appear as a
 *  choice for categorizing a transaction or creating a split, only as the value already there. */
export function selectableCategories(categories: BudgetCategory[], currentId: string | null) {
  return categories.filter((c) => c.archived_at === null || c.id === currentId);
}
