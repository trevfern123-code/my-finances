// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const mockGetTransactionEffects = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({
  getTransactionEffects: mockGetTransactionEffects,
  EFFECTS_RESTART_REQUIRED: 'effects_restart_required',
}));

import type { AssetGroup, BudgetCategory } from '../lib/api';
import { currentMonthRange } from '../lib/budgetDrilldown';
import { EFFECTS_PAGE_LIMIT } from '../lib/effectsDrilldown';
import {
  readBudgetSemantics,
  readEffectsResponse,
  readMonthlyBreakdownSemantics,
  readSummarySemantics,
  type BudgetView,
  type MonthlyBreakdownView,
  type SemanticNotShown,
  type SummaryView,
} from '../lib/semanticModel';
import {
  breakdownWire,
  budgetCategoryWire,
  budgetWire,
  cashFlowWire,
  effectRowWire,
  effectsPageWire,
  excludedWire,
  REFUSED_STATUS,
  summaryWire,
  unresolvedCashFlowWire,
} from '../testUtils/semanticFixtures';
import { BudgetCategories } from './BudgetCategories';
import { CashFlowPace } from './CashFlowPace';
import { IncomeSavings } from './IncomeSavings';
import { MonthlyBreakdown } from './MonthlyBreakdown';
import { MonthlySpendingChart } from './MonthlySpendingChart';
import { OverviewStats } from './OverviewStats';
import { SafeToSpend } from './SafeToSpend';

// Financial Semantics Phase B, integration slice I2 — every surface renders the server's role-aware
// figures and nothing else (design §5, §9.4). The fixtures give the frozen sign-based fields values
// no role-aware figure has (9,999 / 8,888 / 7,777), and a cash flow that is NOT income − spending:
// a frozen figure or a figure rebuilt in the browser would be a number these tests reject.

const FROZEN = /9,999|8,888|7,777|1,111/;
/** income_semantic − spending for the fixture: what a client-side reconstruction would show. */
const RECONSTRUCTED = /2,477/;

const WITHHELD: [string, SemanticNotShown, RegExp][] = [
  ['updating', { kind: 'updating', reason: 'matching_pending', retryAfterMs: 5000 }, /Updating…|isn't up to date/],
  ['updating (matching failed)', { kind: 'updating', reason: 'matching_failed', retryAfterMs: 5000 }, /Updating…|couldn't be brought up to date/],
  ['updating (checking again by itself)', { kind: 'updating', reason: 'matching_pending', retryAfterMs: 5000, autoRetrying: true }, /Updating…|Checking again automatically/],
  ['unavailable', { kind: 'unavailable', reason: 'request_failed', retryAfterMs: 5000 }, /Unavailable|couldn't be read/],
  ['backend below level 2', { kind: 'backend_outdated' }, /Updating…|being updated/],
  ['malformed response', { kind: 'invalid' }, /Unavailable|expected form/],
  ['integrity error', { kind: 'failed', code: 'semantic_integrity_error' }, /Unavailable|inconsistent data/],
  ['request failure', { kind: 'failed', code: null }, /Unavailable|couldn't be loaded/],
  ['loading', { kind: 'loading' }, /Loading/],
];

const summaryView = (options: Parameters<typeof summaryWire>[0] = {}): SummaryView => readSummarySemantics(summaryWire(options));
const breakdownView = (options: Parameters<typeof breakdownWire>[0] = {}): MonthlyBreakdownView => readMonthlyBreakdownSemantics(breakdownWire(options));
const budgetView = (options: Parameters<typeof budgetWire>[0] = {}): BudgetView => readBudgetSemantics(budgetWire(options));

const CATEGORIES = [
  budgetCategoryWire({ id: 'cat-1', name: 'Groceries', budget_amount: 400 }),
  budgetCategoryWire({ id: 'cat-2', name: 'Shopping', budget_amount: 300, sort_order: 1 }),
] as unknown as BudgetCategory[];

const ASSETS: AssetGroup[] = [
  {
    category: 'checking',
    label: 'Checking',
    total: 5000,
    accounts: [
      {
        id: 'a1',
        name: 'Checking',
        official_name: null,
        type: 'depository',
        subtype: 'checking',
        current_balance: 5000,
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

const cardOf = (label: string) => {
  const card = screen.getByText(label).closest('.stat-card');
  if (!card) throw new Error(`no stat card for ${label}`);
  return card as HTMLElement;
};

beforeEach(() => {
  mockGetTransactionEffects.mockReset();
});
afterEach(cleanup);

// ---- Overview -------------------------------------------------------------------------------

describe('OverviewStats — Monthly cash flow', () => {
  const renderStats = (semantics: SummaryView) => render(<OverviewStats netWorth={12345} netWorthHistory={[]} assetGroups={ASSETS} semantics={semantics} />);

  it("shows the server's cash_flow of the latest month, not income − spending and not the frozen fields", () => {
    renderStats(summaryView());
    const card = cardOf('Monthly cash flow');
    expect(card.querySelector('.stat-value')?.textContent).toBe('$1,827');
    expect(card.textContent).not.toMatch(RECONSTRUCTED);
    expect(card.textContent).not.toMatch(FROZEN);
  });

  it('compares with the previous month only from two server figures', () => {
    renderStats(
      summaryView({
        months: [
          { month: '2026-08', figures: cashFlowWire({ cash_flow: 1500, cash_flow_range: { low: 1500, high: 1500 } }) },
          { month: '2026-09' },
        ],
      })
    );
    expect(cardOf('Monthly cash flow').textContent).toContain('+$327 vs last month');
  });

  it('shows a range while a card payment is not matched, with the reason in words and no single figure', () => {
    renderStats(summaryView({ months: [{ month: '2026-08' }, { month: '2026-09', figures: unresolvedCashFlowWire() }] }));
    const card = cardOf('Monthly cash flow');
    expect(card.querySelector('.stat-value')?.textContent).toBe('$1,727 – $1,827');
    expect(card.textContent).toContain("1 card payment isn't matched yet");
    expect(card.textContent).not.toMatch(/vs last month/);
  });

  it('shows no change when the previous month is a range', () => {
    renderStats(summaryView({ months: [{ month: '2026-08', figures: unresolvedCashFlowWire() }, { month: '2026-09' }] }));
    const card = cardOf('Monthly cash flow');
    expect(card.querySelector('.stat-value')?.textContent).toBe('$1,827');
    expect(card.textContent).not.toMatch(/vs last month/);
  });

  it('a negative cash flow keeps its sign', () => {
    renderStats(summaryView({ months: [{ month: '2026-09', figures: cashFlowWire({ cash_flow: -250, cash_flow_range: { low: -250, high: -250 } }) }] }));
    expect(cardOf('Monthly cash flow').querySelector('.stat-value')?.textContent).toBe('-$250');
  });

  it.each(WITHHELD)('%s: a dash and a word, never a number — and net worth is still shown', (_name, state, words) => {
    renderStats(state);
    const card = cardOf('Monthly cash flow');
    expect(card.querySelector('.stat-value')?.textContent).toBe('—');
    expect(card.textContent).toMatch(words);
    expect(card.textContent).not.toMatch(/\d/);
    expect(within(card).getByRole('status')).toBeTruthy();
    expect(cardOf('Net worth').querySelector('.stat-value')?.textContent).toBe('$12,345');
  });

  it('with no month in the range, shows a dash', () => {
    renderStats(summaryView({ months: [] }));
    expect(cardOf('Monthly cash flow').querySelector('.stat-value')?.textContent).toBe('—');
  });
});

// ---- Cash flow & budget pace -----------------------------------------------------------------

describe('CashFlowPace', () => {
  const renderPace = (semantics: SummaryView, budget: BudgetView = budgetView(), handlers: { onRetry?: () => void; onRetryBudget?: () => void } = {}) =>
    render(<CashFlowPace budgetCategories={CATEGORIES} semantics={semantics} budgetSemantics={budget} {...handlers} />);

  const bars = () =>
    Array.from(document.querySelectorAll('.cash-flow-row')).map((rowEl) => [
      rowEl.querySelector('.stat-label')?.textContent,
      rowEl.querySelector('.cash-flow-amount')?.textContent,
    ]);

  it('draws Income and Spending from the server figures, and Debt payments and Transfers out only because they are non-zero', () => {
    renderPace(summaryView());
    expect(bars()).toEqual([
      ['Income this month', '$3,002.10'],
      ['Spending this month', '$525.00'],
      ['Debt payments', '$650.00'],
      ['Transfers out', '$75.00'],
    ]);
    expect(document.body.textContent).not.toMatch(FROZEN);
  });

  it('hides the Debt payments bar when there are none, and shows Untracked card payments when there are', () => {
    renderPace(summaryView({ currentMonth: cashFlowWire({ debt_payments: 0, known_principal: 0, debt_payments_unknown_principal: 0, transfers_external: 0, credit_card_payments_untracked: 120 }) }));
    expect(bars()).toEqual([
      ['Income this month', '$3,002.10'],
      ['Spending this month', '$525.00'],
      ['Untracked card payments', '$120.00'],
    ]);
  });

  it('spending below zero is shown as a refund, with an empty bar', () => {
    renderPace(summaryView({ currentMonth: cashFlowWire({ spending: -60 }) }));
    expect(bars()[1]).toEqual(['Spending this month', '−$60.00 (refund)']);
    expect((document.querySelectorAll('.cash-flow-bar-fill')[1] as HTMLElement).style.width).toBe('0%');
  });

  it("states the server's cash flow, never one rebuilt from the bars", () => {
    renderPace(summaryView());
    expect(document.querySelector('.cash-flow-result')?.textContent).toBe('Cash flow this month: $1,827.10');
    expect(document.body.textContent).not.toMatch(RECONSTRUCTED);
  });

  it('states a range and its reason while a card payment is not matched', () => {
    renderPace(summaryView({ currentMonth: unresolvedCashFlowWire() }));
    expect(document.querySelector('.cash-flow-result')?.textContent).toBe("Cash flow this month: $1,727.10 – $1,827.10 · 1 card payment isn't matched yet");
  });

  it("the budget's total spent is the sum of role-aware category spending, signed", () => {
    renderPace(summaryView());
    // 50 + (−60) = −10 of 400 + 300.
    expect(document.querySelector('.budget-pace .budget-category-summary')?.textContent).toBe('−$10.00 (refund) of $700.00 budgeted');
    expect(screen.getAllByText('Spending excludes transfers, card payments and debt payments.').length).toBeGreaterThan(0);
  });

  it.each(WITHHELD)('summary %s: no bar and no cash flow, the state in words, and a way to check again', (_name, state) => {
    const onRetry = vi.fn();
    renderPace(state, budgetView(), { onRetry });
    expect(bars()).toEqual([]);
    expect(document.querySelector('.cash-flow-result')).toBeNull();
    expect(document.querySelector('.cash-flow-details')).toBeNull();
    if (state.kind !== 'loading') {
      fireEvent.click(screen.getAllByRole('button', { name: 'Check again' })[0]);
      expect(onRetry).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    ['refused', budgetView({ status: REFUSED_STATUS })],
    ['updating', budgetView({ status: { status: 'updating', retry_after_ms: 5000, reason: 'matching_pending' } })],
    ['unavailable', budgetView({ status: { status: 'unavailable', retry_after_ms: 5000, reason: 'timeout' } })],
    ['a backend below level 2', budgetView({ status: undefined })],
    ['a failed request', { kind: 'failed', code: null } as BudgetView],
  ])('budget %s: the pace shows a dash, never the frozen total', (_name, budget) => {
    renderPace(summaryView(), budget);
    expect(document.querySelector('.budget-pace .budget-category-summary')?.textContent).toBe('— of $700.00 budgeted');
    expect(document.querySelector('.budget-pace')?.textContent).not.toMatch(/19,998|9,999/);
    expect(document.querySelector('.budget-pace .progress-track')).toBeNull();
  });

  it('a category with no role-aware figure withholds the whole total: a partial sum is never shown', () => {
    renderPace(summaryView(), budgetView({ categories: [budgetCategoryWire({ id: 'cat-1', spending: 50, recent_avg_spending: 0 })] }));
    expect(document.querySelector('.budget-pace .budget-category-summary')?.textContent).toBe('— of $700.00 budgeted');
  });

  describe('"What\'s counted this month"', () => {
    const lines = () =>
      Array.from(document.querySelectorAll('.cash-flow-details-line')).map((line) => [
        line.querySelector('.cash-flow-details-label')?.textContent,
        line.querySelector('.cash-flow-details-amount')?.textContent,
      ]);

    it('lists each published amount with its server figure, known and unknown principal included', () => {
      renderPace(summaryView());
      expect(lines()).toEqual([
        ['Income', '$3,002.10'],
        ['Spending', '$525.00'],
        ['Debt payments', '$650.00'],
        ['Transfers out', '−$75.00'],
        ['Refunds', '−$60.00'],
        ['Loan principal paid down', '$350.00'],
        ['Loan payments with an unknown principal share', '$300.00'],
        ['Transfers between your accounts', '$500.00'],
        ['Card payments to your tracked cards', '$900.00'],
      ]);
    });

    it('names the neutral credit bucket "Unresolved card credits" with no claim about the source of funds', () => {
      renderPace(summaryView({ currentMonth: cashFlowWire({ card_payments_unresolved_credit: 900, credit_card_payments_tracked: 0 }) }));
      expect(lines()).toContainEqual(['Unresolved card credits', '$900.00']);
      const details = document.querySelector('.cash-flow-details')?.textContent ?? '';
      expect(details).toContain('For information only. It does not change cash flow and does not show where the money came from.');
      expect(details).not.toMatch(/external/i);
      expect(details).not.toMatch(/funded|funding/i);
    });

    it('lists unmatched card payments as their own amount, not as tracked or untracked', () => {
      renderPace(summaryView({ currentMonth: unresolvedCashFlowWire() }));
      expect(lines()).toContainEqual(['Card payments not matched yet', '$100.00']);
      expect(lines().map(([label]) => label)).not.toContain('Untracked card payments');
    });

    it('requests nothing until a line is opened; then exactly that measure for the current month', async () => {
      mockGetTransactionEffects.mockResolvedValue(
        readEffectsResponse(effectsPageWire([effectRowWire({ effect_amount: 300, effect_role: 'debt_payment' }, { name: 'Auto loan' })], { total_amount: 300, total_count: 1 }))
      );
      renderPace(summaryView());
      expect(mockGetTransactionEffects).not.toHaveBeenCalled();

      const line = screen.getByRole('button', { name: /Loan payments with an unknown principal share/ });
      expect(line.getAttribute('aria-expanded')).toBe('false');
      fireEvent.click(line);
      expect(line.getAttribute('aria-expanded')).toBe('true');
      expect(mockGetTransactionEffects).toHaveBeenCalledTimes(1);
      expect(mockGetTransactionEffects.mock.calls[0][0]).toEqual({ ...currentMonthRange(), measure: 'debt_payments_unknown_principal' });
      await waitFor(() => expect(screen.getByText('Auto loan')).toBeTruthy());
      expect(document.querySelector('.drilldown-footer')?.textContent).toBe('1 item · $300.00');

      // Opening another line closes this one: one list, one request per line opened.
      fireEvent.click(screen.getByRole('button', { name: /^Income/ }));
      expect(line.getAttribute('aria-expanded')).toBe('false');
      expect(mockGetTransactionEffects).toHaveBeenCalledTimes(2);
      expect(mockGetTransactionEffects.mock.calls[1][0]).toEqual({ ...currentMonthRange(), measure: 'income' });
    });

    it('opens unbucketed spending for the Spending line', () => {
      mockGetTransactionEffects.mockResolvedValue(readEffectsResponse(effectsPageWire([], { total_amount: 0, total_count: 0 })));
      renderPace(summaryView());
      fireEvent.click(screen.getByRole('button', { name: /^Spending/ }));
      expect(mockGetTransactionEffects.mock.calls[0][0]).toEqual({ ...currentMonthRange(), measure: 'spending' });
    });
  });
});

// ---- Savings rate ----------------------------------------------------------------------------

describe('IncomeSavings — Savings rate', () => {
  const renderIncome = (semantics: SummaryView, onRetry?: () => void) =>
    render(
      <IncomeSavings
        groups={ASSETS}
        totalAssets={5000}
        recurringStreams={[]}
        semantics={semantics}
        savingsRateTarget={15}
        onUpdateSavingsGoal={vi.fn()}
        onRetry={onRetry}
      />
    );
  const card = () => screen.getByRole('heading', { name: 'Savings rate' }).closest('.card') as HTMLElement;

  it("shows the server's rate and the amounts the design's copy names", () => {
    renderIncome(summaryView());
    const text = card().textContent ?? '';
    expect(text).toContain('73% this month');
    expect(text).toContain('$1,827.10 cash flow of $3,002.10 income this month');
    expect(text).toContain('Cash kept after debt service, plus $350.00 of loan principal paid down.');
    expect(text).toContain('$300.00 of loan payments with an unknown principal share counted as outflow.');
    expect(text).toContain('$75.00 transferred to accounts not tracked (not counted as saving).');
    expect(text).not.toMatch(FROZEN);
  });

  it('does not compute a rate: a server rate unlike cash flow / income is shown as sent', () => {
    renderIncome(summaryView({ currentMonth: cashFlowWire({ savings_rate: 0.42, savings_rate_range: { low: 0.42, high: 0.42 } }) }));
    expect(card().textContent).toContain('42% this month');
  });

  it('omits the principal and transfer sentences when there is nothing to say', () => {
    renderIncome(summaryView({ currentMonth: cashFlowWire({ known_principal: 0, debt_payments_unknown_principal: 0, transfers_external: 0 }) }));
    const text = card().textContent ?? '';
    expect(text).toContain('Cash kept after debt service.');
    expect(text).not.toMatch(/principal|not tracked/);
  });

  it('shows the rate and the cash flow as ranges while a card payment is not matched', () => {
    renderIncome(summaryView({ currentMonth: unresolvedCashFlowWire() }));
    const text = card().textContent ?? '';
    expect(text).toContain('69% – 73% this month');
    expect(text).toContain("$1,727.10 – $1,827.10 cash flow of $3,002.10 income this month · 1 card payment isn't matched yet");
  });

  it.each(WITHHELD)('%s: a dash, the state in words, no figure', (_name, state) => {
    renderIncome(state);
    const text = card().textContent ?? '';
    expect(text).toContain('— this month');
    expect(text).not.toMatch(/\d/);
  });
});

// ---- Monthly spending chart --------------------------------------------------------------------

describe('MonthlySpendingChart', () => {
  it('charts role-aware spending per month and says what it leaves out', () => {
    render(
      <MonthlySpendingChart
        semantics={summaryView({ months: [{ month: '2026-08', figures: cashFlowWire({ spending: 410 }) }, { month: '2026-09' }, { month: '2026-10', figures: cashFlowWire({ spending: -60 }) }] })}
      />
    );
    expect(Array.from(document.querySelectorAll('.spending-bar-value')).map((el) => el.textContent)).toEqual(['$410', '$525', '-$60 (refund)']);
    expect(screen.getByText('Excludes transfers, card payments and debt payments.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(FROZEN);
  });

  it.each(WITHHELD)('%s: no bar, the state in words', (_name, state) => {
    render(<MonthlySpendingChart semantics={state} />);
    expect(document.querySelector('.spending-chart')).toBeNull();
    expect(document.body.textContent).not.toMatch(/\d/);
  });
});

// ---- Monthly Breakdown ---------------------------------------------------------------------------

describe('MonthlyBreakdown', () => {
  const renderBreakdown = (breakdown: MonthlyBreakdownView, onRetry?: () => void) =>
    render(<MonthlyBreakdown breakdown={breakdown} reportingRange="last_6_months" onSetReportingRange={vi.fn()} onRetry={onRetry} />);

  const categoryRows = () =>
    Array.from(document.querySelectorAll('.cat-row')).map((rowEl) => [rowEl.querySelector('.cat-name')?.textContent, rowEl.querySelector('.cat-amount')?.textContent]);

  it('renders the role-aware month: signed categories, refunds in words, loan interest under its own label', () => {
    renderBreakdown(breakdownView());
    expect(screen.getByRole('heading', { name: 'September 2026' })).toBeTruthy();
    expect(document.querySelector('.month-totals')?.textContent).toBe('$525.00 spent$3,002.10 in');
    expect(categoryRows()).toEqual([
      ['Food And Drink', '$535.00'],
      ['Loan interest', '$50.00'],
      ['General Merchandise', '−$60.00 (refund)'],
    ]);
    expect(document.body.textContent).not.toMatch(FROZEN);
    expect(document.body.textContent).not.toContain('Frozen Category');
  });

  it('does not rebuild a monthly net from income and spending', () => {
    renderBreakdown(breakdownView());
    expect(document.body.textContent).not.toMatch(/net/i);
    expect(document.body.textContent).not.toMatch(RECONSTRUCTED);
  });

  it('says what the month leaves out of spending, from the excluded totals', () => {
    renderBreakdown(breakdownView());
    expect(document.querySelector('.month-excluded')?.textContent).toBe(
      'Not counted as spending: $500.00 transfers between your accounts · $75.00 transferred to untracked accounts · $900.00 card payments to your tracked cards · $650.00 debt payments.'
    );
  });

  it('mentions unmatched card payments in the footer, and has no footer when nothing is excluded', () => {
    renderBreakdown(
      breakdownView({
        months: [
          { month: '2026-09', spending: 10, excluded: excludedWire({ card_payments_unresolved: { count: 2, payments_amount: 300, returns_amount: 0, by_reason: {} } }) },
        ],
      })
    );
    expect(document.querySelector('.month-excluded')?.textContent).toBe("Not counted as spending: 2 card payments aren't matched yet.");
    cleanup();
    renderBreakdown(breakdownView({ months: [{ month: '2026-09', spending: 10 }] }));
    expect(document.querySelector('.month-excluded')).toBeNull();
  });

  it('shows every month the server returned, most recent first, and a trend of role-aware spending', () => {
    renderBreakdown(
      breakdownView({ months: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((month, i) => ({ month, spending: 100 * (i + 1) })) })
    );
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Spending trend',
      'September 2026',
      'August 2026',
      'July 2026',
      'June 2026',
      'May 2026',
    ]);
    expect(Array.from(document.querySelectorAll('.spending-bar-value')).map((el) => el.textContent)).toEqual(['$100.00', '$200.00', '$300.00', '$400.00', '$500.00']);
  });

  it('month and category rows are buttons that say whether they are open', () => {
    renderBreakdown(breakdownView());
    const month = screen.getByRole('button', { name: /September 2026/ });
    expect(month.getAttribute('aria-expanded')).toBe('true');
    const category = screen.getByRole('button', { name: /Food And Drink/ });
    expect(category.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(month);
    expect(month.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('.cat-row')).toBeNull();
  });

  it('a category drill-down asks the effects endpoint for that month and Plaid category, and lists signed rows', async () => {
    mockGetTransactionEffects.mockResolvedValue(
      readEffectsResponse(
        effectsPageWire(
          [effectRowWire({ effect_amount: 60 }, { name: 'Shoe store' }), effectRowWire({ effect_amount: -120, effect_role: 'refund' }, { name: 'Shoe store refund' })],
          { total_amount: -60, total_count: 2 }
        )
      )
    );
    renderBreakdown(breakdownView());
    expect(mockGetTransactionEffects).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /General Merchandise/ }));
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(1);
    expect(mockGetTransactionEffects.mock.calls[0][0]).toEqual({
      start: '2026-09-01',
      end: '2026-10-01',
      measure: 'spending',
      bucket: { kind: 'plaid_category', category: 'GENERAL_MERCHANDISE' },
    });
    expect(mockGetTransactionEffects.mock.calls[0][1]).toEqual({ cursor: null, limit: EFFECTS_PAGE_LIMIT });
    await waitFor(() => expect(Array.from(document.querySelectorAll('.drilldown-amount')).map((el) => el.textContent)).toEqual(['$60.00', '−$120.00']));
    // The list reconciles to the category total on the card.
    expect(document.querySelector('.drilldown-footer')?.textContent).toBe('2 items · −$60.00');
    expect(screen.queryByText(/loaded at different times/)).toBeNull();
  });

  it('the loan-interest drill-down asks for LOAN_INTEREST', () => {
    mockGetTransactionEffects.mockResolvedValue(readEffectsResponse(effectsPageWire([], { total_amount: 0, total_count: 0 })));
    renderBreakdown(breakdownView());
    fireEvent.click(screen.getByRole('button', { name: /Loan interest/ }));
    expect(mockGetTransactionEffects.mock.calls[0][0]).toMatchObject({ bucket: { kind: 'plaid_category', category: 'LOAN_INTEREST' } });
  });

  it.each(WITHHELD)('%s: no month and no figure, the state in words, and a way to check again', (_name, state) => {
    const onRetry = vi.fn();
    renderBreakdown(state, onRetry);
    expect(document.querySelector('.month-card')).toBeNull();
    expect(document.querySelector('.tab-panel .card')?.textContent).not.toMatch(/\d/);
    if (state.kind !== 'loading') {
      fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    }
  });

  it('updating and unavailable read differently', () => {
    renderBreakdown({ kind: 'updating', reason: 'matching_pending', retryAfterMs: 5000 });
    const updating = document.querySelector('.semantic-notice')?.textContent;
    cleanup();
    renderBreakdown({ kind: 'unavailable', reason: 'timeout', retryAfterMs: 5000 });
    expect(document.querySelector('.semantic-notice')?.textContent).not.toBe(updating);
  });

  it('a failure is an alert; a state that resolves is a status', () => {
    renderBreakdown({ kind: 'failed', code: 'semantic_integrity_error' });
    expect(screen.getByRole('alert').textContent).toMatch(/One transaction has inconsistent data, so these figures are paused\./);
    cleanup();
    renderBreakdown({ kind: 'updating', reason: 'matching_pending', retryAfterMs: 5000 });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('with no month at all, says there is no history', () => {
    renderBreakdown(breakdownView({ months: [] }));
    expect(screen.getByText('No transaction history yet.')).toBeTruthy();
  });
});

// ---- Budget ------------------------------------------------------------------------------------

describe('BudgetCategories', () => {
  const handlers = {
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onUpdateEmoji: vi.fn(),
    onUpdateColor: vi.fn(),
    onReorder: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
  };
  const renderBudget = (semantics: BudgetView, onRetry?: () => void) =>
    render(<BudgetCategories categories={CATEGORIES} semantics={semantics} recentAvgMonths={3} onRetry={onRetry} {...handlers} />);
  const summaries = () => Array.from(document.querySelectorAll('.budget-category-footer .budget-category-summary')).map((el) => el.textContent);

  it('shows role-aware spending per category, signed, with a refund in words', () => {
    renderBudget(budgetView());
    expect(summaries()).toEqual(['$50.00 of $400.00 spent', '−$60.00 (refund) of $300.00 spent']);
    expect(screen.getByText('Recent avg (last 3 mos): $120.00/mo')).toBeTruthy();
    expect(screen.getByText('Spending excludes transfers, card payments and debt payments.')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(FROZEN);
  });

  it('a refund is not clamped to zero, and its bar is empty rather than negative', () => {
    renderBudget(budgetView());
    const fills = Array.from(document.querySelectorAll('.budget-category-row .progress-fill')) as HTMLElement[];
    expect(fills.map((el) => el.style.width)).toEqual(['12.5%', '0%']);
    expect(summaries()[1]).not.toBe('$0.00 of $300.00 spent');
  });

  it.each([
    ['refused (a split no longer adds up)', budgetView({ status: REFUSED_STATUS }), /split transaction no longer adds up/],
    ['updating', budgetView({ status: { status: 'updating', retry_after_ms: 5000, reason: 'matching_pending' } }), /isn't up to date, so these figures are withheld/],
    ['unavailable', budgetView({ status: { status: 'unavailable', retry_after_ms: 5000, reason: 'timeout' } }), /couldn't be read/],
    ['a backend below level 2', budgetView({ status: undefined }), /being updated/],
    ['a failed refresh', { kind: 'failed', code: null } as BudgetView, /couldn't be loaded/],
    ['a malformed response', { kind: 'invalid' } as BudgetView, /expected form/],
  ])('%s: the list and its settings stay, every figure is a dash, and no drill-down is offered', (_name, semantics, words) => {
    renderBudget(semantics);
    expect(Array.from(document.querySelectorAll('.budget-category-name')).map((el) => el.textContent)).toEqual(['Groceries', 'Shopping']);
    expect((document.querySelectorAll('.budget-amount-input')[0] as HTMLInputElement).value).toBe('400');
    expect(summaries()).toEqual(['— of $400.00 spent', '— of $300.00 spent']);
    expect(document.querySelector('.semantic-notice')?.textContent).toMatch(words);
    expect(screen.queryByRole('button', { name: /transactions for/ })).toBeNull();
    expect(document.querySelector('.recent-avg-text')).toBeNull();
    expect(document.body.textContent).not.toMatch(FROZEN);
  });

  it('refused is announced as an alert and names no transaction', () => {
    renderBudget(budgetView({ status: REFUSED_STATUS }));
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/budget figures are paused until its splits are corrected/);
    expect(document.body.textContent).not.toContain('11111111');
    expect(document.body.textContent).not.toMatch(/\$80|\$70/);
  });

  it('"Check again" reloads the categories', () => {
    const onRetry = vi.fn();
    renderBudget(budgetView({ status: { status: 'unavailable', retry_after_ms: 5000, reason: 'timeout' } }), onRetry);
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('a category the server gave no figure for shows a dash, not zero and not the frozen figure', () => {
    renderBudget({ kind: 'ok', byCategoryId: new Map([['cat-1', { spending: 50, recent_avg_spending: 0 }]]) });
    expect(summaries()).toEqual(['$50.00 of $400.00 spent', '— of $300.00 spent']);
  });

  it('a drill-down asks the effects endpoint for that category and the current month, and names its control', async () => {
    mockGetTransactionEffects.mockResolvedValue(
      readEffectsResponse(
        effectsPageWire(
          [effectRowWire({ effect_amount: 30, allocation: 'split', split_id: 's1', budget_category_id: 'cat-1' }, { name: 'Costco' }), effectRowWire({ effect_amount: 20 }, { name: 'Corner Market' })],
          { total_amount: 50, total_count: 2 }
        )
      )
    );
    renderBudget(budgetView());
    expect(mockGetTransactionEffects).not.toHaveBeenCalled();

    const toggle = screen.getByRole('button', { name: 'Show transactions for Groceries' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(1);
    expect(mockGetTransactionEffects.mock.calls[0][0]).toEqual({
      ...currentMonthRange(),
      measure: 'spending',
      bucket: { kind: 'budget_category', id: 'cat-1' },
    });
    await waitFor(() => expect(document.querySelector('.drilldown-footer')?.textContent).toBe('2 items · $50.00'));
    expect(screen.getByRole('button', { name: 'Hide transactions for Groceries' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.queryByText(/loaded at different times/)).toBeNull();
  });
});

// ---- Safe to Spend ------------------------------------------------------------------------------

describe('SafeToSpend', () => {
  const renderSafe = (budget: BudgetView, includeRemainingBudget = true) =>
    render(
      <SafeToSpend
        assetGroups={ASSETS}
        recurringStreams={[]}
        loans={[]}
        manualLoans={[]}
        budgetCategories={CATEGORIES}
        budgetSemantics={budget}
        upcomingBillsDays={14}
        minimumCashBuffer={100}
        includeUpcomingBills
        includeRemainingBudget={includeRemainingBudget}
      />
    );
  const value = () => document.querySelector('.safe-to-spend-value')?.textContent;
  /** The amount of a breakdown line: the line's second direct child. */
  const line = (label: string) =>
    Array.from(document.querySelectorAll('.safe-to-spend-line')).find((el) => el.textContent?.startsWith(label))?.children[1]?.textContent;

  it('takes remaining budget from role-aware spending, with the existing clamp at zero per category', () => {
    renderSafe(budgetView());
    // (400 − 50) + (300 − (−60)) = 710; 5,000 − 710 − 100 = 4,190.
    expect(line('Remaining budget')).toBe('−$710.00');
    expect(value()).toBe('$4,190.00');
  });

  it('an over-budget category still contributes zero, not a negative amount', () => {
    renderSafe(budgetView({ categories: [budgetCategoryWire({ id: 'cat-1', spending: 900, recent_avg_spending: 0 }), budgetCategoryWire({ id: 'cat-2', spending: 0, recent_avg_spending: 0 })] }));
    expect(line('Remaining budget')).toBe('−$300.00');
  });

  it.each([
    ['refused', budgetView({ status: REFUSED_STATUS })],
    ['updating', budgetView({ status: { status: 'updating', retry_after_ms: 5000, reason: 'matching_pending' } })],
    ['unavailable', budgetView({ status: { status: 'unavailable', retry_after_ms: 5000, reason: 'timeout' } })],
    ['a backend below level 2', budgetView({ status: undefined })],
    ['a failed request', { kind: 'failed', code: null } as BudgetView],
  ])('budget %s: no Safe to Spend figure is shown, and the frozen figures are not used in its place', (_name, budget) => {
    renderSafe(budget);
    expect(value()).toBe('—');
    expect(line('Remaining budget')).toBe('—');
    expect(document.querySelector('.safe-to-spend-card')?.textContent).toMatch(/Remaining budget isn't available/);
    // With the frozen `spent` (9,999 each) the remaining budget would be 0 and the figure 4,900.
    expect(document.body.textContent).not.toContain('4,900');
  });

  it('when remaining budget is not included, the figure does not depend on it and is shown', () => {
    renderSafe(budgetView({ status: REFUSED_STATUS }), false);
    expect(value()).toBe('$4,900.00');
    expect(line('Remaining budget')).toBe('−$0.00');
  });
});

// =================================================================================================
// I2 correction pass (independent review findings F1, F2, F4). F3 is covered in
// hooks/useUpdatingRefetch.test.tsx, lib/effectsDrilldown.test.ts and App.production.test.tsx.
// =================================================================================================

// ---- F1: Safe to Spend fails closed whatever the category list holds ---------------------------

describe('F1 — Safe to Spend with an EMPTY category list', () => {
  const renderSafe = (budget: BudgetView, options: { categories?: BudgetCategory[]; includeRemainingBudget?: boolean } = {}) =>
    render(
      <SafeToSpend
        assetGroups={ASSETS}
        recurringStreams={[]}
        loans={[]}
        manualLoans={[]}
        budgetCategories={options.categories ?? []}
        budgetSemantics={budget}
        upcomingBillsDays={14}
        minimumCashBuffer={100}
        includeUpcomingBills
        includeRemainingBudget={options.includeRemainingBudget ?? true}
      />
    );
  const card = () => document.querySelector('.safe-to-spend-card') as HTMLElement;
  const value = () => document.querySelector('.safe-to-spend-value')?.textContent;
  const line = (label: string) =>
    Array.from(document.querySelectorAll('.safe-to-spend-line')).find((el) => el.textContent?.startsWith(label))?.children[1]?.textContent;

  const NOT_OK: [string, BudgetView][] = [
    ['refused', budgetView({ status: REFUSED_STATUS, categories: [] })],
    ['updating', budgetView({ status: { status: 'updating', retry_after_ms: 5000, reason: 'matching_pending' }, categories: [] })],
    ['unavailable', budgetView({ status: { status: 'unavailable', retry_after_ms: 5000, reason: 'timeout' }, categories: [] })],
    ['a backend that does not publish the fields', budgetView({ status: undefined, categories: [] })],
    ['a failed refresh', { kind: 'failed', code: null }],
    ['an integrity failure', { kind: 'failed', code: 'semantic_integrity_error' }],
    ['a malformed response', { kind: 'invalid' }],
    ['loading (figures invalidated, read pending)', { kind: 'loading' }],
  ];

  it('control: an ok state with no categories is a real zero, and the figure is shown', () => {
    renderSafe(budgetView({ categories: [] }));
    // 5,000 liquid − 0 remaining budget − 100 buffer. This is the number the bug showed for EVERY state.
    expect(value()).toBe('$4,900.00');
    expect(line('Remaining budget')).toBe('−$0.00');
  });

  it.each(NOT_OK)('%s + no categories: no Safe to Spend number, and no zero remaining budget', (_name, budget) => {
    renderSafe(budget);
    expect(value()).toBe('—');
    expect(value()).not.toMatch(/\d/);
    expect(line('Remaining budget')).toBe('—');
    // The figure an empty list used to produce.
    expect(card().textContent).not.toContain('4,900');
    expect(card().textContent).toMatch(/Remaining budget isn't available/);
  });

  it.each(NOT_OK)('%s + only archived categories (so no active one is passed): the same', (_name, budget) => {
    // App passes the ACTIVE categories; a user whose categories are all archived passes none.
    renderSafe(budget, { categories: [] });
    expect(value()).toBe('—');
  });

  it.each(NOT_OK)('%s + no categories, remaining budget NOT included: the figure does not depend on the budget and is shown', (_name, budget) => {
    renderSafe(budget, { includeRemainingBudget: false });
    expect(value()).toBe('$4,900.00');
    expect(line('Remaining budget')).toBe('−$0.00');
  });

  it('going from ok to withheld with the same empty list removes the number that was on screen', () => {
    const view = renderSafe(budgetView({ categories: [] }));
    expect(value()).toBe('$4,900.00');
    view.rerender(
      <SafeToSpend
        assetGroups={ASSETS}
        recurringStreams={[]}
        loans={[]}
        manualLoans={[]}
        budgetCategories={[]}
        budgetSemantics={{ kind: 'failed', code: null }}
        upcomingBillsDays={14}
        minimumCashBuffer={100}
        includeUpcomingBills
        includeRemainingBudget
      />
    );
    expect(value()).toBe('—');
    expect(card().textContent).not.toContain('4,900');
  });

  it('a non-empty list is still withheld for every non-ok state (unchanged)', () => {
    renderSafe({ kind: 'loading' }, { categories: CATEGORIES });
    expect(value()).toBe('—');
  });

  it('an ok state in which one category has no figure is withheld too: the frozen figure never fills the gap', () => {
    // cat-2 has no role-aware entry. With the frozen `spent` (9,999) in its place it would count as
    // over budget and contribute 0, giving 5,000 − (400 − 50) − 100 = 4,550.
    renderSafe({ kind: 'ok', byCategoryId: new Map([['cat-1', { spending: 50, recent_avg_spending: 0 }]]) }, { categories: CATEGORIES });
    expect(value()).toBe('—');
    expect(line('Remaining budget')).toBe('—');
    expect(card().textContent).not.toContain('4,550');
  });
});

// ---- F2 (component side): figures invalidated while a refresh is pending -------------------------

describe('F2 — budget figures invalidated while their replacement is pending', () => {
  const handlers = {
    onCreate: vi.fn(),
    onUpdate: vi.fn(),
    onUpdateEmoji: vi.fn(),
    onUpdateColor: vi.fn(),
    onReorder: vi.fn(),
    onArchive: vi.fn(),
    onUnarchive: vi.fn(),
  };
  const budget = (semantics: BudgetView) => <BudgetCategories categories={CATEGORIES} semantics={semantics} recentAvgMonths={3} {...handlers} />;
  const summaries = () => Array.from(document.querySelectorAll('.budget-category-footer .budget-category-summary')).map((el) => el.textContent);

  it('the list stays, every figure becomes a dash, and an open drill-down is closed', async () => {
    mockGetTransactionEffects.mockResolvedValue(
      readEffectsResponse(effectsPageWire([effectRowWire({ effect_amount: 50 }, { name: 'Old row' })], { total_amount: 50, total_count: 1 }))
    );
    const view = render(budget(budgetView()));
    fireEvent.click(screen.getByRole('button', { name: 'Show transactions for Groceries' }));
    await waitFor(() => expect(screen.getByText('Old row')).toBeTruthy());
    expect(summaries()).toEqual(['$50.00 of $400.00 spent', '−$60.00 (refund) of $300.00 spent']);

    // A change committed and the replacement read started: the state is "loading".
    view.rerender(budget({ kind: 'loading' }));
    expect(Array.from(document.querySelectorAll('.budget-category-name')).map((el) => el.textContent)).toEqual(['Groceries', 'Shopping']);
    expect(summaries()).toEqual(['— of $400.00 spent', '— of $300.00 spent']);
    expect(screen.queryByText('Old row')).toBeNull();
    expect(document.querySelector('.category-drilldown')).toBeNull();
    expect(screen.queryByRole('button', { name: /transactions for/ })).toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Loading these figures/);

    // The replacement arrives with other figures.
    view.rerender(
      budget(
        budgetView({
          categories: [
            budgetCategoryWire({ id: 'cat-1', spending: 20, recent_avg_spending: 0 }),
            budgetCategoryWire({ id: 'cat-2', spending: 0, recent_avg_spending: 0 }),
          ],
        })
      )
    );
    expect(summaries()).toEqual(['$20.00 of $400.00 spent', '$0.00 of $300.00 spent']);
  });

  it('Cash flow & budget pace and Safe to Spend show no budget figure in that state', () => {
    render(
      <>
        <CashFlowPace budgetCategories={CATEGORIES} semantics={summaryView()} budgetSemantics={{ kind: 'loading' }} />
        <SafeToSpend
          assetGroups={ASSETS}
          recurringStreams={[]}
          loans={[]}
          manualLoans={[]}
          budgetCategories={CATEGORIES}
          budgetSemantics={{ kind: 'loading' }}
          upcomingBillsDays={14}
          minimumCashBuffer={100}
          includeUpcomingBills
          includeRemainingBudget
        />
      </>
    );
    expect(document.querySelector('.budget-pace .budget-category-summary')?.textContent).toBe('— of $700.00 budgeted');
    expect(document.querySelector('.safe-to-spend-value')?.textContent).toBe('—');
  });
});

// ---- F4: signed income is a figure --------------------------------------------------------------

describe('F4 — negative, zero and positive income are all figures; only a withheld state has none', () => {
  const month = (income: number) => breakdownView({ months: [{ month: '2026-09', spending: 525, income, by_category: [{ category: 'FOOD_AND_DRINK', amount: 525 }] }] });
  const renderBreakdown = (breakdown: MonthlyBreakdownView) =>
    render(<MonthlyBreakdown breakdown={breakdown} reportingRange="last_6_months" onSetReportingRange={vi.fn()} />);
  const incomeText = () => document.querySelector('.month-total-income')?.textContent ?? null;

  describe('Monthly Breakdown header', () => {
    it('positive income: "$3,002.10 in"', () => {
      renderBreakdown(month(3002.1));
      expect(incomeText()).toBe('$3,002.10 in');
    });

    it('zero income is shown as a zero, not left out', () => {
      renderBreakdown(month(0));
      expect(incomeText()).toBe('$0.00 in');
    });

    it('negative income is shown with its sign and said in words', () => {
      renderBreakdown(month(-60));
      expect(incomeText()).toBe('−$60.00 in (income reversed)');
      expect(document.querySelector('.month-totals')?.textContent).toBe('$525.00 spent−$60.00 in (income reversed)');
    });

    it('a tiny negative income is not rounded into absence', () => {
      renderBreakdown(month(-0.01));
      expect(incomeText()).toBe('−$0.01 in (income reversed)');
    });

    it.each(WITHHELD)('%s: there is no income figure at all (and no zero standing in for one)', (_name, state) => {
      renderBreakdown(state);
      expect(incomeText()).toBeNull();
      expect(document.body.textContent).not.toMatch(/\$0\.00 in/);
    });

    it('still shows no monthly net', () => {
      renderBreakdown(month(-60));
      expect(document.body.textContent).not.toMatch(/\bnet\b/i);
    });
  });

  describe('Savings rate card', () => {
    const renderIncome = (semantics: SummaryView) =>
      render(<IncomeSavings groups={ASSETS} totalAssets={5000} recurringStreams={[]} semantics={semantics} savingsRateTarget={15} onUpdateSavingsGoal={vi.fn()} />);
    const card = () => screen.getByRole('heading', { name: 'Savings rate' }).closest('.card') as HTMLElement;
    const withIncome = (income: number, rate: number, cashFlow: number) =>
      summaryView({
        currentMonth: cashFlowWire({
          income_semantic: income,
          savings_rate: rate,
          savings_rate_range: { low: rate, high: rate },
          cash_flow: cashFlow,
          cash_flow_range: { low: cashFlow, high: cashFlow },
        }),
      });

    it('positive income: the income figure, and no note about income', () => {
      renderIncome(withIncome(3002.1, 0.7252, 1827.1));
      const text = card().textContent ?? '';
      expect(text).toContain('$1,827.10 cash flow of $3,002.10 income this month');
      expect(text).not.toMatch(/Income this month is/);
      expect(text).not.toMatch(/No income/i);
    });

    it('zero income: states the zero and why the rate is 0%, without claiming none was recorded', () => {
      renderIncome(withIncome(0, 0, -525));
      const text = card().textContent ?? '';
      expect(text).toContain('0% this month');
      expect(text).toContain('Income this month is $0.00, so the savings rate is shown as 0%.');
      expect(text).toContain('−$525.00 cash flow of $0.00 income this month');
      expect(text).not.toMatch(/No income recorded/i);
    });

    it('negative income: states the signed figure and what it means, never "no income"', () => {
      renderIncome(withIncome(-60, 0, -585));
      const text = card().textContent ?? '';
      expect(text).toContain('0% this month');
      expect(text).toContain('Income this month is −$60.00: reversed income exceeded what came in. The savings rate is shown as 0%.');
      expect(text).toContain('−$585.00 cash flow of −$60.00 income this month');
      expect(text).not.toMatch(/No income/i);
      expect(text).not.toMatch(/not available|unavailable/i);
    });

    it.each(WITHHELD)('%s: no income figure and no income note', (_name, state) => {
      renderIncome(state);
      const text = card().textContent ?? '';
      expect(text).not.toMatch(/Income this month is/);
      expect(text).not.toMatch(/\d/);
    });
  });

  describe('Cash flow & budget pace (already signed; kept consistent with the other two)', () => {
    const bars = () =>
      Array.from(document.querySelectorAll('.cash-flow-row')).map((rowEl) => [rowEl.querySelector('.stat-label')?.textContent, rowEl.querySelector('.cash-flow-amount')?.textContent]);

    it.each([
      [3002.1, '$3,002.10'],
      [0, '$0.00'],
      [-60, '−$60.00'],
    ])('income %s is shown as %s', (income, expected) => {
      render(<CashFlowPace budgetCategories={CATEGORIES} semantics={summaryView({ currentMonth: cashFlowWire({ income_semantic: income }) })} budgetSemantics={budgetView()} />);
      expect(bars()[0]).toEqual(['Income this month', expected]);
      const line = Array.from(document.querySelectorAll('.cash-flow-details-line')).map((l) => l.textContent);
      expect(line[0]).toBe(`Income${expected}`);
    });
  });
});
