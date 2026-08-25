import { describe, expect, it } from 'vitest';
import type { BudgetCategory } from './api';
import { budgetCategoryLabel, formatPlaidCategoryLabel, selectableCategories } from './categoryLabels';

function fakeCategory(overrides: Partial<BudgetCategory> = {}): BudgetCategory {
  return {
    id: 'cat-1',
    name: 'Dining out',
    budget_amount: 200,
    color: null,
    sort_order: 0,
    emoji: null,
    archived_at: null,
    spent: 0,
    recent_avg_spent: 0,
    ...overrides,
  };
}

describe('formatPlaidCategoryLabel', () => {
  it('title-cases a shouting-case Plaid category', () => {
    expect(formatPlaidCategoryLabel('FOOD_AND_DRINK')).toBe('Food And Drink');
  });

  it('leaves the synthetic Uncategorized bucket as-is', () => {
    expect(formatPlaidCategoryLabel('Uncategorized')).toBe('Uncategorized');
  });
});

describe('budgetCategoryLabel', () => {
  it('prefixes the emoji when present', () => {
    expect(budgetCategoryLabel(fakeCategory({ name: 'Groceries', emoji: '🛒' }))).toBe('🛒 Groceries');
  });

  it('omits the emoji prefix when absent', () => {
    expect(budgetCategoryLabel(fakeCategory({ name: 'Groceries', emoji: null }))).toBe('Groceries');
  });

  it('appends an archived suffix for an archived category', () => {
    expect(
      budgetCategoryLabel(fakeCategory({ name: 'Old gym', emoji: '🏋️', archived_at: '2026-08-26T00:00:00Z' }))
    ).toBe('🏋️ Old gym (archived)');
  });

  it('never appends the archived suffix for an active category', () => {
    expect(budgetCategoryLabel(fakeCategory({ name: 'Groceries', archived_at: null }))).toBe('Groceries');
  });
});

describe('selectableCategories', () => {
  it('includes every active category', () => {
    const categories = [
      fakeCategory({ id: 'a', archived_at: null }),
      fakeCategory({ id: 'b', archived_at: null }),
    ];
    expect(selectableCategories(categories, null).map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('excludes an archived category that is not the current value', () => {
    const categories = [
      fakeCategory({ id: 'a', archived_at: null }),
      fakeCategory({ id: 'b', archived_at: '2026-08-26T00:00:00Z' }),
    ];
    expect(selectableCategories(categories, null).map((c) => c.id)).toEqual(['a']);
    expect(selectableCategories(categories, 'a').map((c) => c.id)).toEqual(['a']);
  });

  it('keeps an archived category when it is the current value', () => {
    const categories = [
      fakeCategory({ id: 'a', archived_at: null }),
      fakeCategory({ id: 'b', archived_at: '2026-08-26T00:00:00Z' }),
    ];
    expect(selectableCategories(categories, 'b').map((c) => c.id)).toEqual(['a', 'b']);
  });
});
