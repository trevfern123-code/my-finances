import type { UpcomingItem } from './upcomingItems';

/** Money still earmarked for a budget category but not yet spent. A category already over
 *  budget contributes 0 here rather than a negative number — the overspend already left the
 *  liquid-cash balance, so subtracting it again would double-count it.
 *
 *  `spending` is the server's role-aware spending for the category (Phase B design §5 C7), signed:
 *  net refunds leave more than the budgeted amount to spend. The caller supplies it; this function
 *  never reads the frozen sign-based `spent`. */
export function computeRemainingBudget(categories: { budget_amount: number; spending: number }[]): number {
  return categories.reduce((sum, c) => sum + Math.max(0, c.budget_amount - c.spending), 0);
}

/** Splits collectUpcomingItems' output into the generic upcoming-bills total and the credit-card
 *  minimum-payments total, so Safe to Spend Customization v1 can give credit-card minimums their
 *  own breakdown line. Each item counts toward exactly one of the two totals — never both — so
 *  breaking this line out can never double-count against the generic bills total. */
export function splitUpcomingTotals(items: UpcomingItem[]): {
  billsTotal: number;
  creditCardMinimumsTotal: number;
} {
  let billsTotal = 0;
  let creditCardMinimumsTotal = 0;
  for (const item of items) {
    if (item.kind === 'credit_card_minimum') creditCardMinimumsTotal += item.amount;
    else billsTotal += item.amount;
  }
  return { billsTotal, creditCardMinimumsTotal };
}

/** The full Safe to Spend formula — liquid cash minus everything already spoken for. Kept as one
 *  pure function so every input combination (a custom upcoming-bills window, a minimum cash
 *  buffer, the Safe to Spend Customization v1 toggles, all at once) is directly testable without
 *  rendering the component.
 *
 *  `includeUpcomingBills` gates both `upcomingBillsTotal` and `creditCardMinimumsTotal` together —
 *  the credit-card-minimums line is a breakout of "upcoming bills," not a separate obligation
 *  category, so there is only one toggle for both, matching the approved v1 scope (two toggles
 *  total, not three). `minimumCashBuffer` has no toggle — it's already continuously adjustable
 *  down to $0 via Financial Preferences, which *is* "off." */
export function computeSafeToSpend(params: {
  liquidCash: number;
  upcomingBillsTotal: number;
  creditCardMinimumsTotal: number;
  remainingBudget: number;
  minimumCashBuffer: number;
  includeUpcomingBills: boolean;
  includeRemainingBudget: boolean;
}): number {
  const bills = params.includeUpcomingBills
    ? params.upcomingBillsTotal + params.creditCardMinimumsTotal
    : 0;
  const budget = params.includeRemainingBudget ? params.remainingBudget : 0;
  return params.liquidCash - bills - budget - params.minimumCashBuffer;
}
