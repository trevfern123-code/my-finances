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

/** A budget category's display label — its emoji prefixed onto its name when it has one. */
export function budgetCategoryLabel(category: BudgetCategory) {
  return category.emoji ? `${category.emoji} ${category.name}` : category.name;
}
