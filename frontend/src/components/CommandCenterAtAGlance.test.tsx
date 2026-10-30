// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('../lib/api', () => ({
  getTransactionEffects: vi.fn(),
  EFFECTS_RESTART_REQUIRED: 'effects_restart_required',
}));

import type { AssetGroup, BudgetCategory } from '../lib/api';
import { readBudgetSemantics, readSummarySemantics, type BudgetView, type SemanticNotShown, type SummaryView } from '../lib/semanticModel';
import { budgetCategoryWire, budgetWire, cashFlowWire, REFUSED_STATUS, summaryWire, unresolvedCashFlowWire } from '../testUtils/semanticFixtures';
import { CashFlowPace } from './CashFlowPace';
import { OverviewStats } from './OverviewStats';
import { SafeToSpend } from './SafeToSpend';

// Command Center V2.1, UI Packet 02 — the At a glance tiles, Safe to Spend and Cash flow & budget
// pace are reorganized for presentation only. These tests pin the reviewed semantics through that
// markup: the same figures, ranges, withheld states, notice roles and breakdown lines, with the new
// headings and groups naming them. Every amount is synthetic.

const summaryView = (options: Parameters<typeof summaryWire>[0] = {}): SummaryView => readSummarySemantics(summaryWire(options));
const budgetView = (options: Parameters<typeof budgetWire>[0] = {}): BudgetView => readBudgetSemantics(budgetWire(options));

const CATEGORIES = [
  budgetCategoryWire({ id: 'cat-1', name: 'Groceries', budget_amount: 400 }),
  budgetCategoryWire({ id: 'cat-2', name: 'Shopping', budget_amount: 300, sort_order: 1 }),
] as unknown as BudgetCategory[];

const checking = (balance: number): AssetGroup[] => [
  {
    category: 'checking',
    label: 'Checking',
    total: balance,
    accounts: [
      {
        id: 'a1',
        name: 'Checking',
        official_name: null,
        type: 'depository',
        subtype: 'checking',
        current_balance: balance,
        iso_currency_code: 'USD',
        institution_name: 'Bank',
        savings_goal: null,
        nickname: null,
        color: null,
        icon: null,
        sort_order: 0,
        hidden: false,
        exclude_from_net_worth: false,
      },
    ],
  },
];

const UPDATING: SemanticNotShown = { kind: 'updating', reason: 'matching_pending', retryAfterMs: 5000 };

/** The withheld states and the role their words are announced with (lib/semanticPresentation). */
const WITHHELD: [string, SemanticNotShown, 'status' | 'alert'][] = [
  ['updating', UPDATING, 'status'],
  ['unavailable', { kind: 'unavailable', reason: 'request_failed', retryAfterMs: 5000 }, 'status'],
  ['backend below level 2', { kind: 'backend_outdated' }, 'status'],
  ['loading', { kind: 'loading' }, 'status'],
  ['malformed response', { kind: 'invalid' }, 'alert'],
  ['failed request', { kind: 'failed', code: null }, 'alert'],
];

afterEach(cleanup);

// ---- At a glance -----------------------------------------------------------------------------

describe('At a glance (OverviewStats)', () => {
  const renderStats = (semantics: SummaryView) =>
    render(<OverviewStats netWorth={12345} netWorthHistory={[]} assetGroups={checking(5000)} semantics={semantics} />);
  const tile = (name: string) => screen.getByRole('group', { name });

  it('names the three existing figures under one "At a glance" heading, and adds no fourth', () => {
    renderStats(summaryView());
    const section = screen.getByRole('region', { name: 'At a glance' });
    expect(within(section).getByRole('heading', { level: 2, name: 'At a glance' })).toBeTruthy();
    expect(within(section).getAllByRole('group').map((g) => g.querySelector('.stat-label')?.textContent)).toEqual([
      'Net worth',
      'Liquid cash',
      'Monthly cash flow',
    ]);
    expect(tile('Net worth').querySelector('.stat-value')?.textContent).toBe('$12,345');
    expect(tile('Liquid cash').querySelector('.stat-value')?.textContent).toBe('$5,000');
  });

  it("a definite cash flow is the server's figure, styled as an amount", () => {
    renderStats(summaryView());
    const value = tile('Monthly cash flow').querySelector('.stat-value');
    expect(value?.textContent).toBe('$1,827');
    expect(value?.classList.contains('stat-value-withheld')).toBe(false);
  });

  it('a negative cash flow keeps its sign and its negative styling', () => {
    renderStats(summaryView({ months: [{ month: '2026-09', figures: cashFlowWire({ cash_flow: -250, cash_flow_range: { low: -250, high: -250 } }) }] }));
    const value = tile('Monthly cash flow').querySelector('.stat-value');
    expect(value?.textContent).toBe('-$250');
    expect(value?.classList.contains('negative')).toBe(true);
    expect(value?.classList.contains('stat-value-withheld')).toBe(false);
  });

  it('a bounded cash flow stays a range with its reason, and no change is claimed', () => {
    renderStats(summaryView({ months: [{ month: '2026-08' }, { month: '2026-09', figures: unresolvedCashFlowWire() }] }));
    const card = tile('Monthly cash flow');
    expect(card.querySelector('.stat-value')?.textContent).toBe('$1,727 – $1,827');
    expect(card.querySelector('.stat-value')?.classList.contains('stat-value-withheld')).toBe(false);
    expect(card.textContent).toContain("1 card payment isn't matched yet");
    expect(card.textContent).not.toMatch(/vs last month/);
  });

  it.each(WITHHELD)('%s: a placeholder dash and the state in words, never a number', (_name, state) => {
    renderStats(state);
    const card = tile('Monthly cash flow');
    const value = card.querySelector('.stat-value');
    expect(value?.textContent).toBe('—');
    expect(value?.classList.contains('stat-value-withheld')).toBe(true);
    expect(card.textContent).not.toMatch(/\d/);
    expect(within(card).getByRole('status').textContent).not.toBe('');
    // Balance-based figures do not depend on the semantic state.
    expect(tile('Net worth').querySelector('.stat-value')?.textContent).toBe('$12,345');
  });
});

// ---- Safe to Spend ---------------------------------------------------------------------------

describe('Safe to Spend: the result, then how it is worked out', () => {
  const renderSafe = (
    budget: BudgetView,
    options: { balance?: number; buffer?: number; includeUpcomingBills?: boolean; includeRemainingBudget?: boolean; categories?: BudgetCategory[] } = {}
  ) =>
    render(
      <SafeToSpend
        assetGroups={checking(options.balance ?? 5000)}
        recurringStreams={[]}
        loans={[]}
        manualLoans={[]}
        budgetCategories={options.categories ?? CATEGORIES}
        budgetSemantics={budget}
        upcomingBillsDays={14}
        minimumCashBuffer={options.buffer ?? 100}
        includeUpcomingBills={options.includeUpcomingBills ?? true}
        includeRemainingBudget={options.includeRemainingBudget ?? true}
      />
    );
  const value = () => document.querySelector('.safe-to-spend-value') as HTMLElement;
  const steps = () => screen.getByRole('list', { name: "How it's worked out" });
  const stepTexts = () => within(steps()).getAllByRole('listitem').map((item) => [item.children[0].textContent, item.children[1].textContent]);

  it('a positive figure: the existing amount and color class, then the steps in formula order', () => {
    renderSafe(budgetView());
    // (400 − 50) + (300 − (−60)) = 710 remaining; 5,000 − 0 − 0 − 710 − 100 = 4,190.
    expect(value().textContent).toBe('$4,190.00');
    expect(value().className).toBe('safe-to-spend-value');
    expect(stepTexts()).toEqual([
      ['Liquid cash', '$5,000.00'],
      ['Upcoming bills (next 14 days)', '−$0.00'],
      ['Credit card minimum payments', '−$0.00'],
      ['Remaining budget', '−$710.00'],
      ['Minimum cash buffer', '−$100.00'],
    ]);
    // The result comes before the steps that produce it.
    const result = document.querySelector('.safe-to-spend-result') as HTMLElement;
    expect(result.contains(value())).toBe(true);
    expect(result.compareDocumentPosition(steps()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a negative figure keeps its sign and the negative class, never the withheld class', () => {
    renderSafe(budgetView(), { buffer: 10000 });
    // 5,000 − 710 − 10,000 = −5,710.
    expect(value().textContent).toBe('-$5,710.00');
    expect(value().className).toBe('safe-to-spend-value negative');
  });

  it('a genuine zero is a number, not a dash', () => {
    // An ok budget with no categories is a real zero remaining budget; 5,000 − 0 − 5,000 = 0.
    renderSafe(budgetView({ categories: [] }), { buffer: 5000, categories: [] });
    expect(value().textContent).toBe('$0.00');
    expect(value().className).toBe('safe-to-spend-value');
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lines switched off in Financial preferences stay listed and say "Not included"', () => {
    renderSafe(budgetView(), { includeUpcomingBills: false, includeRemainingBudget: false });
    const items = within(steps()).getAllByRole('listitem');
    const excluded = items.filter((item) => item.classList.contains('excluded')).map((item) => item.textContent);
    expect(excluded).toEqual([
      'Upcoming bills (next 14 days) — Not included−$0.00',
      'Credit card minimum payments — Not included−$0.00',
      'Remaining budget — Not included−$0.00',
    ]);
    expect(items[0].classList.contains('excluded')).toBe(false);
    expect(items[4].classList.contains('excluded')).toBe(false);
    // Without the remaining-budget deduction: 5,000 − 100.
    expect(value().textContent).toBe('$4,900.00');
  });

  it.each([
    ['refused', budgetView({ status: REFUSED_STATUS }), 'alert', /^Paused /],
    ['updating', budgetView({ status: { status: 'updating', retry_after_ms: 5000, reason: 'matching_pending' } }), 'status', /^Updating… /],
    ['unavailable', budgetView({ status: { status: 'unavailable', retry_after_ms: 5000, reason: 'timeout' } }), 'status', /^Unavailable /],
    ['a backend below level 2', budgetView({ status: undefined }), 'status', /^Updating… /],
    ['a malformed response', { kind: 'invalid' } as BudgetView, 'alert', /^Unavailable /],
    ['a failed request', { kind: 'failed', code: null } as BudgetView, 'alert', /^Unavailable /],
    ['loading', { kind: 'loading' } as BudgetView, 'status', /^Loading… /],
  ] as const)('budget %s: a neutral withheld dash and the notice with its role', (_name, budget, role, words) => {
    renderSafe(budget);
    expect(value().textContent).toBe('—');
    expect(value().className).toBe('safe-to-spend-value safe-to-spend-withheld');
    const notice = screen.getByRole(role);
    expect(notice.textContent).toMatch(words);
    expect(notice.textContent).toContain("Remaining budget isn't available, so this can't be worked out yet.");
    expect(stepTexts()[3]).toEqual(['Remaining budget', '—']);
    // The frozen spending (9,999 each) would make the remaining budget 0 and the figure 4,900.
    expect(document.body.textContent).not.toContain('4,900');
  });
});

// ---- Cash flow & budget pace -----------------------------------------------------------------

describe('Cash flow & budget pace', () => {
  const renderPace = (semantics: SummaryView, budget: BudgetView = budgetView(), categories: BudgetCategory[] = CATEGORIES) => {
    const handlers = { onRetry: vi.fn(), onRetryBudget: vi.fn() };
    render(<CashFlowPace budgetCategories={categories} semantics={semantics} budgetSemantics={budget} {...handlers} />);
    return handlers;
  };
  const month = () => document.querySelector('.cash-flow-pace-month') as HTMLElement;
  const budgetColumn = () => document.querySelector('.cash-flow-pace-budget') as HTMLElement;

  it("this month's figures and the budget pace are separate groups, each with its own figures", () => {
    renderPace(summaryView());
    expect(month().querySelector('.cash-flow-result')?.textContent).toBe('Cash flow this month: $1,827.10');
    expect(month().querySelector('.cash-flow-details > summary')?.textContent).toBe("What's counted this month");
    expect(within(budgetColumn()).getByRole('heading', { level: 3, name: 'Budget pace' })).toBeTruthy();
    expect(budgetColumn().querySelector('.budget-category-summary')?.textContent).toBe('−$10.00 (refund) of $700.00 budgeted');
    expect(budgetColumn().querySelector('.progress-track')).not.toBeNull();
  });

  it('a bounded cash flow is stated as its range with the reason', () => {
    renderPace(summaryView({ currentMonth: unresolvedCashFlowWire() }));
    expect(month().querySelector('.cash-flow-result')?.textContent).toBe("Cash flow this month: $1,727.10 – $1,827.10 · 1 card payment isn't matched yet");
  });

  it('a negative cash flow keeps its sign', () => {
    renderPace(summaryView({ currentMonth: cashFlowWire({ cash_flow: -412.37, cash_flow_range: { low: -412.37, high: -412.37 } }) }));
    expect(month().querySelector('.cash-flow-result')?.textContent).toBe('Cash flow this month: −$412.37');
  });

  it('a withheld summary shows its notice and a working "Check again", while the budget pace stays', () => {
    const { onRetry } = renderPace(UPDATING as SummaryView);
    expect(month().querySelector('.cash-flow-result')).toBeNull();
    expect(within(month()).getByRole('status')).toBeTruthy();
    fireEvent.click(within(month()).getByRole('button', { name: 'Check again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(budgetColumn().querySelector('.budget-category-summary')?.textContent).toBe('−$10.00 (refund) of $700.00 budgeted');
  });

  it.each([
    ['refused', budgetView({ status: REFUSED_STATUS }), 'alert'],
    ['updating', budgetView({ status: { status: 'updating', retry_after_ms: 5000, reason: 'matching_pending' } }), 'status'],
    ['a failed request', { kind: 'failed', code: null } as BudgetView, 'alert'],
  ] as const)('budget %s: the pace shows a dash, the notice with its role, and a working "Check again"', (_name, budget, role) => {
    const { onRetryBudget } = renderPace(summaryView(), budget);
    expect(budgetColumn().querySelector('.budget-category-summary')?.textContent).toBe('— of $700.00 budgeted');
    expect(budgetColumn().querySelector('.progress-track')).toBeNull();
    expect(within(budgetColumn()).getByRole(role)).toBeTruthy();
    fireEvent.click(within(budgetColumn()).getByRole('button', { name: 'Check again' }));
    expect(onRetryBudget).toHaveBeenCalledTimes(1);
    // The cash-flow figures do not depend on the budget state.
    expect(month().querySelector('.cash-flow-result')?.textContent).toBe('Cash flow this month: $1,827.10');
  });

  it('with no budget categories, the budget group says how to set them up', () => {
    renderPace(summaryView(), budgetView({ categories: [] }), []);
    expect(budgetColumn().textContent).toBe('Set up budget categories (on the Budget tab) to track your spending pace against them.');
  });
});
