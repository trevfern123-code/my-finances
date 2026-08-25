import { describe, expect, it } from 'vitest';
import type { TransactionItem } from './api';
import { transactionsForMonthCategory } from './monthlyBreakdownDrilldown';

function fakeTransaction(overrides: Partial<TransactionItem> = {}): TransactionItem {
  return {
    id: 'txn-1',
    amount: 10,
    iso_currency_code: 'USD',
    date: '2026-08-10',
    name: 'Test merchant',
    merchant_name: null,
    category: 'FOOD_AND_DRINK',
    plaid_category: null,
    pending: false,
    budget_category_id: 'cat-a',
    needs_review: false,
    splits: [],
    accounts: { name: 'Checking', plaid_items: { institution_name: null } },
    ...overrides,
  };
}

describe('transactionsForMonthCategory', () => {
  it('includes a transaction matching both the month and the Plaid category', () => {
    const txn = fakeTransaction({ date: '2026-08-10', category: 'FOOD_AND_DRINK' });
    expect(transactionsForMonthCategory([txn], '2026-08', 'FOOD_AND_DRINK')).toEqual([txn]);
  });

  it('excludes a transaction from a different calendar month', () => {
    const july = fakeTransaction({ date: '2026-07-31' });
    const sept = fakeTransaction({ date: '2026-09-01' });
    expect(transactionsForMonthCategory([july, sept], '2026-08', 'FOOD_AND_DRINK')).toEqual([]);
  });

  it('excludes a transaction assigned to a different Plaid category', () => {
    const txn = fakeTransaction({ category: 'TRANSPORTATION' });
    expect(transactionsForMonthCategory([txn], '2026-08', 'FOOD_AND_DRINK')).toEqual([]);
  });

  it('treats a null category as "Uncategorized"', () => {
    const txn = fakeTransaction({ category: null });
    expect(transactionsForMonthCategory([txn], '2026-08', 'Uncategorized')).toEqual([txn]);
    expect(transactionsForMonthCategory([txn], '2026-08', 'FOOD_AND_DRINK')).toEqual([]);
  });

  it('excludes non-positive amounts (income/refunds are never "spend")', () => {
    const refund = fakeTransaction({ amount: -20 });
    const zero = fakeTransaction({ amount: 0 });
    expect(transactionsForMonthCategory([refund, zero], '2026-08', 'FOOD_AND_DRINK')).toEqual([]);
  });

  it('sorts results most-recent-first', () => {
    const early = fakeTransaction({ id: 't1', date: '2026-08-02' });
    const late = fakeTransaction({ id: 't2', date: '2026-08-20' });
    const items = transactionsForMonthCategory([early, late], '2026-08', 'FOOD_AND_DRINK');
    expect(items.map((t) => t.id)).toEqual(['t2', 't1']);
  });

  it('does not attribute a split transaction differently than a plain one — grouping is by Plaid category, not budget category, so splits are irrelevant here', () => {
    const txn = fakeTransaction({
      amount: 50,
      splits: [
        { id: 's1', budget_category_id: 'cat-a', amount: 30, note: null },
        { id: 's2', budget_category_id: 'cat-b', amount: 20, note: null },
      ],
    });
    expect(transactionsForMonthCategory([txn], '2026-08', 'FOOD_AND_DRINK')).toEqual([txn]);
  });
});
