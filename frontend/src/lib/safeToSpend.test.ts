import { describe, expect, it } from 'vitest';
import type { BudgetCategory } from './api';
import { computeRemainingBudget, computeSafeToSpend } from './safeToSpend';

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

describe('computeRemainingBudget', () => {
  it('sums unspent budget across categories', () => {
    const categories = [
      fakeCategory({ budget_amount: 200, spent: 50 }),
      fakeCategory({ id: 'cat-2', budget_amount: 300, spent: 100 }),
    ];
    expect(computeRemainingBudget(categories)).toBe(350);
  });

  it('treats an over-budget category as contributing zero, not negative', () => {
    const categories = [fakeCategory({ budget_amount: 200, spent: 250 })];
    expect(computeRemainingBudget(categories)).toBe(0);
  });
});

describe('computeSafeToSpend', () => {
  it('subtracts upcoming bills and remaining budget from liquid cash', () => {
    const result = computeSafeToSpend({
      liquidCash: 1000,
      upcomingBillsTotal: 300,
      remainingBudget: 200,
      minimumCashBuffer: 0,
    });
    expect(result).toBe(500);
  });

  it('also subtracts a minimum cash buffer when set', () => {
    const result = computeSafeToSpend({
      liquidCash: 1000,
      upcomingBillsTotal: 300,
      remainingBudget: 200,
      minimumCashBuffer: 150,
    });
    expect(result).toBe(350);
  });

  it('handles a custom upcoming-bills window and a minimum cash buffer together', () => {
    // Simulates a wider look-ahead window (e.g. 30 days instead of the 14-day default) pulling
    // in more bills, combined with a buffer — both effects should compound, not interfere.
    const narrowWindow = computeSafeToSpend({
      liquidCash: 1000,
      upcomingBillsTotal: 300, // what a 14-day window would total
      remainingBudget: 200,
      minimumCashBuffer: 100,
    });
    const widerWindow = computeSafeToSpend({
      liquidCash: 1000,
      upcomingBillsTotal: 500, // what a 30-day window totals instead, more bills captured
      remainingBudget: 200,
      minimumCashBuffer: 100,
    });
    expect(narrowWindow).toBe(400);
    expect(widerWindow).toBe(200);
    expect(widerWindow).toBeLessThan(narrowWindow);
  });

  it('can go negative when obligations exceed liquid cash', () => {
    const result = computeSafeToSpend({
      liquidCash: 100,
      upcomingBillsTotal: 300,
      remainingBudget: 0,
      minimumCashBuffer: 50,
    });
    expect(result).toBe(-250);
  });
});
