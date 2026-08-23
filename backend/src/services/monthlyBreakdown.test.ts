import { describe, expect, it } from 'vitest';
import { aggregateByMonth } from './monthlyBreakdown';

describe('aggregateByMonth', () => {
  it('groups transactions into their calendar month', () => {
    const result = aggregateByMonth([
      { date: '2026-08-05', amount: 10, category: 'FOOD_AND_DRINK' },
      { date: '2026-08-20', amount: 5, category: 'FOOD_AND_DRINK' },
      { date: '2026-07-15', amount: 20, category: 'TRAVEL' },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].month).toBe('2026-07');
    expect(result[1].month).toBe('2026-08');
  });

  it('sorts months ascending', () => {
    const result = aggregateByMonth([
      { date: '2026-08-01', amount: 1, category: 'A' },
      { date: '2026-06-01', amount: 1, category: 'A' },
      { date: '2026-07-01', amount: 1, category: 'A' },
    ]);
    expect(result.map((m) => m.month)).toEqual(['2026-06', '2026-07', '2026-08']);
  });

  it('sums positive amounts into total_spent and negative amounts into total_income', () => {
    const result = aggregateByMonth([
      { date: '2026-08-01', amount: 50, category: 'FOOD_AND_DRINK' },
      { date: '2026-08-02', amount: -1000, category: null },
    ]);
    expect(result[0].total_spent).toBe(50);
    expect(result[0].total_income).toBe(1000);
  });

  it('buckets a null category as Uncategorized', () => {
    const result = aggregateByMonth([{ date: '2026-08-01', amount: 25, category: null }]);
    expect(result[0].by_category).toEqual([{ category: 'Uncategorized', amount: 25 }]);
  });

  it('sums multiple transactions in the same category within a month', () => {
    const result = aggregateByMonth([
      { date: '2026-08-01', amount: 10, category: 'FOOD_AND_DRINK' },
      { date: '2026-08-15', amount: 15, category: 'FOOD_AND_DRINK' },
    ]);
    expect(result[0].by_category).toEqual([{ category: 'FOOD_AND_DRINK', amount: 25 }]);
  });

  it('sorts categories within a month by amount descending', () => {
    const result = aggregateByMonth([
      { date: '2026-08-01', amount: 10, category: 'SMALL' },
      { date: '2026-08-01', amount: 100, category: 'BIG' },
      { date: '2026-08-01', amount: 50, category: 'MID' },
    ]);
    expect(result[0].by_category.map((c) => c.category)).toEqual(['BIG', 'MID', 'SMALL']);
  });

  it('excludes income transactions from by_category', () => {
    const result = aggregateByMonth([{ date: '2026-08-01', amount: -500, category: 'INCOME_WAGES' }]);
    expect(result[0].by_category).toEqual([]);
  });

  it('ignores exactly-zero-amount transactions entirely', () => {
    const result = aggregateByMonth([{ date: '2026-08-01', amount: 0, category: 'FOOD_AND_DRINK' }]);
    expect(result[0].total_spent).toBe(0);
    expect(result[0].total_income).toBe(0);
    expect(result[0].by_category).toEqual([]);
  });

  it('returns an empty array for no transactions', () => {
    expect(aggregateByMonth([])).toEqual([]);
  });
});
