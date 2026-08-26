import { describe, expect, it } from 'vitest';
import type { BudgetCategory } from './api';
import type { UpcomingItem } from './upcomingItems';
import { computeRemainingBudget, computeSafeToSpend, splitUpcomingTotals } from './safeToSpend';

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

function fakeItem(overrides: Partial<UpcomingItem> = {}): UpcomingItem {
  return {
    id: 'item-1',
    name: 'Netflix',
    amount: 15.99,
    dueDate: new Date('2026-08-15T00:00:00.000Z'),
    days: 0,
    kind: 'bill',
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

describe('splitUpcomingTotals', () => {
  it('sums bill and loan items into billsTotal, credit_card_minimum items separately', () => {
    const items = [
      fakeItem({ kind: 'bill', amount: 50 }),
      fakeItem({ kind: 'loan', amount: 100 }),
      fakeItem({ kind: 'credit_card_minimum', amount: 35 }),
      fakeItem({ kind: 'credit_card_minimum', amount: 25 }),
    ];
    expect(splitUpcomingTotals(items)).toEqual({ billsTotal: 150, creditCardMinimumsTotal: 60 });
  });

  it('returns zero for both totals given no items', () => {
    expect(splitUpcomingTotals([])).toEqual({ billsTotal: 0, creditCardMinimumsTotal: 0 });
  });

  it('never lets an item count toward both totals', () => {
    const items = [fakeItem({ kind: 'credit_card_minimum', amount: 40 })];
    const { billsTotal, creditCardMinimumsTotal } = splitUpcomingTotals(items);
    expect(billsTotal).toBe(0);
    expect(creditCardMinimumsTotal).toBe(40);
  });
});

const baseParams = {
  liquidCash: 1000,
  upcomingBillsTotal: 300,
  creditCardMinimumsTotal: 0,
  remainingBudget: 200,
  minimumCashBuffer: 0,
  includeUpcomingBills: true,
  includeRemainingBudget: true,
};

describe('computeSafeToSpend', () => {
  it('subtracts upcoming bills and remaining budget from liquid cash', () => {
    expect(computeSafeToSpend(baseParams)).toBe(500);
  });

  it('also subtracts a minimum cash buffer when set', () => {
    expect(computeSafeToSpend({ ...baseParams, minimumCashBuffer: 150 })).toBe(350);
  });

  it('handles a custom upcoming-bills window and a minimum cash buffer together', () => {
    // Simulates a wider look-ahead window (e.g. 30 days instead of the 14-day default) pulling
    // in more bills, combined with a buffer — both effects should compound, not interfere.
    const narrowWindow = computeSafeToSpend({
      ...baseParams,
      upcomingBillsTotal: 300, // what a 14-day window would total
      minimumCashBuffer: 100,
    });
    const widerWindow = computeSafeToSpend({
      ...baseParams,
      upcomingBillsTotal: 500, // what a 30-day window totals instead, more bills captured
      minimumCashBuffer: 100,
    });
    expect(narrowWindow).toBe(400);
    expect(widerWindow).toBe(200);
    expect(widerWindow).toBeLessThan(narrowWindow);
  });

  it('can go negative when obligations exceed liquid cash', () => {
    const result = computeSafeToSpend({
      ...baseParams,
      liquidCash: 100,
      upcomingBillsTotal: 300,
      remainingBudget: 0,
      minimumCashBuffer: 50,
    });
    expect(result).toBe(-250);
  });

  it('adds the credit-card-minimums total on top of the generic bills total when included', () => {
    const result = computeSafeToSpend({ ...baseParams, upcomingBillsTotal: 300, creditCardMinimumsTotal: 75 });
    expect(result).toBe(1000 - 300 - 75 - 200);
  });

  it('excludes both upcoming bills and credit-card minimums together when includeUpcomingBills is false', () => {
    // Both lines are gated by the same toggle — credit-card minimums are a breakout of "upcoming
    // bills," not an independently toggleable obligation.
    const result = computeSafeToSpend({
      ...baseParams,
      upcomingBillsTotal: 300,
      creditCardMinimumsTotal: 75,
      includeUpcomingBills: false,
    });
    expect(result).toBe(1000 - 200); // only remaining budget still subtracted
  });

  it('excludes remaining budget when includeRemainingBudget is false', () => {
    const result = computeSafeToSpend({ ...baseParams, includeRemainingBudget: false });
    expect(result).toBe(1000 - 300);
  });

  it('excludes both upcoming bills and remaining budget when both toggles are false, buffer still applies', () => {
    const result = computeSafeToSpend({
      ...baseParams,
      creditCardMinimumsTotal: 75,
      includeUpcomingBills: false,
      includeRemainingBudget: false,
      minimumCashBuffer: 50,
    });
    expect(result).toBe(1000 - 50);
  });

  it('all four toggle combinations reconcile to a plain liquidCash-minus-buffer baseline when both are off', () => {
    const bothOn = computeSafeToSpend({ ...baseParams, minimumCashBuffer: 20 });
    const billsOnly = computeSafeToSpend({ ...baseParams, includeRemainingBudget: false, minimumCashBuffer: 20 });
    const budgetOnly = computeSafeToSpend({ ...baseParams, includeUpcomingBills: false, minimumCashBuffer: 20 });
    const neitherOn = computeSafeToSpend({
      ...baseParams,
      includeUpcomingBills: false,
      includeRemainingBudget: false,
      minimumCashBuffer: 20,
    });
    expect(bothOn).toBe(1000 - 300 - 200 - 20);
    expect(billsOnly).toBe(1000 - 300 - 20);
    expect(budgetOnly).toBe(1000 - 200 - 20);
    expect(neitherOn).toBe(1000 - 20);
  });
});
