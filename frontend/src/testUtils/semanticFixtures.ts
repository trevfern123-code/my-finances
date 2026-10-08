/**
 * Test-only builders for level-2 (Financial Semantics Phase B) response bodies, in the wire shape of
 * backend/src/controllers/semanticResponse.ts.
 *
 * The frozen sign-based fields are given values that no role-aware figure shares (9 999 / 8 888 /
 * 7 777 …). A test that finds one of them on screen has found the client reading a frozen field.
 */

export const FROZEN_SPENT = 9999;
export const FROZEN_INCOME = 8888;

type Wire = Record<string, unknown>;

/** One period's role-aware fields. The defaults are the design §9.1 "September 2026" figures where
 *  the design states them; `cash_flow` deliberately does NOT equal `income_semantic − spending`. */
export function cashFlowWire(overrides: Wire = {}): Wire {
  return {
    spending: 525,
    income_semantic: 3002.1,
    debt_payments: 650,
    known_principal: 350,
    debt_payments_unknown_principal: 300,
    transfers_internal: 500,
    transfers_external: -75,
    credit_card_payments_tracked: 900,
    credit_card_payments_untracked: 0,
    credit_card_payments_returned_tracked: 0,
    credit_card_payments_returned_untracked: 0,
    credit_card_payments_externally_funded: 0,
    credit_card_payments_reversed_externally: 0,
    card_payments_unresolved_credit: 0,
    refunds: -60,
    cash_flow: 1827.1,
    cash_flow_range: { low: 1827.1, high: 1827.1 },
    savings_rate: 0.7252,
    savings_rate_range: { low: 0.7252, high: 0.7252 },
    card_payments_unresolved: { count: 0, payments_amount: 0, returns_amount: 0, by_reason: {} },
    unclassified_count: 0,
    unclassified_amount: 0,
    ...overrides,
  };
}

/** The same period with one cash-side card payment of $100 not matched yet: a range, no single figure. */
export function unresolvedCashFlowWire(overrides: Wire = {}): Wire {
  return cashFlowWire({
    cash_flow: null,
    cash_flow_range: { low: 1727.1, high: 1827.1 },
    savings_rate: null,
    savings_rate_range: { low: 0.6919, high: 0.7252 },
    card_payments_unresolved: { count: 1, payments_amount: 100, returns_amount: 0, by_reason: { no_candidate: 1 } },
    ...overrides,
  });
}

const frozenMonth = (month: string) => ({ month, spent: FROZEN_SPENT, income: FROZEN_INCOME });

export function summaryWire(
  options: { months?: { month: string; figures?: Wire }[]; currentMonth?: Wire; status?: unknown; netWorth?: number } = {}
): Wire {
  const months = options.months ?? [{ month: '2026-08' }, { month: '2026-09' }];
  const status = 'status' in options ? options.status : { status: 'ok' };
  const withFigures = isOk(status);
  return {
    net_worth: options.netWorth ?? 12345,
    total_assets: 20000,
    total_liabilities: 7655,
    monthly_spending: months.map((m) => ({ ...frozenMonth(m.month), ...(withFigures ? (m.figures ?? cashFlowWire()) : {}) })),
    current_month: { income: FROZEN_INCOME, spent: FROZEN_SPENT, ...(withFigures ? (options.currentMonth ?? cashFlowWire()) : {}) },
    ...(status === undefined ? {} : { semantic_status: status }),
  };
}

function isOk(status: unknown): boolean {
  return typeof status === 'object' && status !== null && (status as { status?: unknown }).status === 'ok';
}

export function excludedWire(overrides: Wire = {}): Wire {
  return {
    transfers_internal: 0,
    transfers_external: 0,
    credit_card_payments_tracked: 0,
    credit_card_payments_untracked: 0,
    credit_card_payments_returned_untracked: 0,
    debt_payments: 0,
    card_payments_unresolved: { count: 0, payments_amount: 0, returns_amount: 0, by_reason: {} },
    ...overrides,
  };
}

export function breakdownWire(
  options: {
    months?: { month: string; spending?: number; income?: number; by_category?: { category: string; amount: number }[]; excluded?: Wire }[];
    status?: unknown;
  } = {}
): Wire {
  const months = options.months ?? [
    {
      month: '2026-09',
      spending: 525,
      income: 3002.1,
      by_category: [
        { category: 'FOOD_AND_DRINK', amount: 535 },
        { category: 'LOAN_INTEREST', amount: 50 },
        { category: 'GENERAL_MERCHANDISE', amount: -60 },
      ],
      excluded: excludedWire({ transfers_internal: 500, credit_card_payments_tracked: 900, debt_payments: 650, transfers_external: -75 }),
    },
  ];
  const status = 'status' in options ? options.status : { status: 'ok' };
  const withFigures = isOk(status);
  return {
    months: months.map((m) => ({
      month: m.month,
      total_spent: FROZEN_SPENT,
      total_income: FROZEN_INCOME,
      by_category: [{ category: 'FROZEN_CATEGORY', amount: 7777 }],
      ...(withFigures
        ? { semantic: { spending: m.spending ?? 0, income: m.income ?? 0, by_category: m.by_category ?? [], excluded: m.excluded ?? excludedWire() } }
        : {}),
    })),
    ...(status === undefined ? {} : { semantic_status: status }),
  };
}

export function budgetCategoryWire(overrides: Wire = {}): Wire {
  return {
    id: 'cat-1',
    name: 'Groceries',
    budget_amount: 400,
    color: null,
    sort_order: 0,
    emoji: null,
    archived_at: null,
    spent: FROZEN_SPENT,
    recent_avg_spent: 7777,
    ...overrides,
  };
}

export function budgetWire(options: { categories?: Wire[]; status?: unknown } = {}): Wire {
  const status = 'status' in options ? options.status : { status: 'ok' };
  const categories = options.categories ?? [
    budgetCategoryWire({ id: 'cat-1', name: 'Groceries', budget_amount: 400, spending: 50, recent_avg_spending: 120 }),
    budgetCategoryWire({ id: 'cat-2', name: 'Shopping', budget_amount: 300, sort_order: 1, spending: -60, recent_avg_spending: 0 }),
  ];
  return { categories, ...(status === undefined ? {} : { semantic_status: status }) };
}

export const REFUSED_STATUS = {
  status: 'refused',
  code: 'split_allocation_mismatch',
  transaction_id: '11111111-1111-4111-8111-111111111111',
  mismatches: [{ transaction_id: '11111111-1111-4111-8111-111111111111', parent_amount: 80, split_total: 70 }],
};

let nextRow = 0;

export function effectRowWire(overrides: Wire = {}, transaction: Wire = {}): Wire {
  nextRow += 1;
  return {
    transaction: {
      id: `txn-${String(nextRow).padStart(4, '0')}`,
      date: '2026-09-12',
      name: 'Corner Market',
      merchant_name: null,
      account: { id: 'acct-1', name: 'Checking', nickname: null },
      pending: false,
      effective_role: 'expense',
      user_role_override: null,
      needs_review: false,
      ...transaction,
    },
    effect_role: 'expense',
    effect_amount: 10,
    allocation: 'row',
    budget_category_id: null,
    plaid_category: 'FOOD_AND_DRINK',
    ...overrides,
  };
}

export function effectsPageWire(rows: Wire[], totals: { total_amount: number; total_count: number }, nextCursor: string | null = null): Wire {
  return { status: 'ok', rows, total_amount: totals.total_amount, total_count: totals.total_count, next_cursor: nextCursor };
}
