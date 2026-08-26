import type { BudgetCategory } from './api';

/** Money still earmarked for a budget category but not yet spent. A category already over
 *  budget contributes 0 here rather than a negative number — the overspend already left the
 *  liquid-cash balance, so subtracting it again would double-count it. */
export function computeRemainingBudget(categories: BudgetCategory[]): number {
  return categories.reduce((sum, c) => sum + Math.max(0, c.budget_amount - c.spent), 0);
}

/** The full Safe to Spend formula — liquid cash minus everything already spoken for. Kept as one
 *  pure function so every input combination (a custom upcoming-bills window, a minimum cash
 *  buffer, both at once) is directly testable without rendering the component. */
export function computeSafeToSpend(params: {
  liquidCash: number;
  upcomingBillsTotal: number;
  remainingBudget: number;
  minimumCashBuffer: number;
}): number {
  return params.liquidCash - params.upcomingBillsTotal - params.remainingBudget - params.minimumCashBuffer;
}
