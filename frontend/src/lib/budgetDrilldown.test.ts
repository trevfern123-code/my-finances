import { describe, expect, it } from 'vitest';
import type { TransactionItem } from './api';
import { currentMonthRange, getCurrentMonthCategoryItems } from './budgetDrilldown';

const AUGUST = new Date('2026-08-15T12:00:00Z');

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

describe('currentMonthRange', () => {
  it('returns the first day of the month through the first day of the next month', () => {
    expect(currentMonthRange(AUGUST)).toEqual({ start: '2026-08-01', end: '2026-09-01' });
  });

  it('rolls over into January of the next year for December', () => {
    expect(currentMonthRange(new Date('2026-12-25T12:00:00Z'))).toEqual({
      start: '2026-12-01',
      end: '2027-01-01',
    });
  });
});

describe('getCurrentMonthCategoryItems', () => {
  it("includes an unsplit transaction matching the category, using its own name/amount", () => {
    const txn = fakeTransaction({ id: 'txn-1', budget_category_id: 'cat-a', amount: 42, date: '2026-08-05' });
    const items = getCurrentMonthCategoryItems([txn], 'cat-a', AUGUST);
    expect(items).toEqual([{ date: '2026-08-05', name: 'Test merchant', amount: 42, isSplit: false }]);
  });

  it('excludes an unsplit transaction assigned to a different category', () => {
    const txn = fakeTransaction({ budget_category_id: 'cat-b' });
    expect(getCurrentMonthCategoryItems([txn], 'cat-a', AUGUST)).toEqual([]);
  });

  it("uses a split transaction's split share instead of its own row, and ignores its own budget_category_id", () => {
    const txn = fakeTransaction({
      id: 'txn-split',
      amount: 50,
      budget_category_id: 'cat-a', // inert once splits exist — must NOT also produce a 50 item
      date: '2026-08-06',
      splits: [
        { id: 's1', budget_category_id: 'cat-a', amount: 30, note: null },
        { id: 's2', budget_category_id: 'cat-b', amount: 20, note: null },
      ],
    });
    const items = getCurrentMonthCategoryItems([txn], 'cat-a', AUGUST);
    expect(items).toEqual([{ date: '2026-08-06', name: 'Test merchant', amount: 30, isSplit: true }]);
  });

  it('excludes transactions outside the current calendar month', () => {
    const julyTxn = fakeTransaction({ date: '2026-07-31' });
    const septTxn = fakeTransaction({ date: '2026-09-01' });
    expect(getCurrentMonthCategoryItems([julyTxn, septTxn], 'cat-a', AUGUST)).toEqual([]);
  });

  it('excludes non-positive amounts (income/refunds are never "spend")', () => {
    const refund = fakeTransaction({ amount: -20 });
    const zero = fakeTransaction({ amount: 0 });
    expect(getCurrentMonthCategoryItems([refund, zero], 'cat-a', AUGUST)).toEqual([]);
  });

  it('falls back to merchant_name only when set, otherwise uses name', () => {
    const withMerchant = fakeTransaction({ id: 't1', merchant_name: 'Starbucks', name: 'SQ *STARBUCKS 123' });
    const items = getCurrentMonthCategoryItems([withMerchant], 'cat-a', AUGUST);
    expect(items[0].name).toBe('Starbucks');
  });

  it('sorts results most-recent-first', () => {
    const early = fakeTransaction({ id: 't1', date: '2026-08-02' });
    const late = fakeTransaction({ id: 't2', date: '2026-08-20' });
    const items = getCurrentMonthCategoryItems([early, late], 'cat-a', AUGUST);
    expect(items.map((i) => i.date)).toEqual(['2026-08-20', '2026-08-02']);
  });
});
