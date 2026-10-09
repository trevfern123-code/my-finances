/**
 * The canonical Financial Semantics Phase B fixture, "September 2026"
 * (FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md §9.1), in the pure aggregation module's input shape.
 * Test-only: `src/testUtils` is excluded from the build.
 *
 * Accounts: C checking, S savings, X credit card, E checking excluded from cash flow. Manual loan M
 * (SoFi). Budget categories: Groceries, Dining, Shopping, Household. Plaid signs (+ out).
 *
 * Roles are the ones the design lists "after Phase A" (auto_role, or effective_role once classified);
 * row 13 is deliberately unclassified (R0).
 */
import type { AggregationAccount, AggregationSplit, AggregationTransaction } from '../services/semanticAggregation';

export const ACCOUNT = { C: 'acct-C', S: 'acct-S', X: 'acct-X', E: 'acct-E' } as const;
export const CATEGORY = { groceries: 'cat-groceries', dining: 'cat-dining', shopping: 'cat-shopping', household: 'cat-household' } as const;
export const LOAN_M = 'loan-M';
export const SEPTEMBER = { start: '2026-09-01', end: '2026-10-01' };
export const AUGUST = { start: '2026-08-01', end: '2026-09-01' };

export function fixtureAccounts(overrides: Partial<Record<keyof typeof ACCOUNT, Partial<AggregationAccount>>> = {}): AggregationAccount[] {
  const base: Record<keyof typeof ACCOUNT, AggregationAccount> = {
    C: { id: ACCOUNT.C, type: 'depository', excludeFromCashFlow: false },
    S: { id: ACCOUNT.S, type: 'depository', excludeFromCashFlow: false },
    X: { id: ACCOUNT.X, type: 'credit', excludeFromCashFlow: false },
    E: { id: ACCOUNT.E, type: 'depository', excludeFromCashFlow: true },
  };
  return (Object.keys(base) as (keyof typeof ACCOUNT)[]).map((k) => ({ ...base[k], ...overrides[k] }));
}

function txn(
  id: string,
  date: string,
  accountId: string,
  amount: number,
  plaidCategory: string | null,
  effectiveRole: string | null,
  extra: Partial<AggregationTransaction> = {}
): AggregationTransaction {
  return {
    id,
    accountId,
    date,
    amount,
    plaidCategory,
    budgetCategoryId: null,
    effectiveRole,
    userRoleOverride: null,
    manualLoanId: null,
    principalPortion: null,
    ...extra,
  };
}

/** Rows 1–13 of design §9.1, keyed by their fixture number. */
export function fixtureTransactions(): AggregationTransaction[] {
  return [
    txn('1', '2026-09-01', ACCOUNT.C, -3000, 'INCOME', 'income'),
    txn('2', '2026-09-02', ACCOUNT.X, 120, 'FOOD_AND_DRINK', 'expense', { budgetCategoryId: CATEGORY.groceries }),
    txn('3', '2026-09-03', ACCOUNT.X, 80, 'FOOD_AND_DRINK', 'expense', { budgetCategoryId: CATEGORY.dining }),
    txn('4a', '2026-09-05', ACCOUNT.C, 500, 'TRANSFER_OUT', 'internal_transfer'),
    txn('4b', '2026-09-05', ACCOUNT.S, -500, 'TRANSFER_IN', 'internal_transfer'),
    txn('5a', '2026-09-10', ACCOUNT.C, 900, 'LOAN_PAYMENTS', 'credit_card_payment'),
    txn('5b', '2026-09-10', ACCOUNT.X, -900, 'LOAN_PAYMENTS', 'credit_card_payment'),
    txn('6', '2026-09-12', ACCOUNT.C, 400, 'LOAN_PAYMENTS', 'debt_payment', { manualLoanId: LOAN_M, principalPortion: 350 }),
    txn('7', '2026-09-15', ACCOUNT.C, 300, 'LOAN_PAYMENTS', 'debt_payment'),
    txn('8a', '2026-09-18', ACCOUNT.X, 60, 'GENERAL_MERCHANDISE', 'expense', { budgetCategoryId: CATEGORY.shopping }),
    txn('8b', '2026-09-25', ACCOUNT.X, -60, 'GENERAL_MERCHANDISE', 'refund', { budgetCategoryId: CATEGORY.shopping }),
    txn('9', '2026-09-20', ACCOUNT.C, 75, 'TRANSFER_OUT', 'expense'),
    txn('10', '2026-09-22', ACCOUNT.X, 200, 'FOOD_AND_DRINK', 'expense', { budgetCategoryId: CATEGORY.groceries }),
    txn('11', '2026-09-28', ACCOUNT.S, -2.1, 'INCOME', 'income'),
    txn('12', '2026-09-29', ACCOUNT.E, 999, 'GENERAL_MERCHANDISE', 'expense', { budgetCategoryId: CATEGORY.shopping }),
    txn('13', '2026-08-30', ACCOUNT.C, 45, 'FOOD_AND_DRINK', null, { budgetCategoryId: CATEGORY.dining }),
  ];
}

/** Row 10 (Costco, $200) is split 150 Groceries / 50 Household. */
export function fixtureSplits(): AggregationSplit[] {
  return [
    { id: 'split-10a', transactionId: '10', budgetCategoryId: CATEGORY.groceries, amount: 150 },
    { id: 'split-10b', transactionId: '10', budgetCategoryId: CATEGORY.household, amount: 50 },
  ];
}

/** Returns the fixture with row `id` changed — the way each §9.1 variant is expressed. */
export function withRow(
  rows: AggregationTransaction[],
  id: string,
  change: Partial<AggregationTransaction>
): AggregationTransaction[] {
  if (!rows.some((r) => r.id === id)) throw new Error(`fixture has no row ${id}`);
  return rows.map((r) => (r.id === id ? { ...r, ...change } : r));
}
