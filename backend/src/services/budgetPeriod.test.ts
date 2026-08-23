import { describe, expect, it } from 'vitest';
import { aggregateSpendByCategory, getCurrentMonthRange, getRecentMonthsRange } from './budgetPeriod';

describe('getCurrentMonthRange', () => {
  it('returns the first day of the current month through the first day of the next month', () => {
    const range = getCurrentMonthRange(new Date('2026-08-15T12:00:00Z'));
    expect(range).toEqual({ start: '2026-08-01', end: '2026-09-01' });
  });

  it('handles the first day of the month', () => {
    const range = getCurrentMonthRange(new Date('2026-08-01T00:00:00Z'));
    expect(range).toEqual({ start: '2026-08-01', end: '2026-09-01' });
  });

  it('handles the last day of the month', () => {
    const range = getCurrentMonthRange(new Date('2026-08-31T23:59:59Z'));
    expect(range).toEqual({ start: '2026-08-01', end: '2026-09-01' });
  });

  it('rolls over into January of the next year for December', () => {
    const range = getCurrentMonthRange(new Date('2026-12-25T12:00:00Z'));
    expect(range).toEqual({ start: '2026-12-01', end: '2027-01-01' });
  });

  it('handles a leap-year February correctly', () => {
    const range = getCurrentMonthRange(new Date('2028-02-29T12:00:00Z'));
    expect(range).toEqual({ start: '2028-02-01', end: '2028-03-01' });
  });

  it('uses the current date when none is provided', () => {
    const range = getCurrentMonthRange();
    expect(range.start).toMatch(/^\d{4}-\d{2}-01$/);
  });
});

describe('getRecentMonthsRange', () => {
  it('covers the N full months before the current one, excluding it', () => {
    const range = getRecentMonthsRange(2, new Date('2026-08-15T12:00:00Z'));
    expect(range).toEqual({ start: '2026-06-01', end: '2026-08-01' });
  });

  it('rolls over the year boundary', () => {
    const range = getRecentMonthsRange(2, new Date('2026-01-15T12:00:00Z'));
    expect(range).toEqual({ start: '2025-11-01', end: '2026-01-01' });
  });

  it('supports a 1-month window', () => {
    const range = getRecentMonthsRange(1, new Date('2026-08-15T12:00:00Z'));
    expect(range).toEqual({ start: '2026-07-01', end: '2026-08-01' });
  });
});

describe('aggregateSpendByCategory', () => {
  it('sums positive amounts per category', () => {
    const result = aggregateSpendByCategory([
      { budget_category_id: 'a', amount: 12.5 },
      { budget_category_id: 'a', amount: 7.5 },
      { budget_category_id: 'b', amount: 100 },
    ]);
    expect(result.get('a')).toBe(20);
    expect(result.get('b')).toBe(100);
  });

  it('excludes uncategorized transactions', () => {
    const result = aggregateSpendByCategory([
      { budget_category_id: null, amount: 50 },
      { budget_category_id: 'a', amount: 10 },
    ]);
    expect(result.has(null as unknown as string)).toBe(false);
    expect(result.get('a')).toBe(10);
    expect(result.size).toBe(1);
  });

  it('excludes negative amounts (income/refunds/credits, per Plaid sign convention)', () => {
    const result = aggregateSpendByCategory([
      { budget_category_id: 'a', amount: -500 },
      { budget_category_id: 'a', amount: 10 },
    ]);
    expect(result.get('a')).toBe(10);
  });

  it('excludes zero-amount transactions', () => {
    const result = aggregateSpendByCategory([{ budget_category_id: 'a', amount: 0 }]);
    expect(result.has('a')).toBe(false);
  });

  it('returns an empty map for no rows', () => {
    expect(aggregateSpendByCategory([]).size).toBe(0);
  });
});
