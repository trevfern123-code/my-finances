import { describe, expect, it } from 'vitest';
import {
  EFFECT_MEASURES,
  failureOf,
  readBudgetSemantics,
  readCashFlowFigures,
  readEffectsResponse,
  readMonthlyBreakdownSemantics,
  readSummarySemantics,
  toCents,
  totalBudgetSpending,
} from './semanticModel';
import {
  breakdownWire,
  budgetCategoryWire,
  budgetWire,
  cashFlowWire,
  effectRowWire,
  effectsPageWire,
  excludedWire,
  FROZEN_INCOME,
  FROZEN_SPENT,
  REFUSED_STATUS,
  summaryWire,
  unresolvedCashFlowWire,
} from '../testUtils/semanticFixtures';

// Financial Semantics Phase B, integration slice I2: a response becomes figures only when it is
// provably the reviewed level-2 shape. Everything else becomes a state that carries no figure.

/** Every number anywhere inside a value. */
function numbersIn(value: unknown): number[] {
  if (typeof value === 'number') return [value];
  if (value instanceof Map) return numbersIn(Array.from(value.values()));
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(numbersIn);
  return [];
}

describe('toCents', () => {
  it('is exact for cent-exact amounts that binary floating point cannot represent', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(1827.1)).toBe(182710);
    expect(toCents(-60)).toBe(-6000);
    expect(toCents(0.29)).toBe(29);
    expect(toCents(1.15)).toBe(115);
  });
});

describe('readSummarySemantics', () => {
  it('reads the role-aware figures of every month and of the current month, with the server names', () => {
    const view = readSummarySemantics(summaryWire());
    expect(view.kind).toBe('ok');
    if (view.kind !== 'ok') return;
    expect(view.months.map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    expect(view.currentMonth.cash_flow).toBe(1827.1);
    expect(view.currentMonth.income_semantic).toBe(3002.1);
    expect(view.currentMonth.spending).toBe(525);
    expect(view.currentMonth.debt_payments_unknown_principal).toBe(300);
    expect(view.currentMonth.card_payments_unresolved_credit).toBe(0);
  });

  it('never carries a frozen sign-based figure into the result', () => {
    const view = readSummarySemantics(summaryWire());
    const numbers = numbersIn(view);
    expect(numbers).not.toContain(FROZEN_SPENT);
    expect(numbers).not.toContain(FROZEN_INCOME);
  });

  it('keeps every month the server returned, in the server order', () => {
    const months = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((month) => ({ month }));
    const view = readSummarySemantics(summaryWire({ months }));
    expect(view.kind === 'ok' && view.months.map((m) => m.month)).toEqual(months.map((m) => m.month));
  });

  it('a range (unresolved card payment) is read as a range, with no single figure', () => {
    const view = readSummarySemantics(summaryWire({ currentMonth: unresolvedCashFlowWire() }));
    expect(view.kind).toBe('ok');
    if (view.kind !== 'ok') return;
    expect(view.currentMonth.cash_flow).toBeNull();
    expect(view.currentMonth.savings_rate).toBeNull();
    expect(view.currentMonth.cash_flow_range).toEqual({ low: 1727.1, high: 1827.1 });
    expect(view.currentMonth.card_payments_unresolved.count).toBe(1);
  });

  it.each([
    ['updating', { status: 'updating', retry_after_ms: 5000, reason: 'matching_pending' }, { kind: 'updating', reason: 'matching_pending', retryAfterMs: 5000 }],
    ['unavailable', { status: 'unavailable', retry_after_ms: 5000, reason: 'request_failed' }, { kind: 'unavailable', reason: 'request_failed', retryAfterMs: 5000 }],
  ])('%s is a state with no figure, and is not confused with the other', (_name, status, expected) => {
    const view = readSummarySemantics(summaryWire({ status }));
    expect(view).toEqual(expected);
    expect(numbersIn(view)).toEqual([5000]);
  });

  it('a response without semantic_status (a backend below level 2) is "backend_outdated", never the frozen fields', () => {
    const view = readSummarySemantics(summaryWire({ status: undefined }));
    expect(view).toEqual({ kind: 'backend_outdated' });
  });

  it('an updating body that still carries role-aware fields yields none of them', () => {
    const body = summaryWire();
    body.semantic_status = { status: 'updating', retry_after_ms: 5000, reason: 'matching_pending' };
    const view = readSummarySemantics(body);
    expect(view.kind).toBe('updating');
    expect(numbersIn(view)).toEqual([5000]);
  });

  it('refused is not a summary status', () => {
    expect(readSummarySemantics(summaryWire({ status: REFUSED_STATUS }))).toEqual({ kind: 'invalid' });
  });

  it.each([
    ['an unknown status', { status: 'fine' }],
    ['a status that is not an object', 'ok'],
    ['updating without a reason', { status: 'updating', retry_after_ms: 5000 }],
    ['updating with a non-numeric retry', { status: 'updating', retry_after_ms: 'soon', reason: 'matching_pending' }],
  ])('%s is invalid', (_name, status) => {
    expect(readSummarySemantics(summaryWire({ status }))).toEqual({ kind: 'invalid' });
  });

  it.each([
    ['a missing figure', (f: Record<string, unknown>) => delete f.cash_flow],
    ['a missing field of the list', (f: Record<string, unknown>) => delete f.card_payments_unresolved_credit],
    ['a figure that is a string', (f: Record<string, unknown>) => (f.spending = '525')],
    ['NaN', (f: Record<string, unknown>) => (f.income_semantic = Number.NaN)],
    ['an infinite amount', (f: Record<string, unknown>) => (f.debt_payments = Number.POSITIVE_INFINITY)],
    ['a null amount', (f: Record<string, unknown>) => (f.refunds = null)],
    ['a range with low above high', (f: Record<string, unknown>) => (f.cash_flow_range = { low: 10, high: 5 })],
    ['a missing range', (f: Record<string, unknown>) => delete f.savings_rate_range],
    ['a fractional count', (f: Record<string, unknown>) => (f.unclassified_count = 1.5)],
    ['a negative count', (f: Record<string, unknown>) => (f.unclassified_count = -1)],
    ['a malformed unresolved block', (f: Record<string, unknown>) => (f.card_payments_unresolved = { count: 0 })],
    ['a single figure that disagrees with its range', (f: Record<string, unknown>) => (f.cash_flow_range = { low: 1000, high: 1827.1 })],
    ['a single figure while a card payment is unresolved', (f: Record<string, unknown>) => (f.card_payments_unresolved = { count: 1, payments_amount: 100, returns_amount: 0, by_reason: {} })],
    ['cash flow withheld but savings rate present', (f: Record<string, unknown>) => (f.cash_flow = null)],
  ])('with status ok, %s makes the whole response invalid (no figure survives)', (_name, corrupt) => {
    const figures = cashFlowWire();
    corrupt(figures);
    expect(readSummarySemantics(summaryWire({ currentMonth: figures }))).toEqual({ kind: 'invalid' });
    expect(readSummarySemantics(summaryWire({ months: [{ month: '2026-09', figures }] }))).toEqual({ kind: 'invalid' });
  });

  it('a range with nothing unresolved is invalid', () => {
    const figures = unresolvedCashFlowWire({ card_payments_unresolved: { count: 0, payments_amount: 0, returns_amount: 0, by_reason: {} } });
    expect(readCashFlowFigures(figures)).toBeNull();
  });

  it('a repeated or malformed month is invalid', () => {
    expect(readSummarySemantics(summaryWire({ months: [{ month: '2026-09' }, { month: '2026-09' }] }))).toEqual({ kind: 'invalid' });
    expect(readSummarySemantics(summaryWire({ months: [{ month: '2026-13' }] }))).toEqual({ kind: 'invalid' });
  });

  it.each([null, undefined, 'text', 42, []])('a body that is not an object (%s) is invalid', (body) => {
    expect(readSummarySemantics(body)).toEqual({ kind: 'invalid' });
  });
});

describe('readMonthlyBreakdownSemantics', () => {
  it('reads each month from its semantic block: signed category amounts, the server order, the excluded lines', () => {
    const view = readMonthlyBreakdownSemantics(breakdownWire());
    expect(view.kind).toBe('ok');
    if (view.kind !== 'ok') return;
    expect(view.months).toHaveLength(1);
    expect(view.months[0].spending).toBe(525);
    expect(view.months[0].by_category).toEqual([
      { category: 'FOOD_AND_DRINK', amount: 535 },
      { category: 'LOAN_INTEREST', amount: 50 },
      { category: 'GENERAL_MERCHANDISE', amount: -60 },
    ]);
    expect(view.months[0].excluded.debt_payments).toBe(650);
    expect(numbersIn(view)).not.toContain(FROZEN_SPENT);
    expect(numbersIn(view)).not.toContain(7777);
  });

  it('never drops or adds a month: the months are exactly the ones the server returned', () => {
    const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09'].map((month) => ({ month, spending: 1 }));
    const view = readMonthlyBreakdownSemantics(breakdownWire({ months }));
    expect(view.kind === 'ok' && view.months.map((m) => m.month)).toEqual(months.map((m) => m.month));
  });

  it('an ok status with a month that has no semantic block is invalid, not a frozen month', () => {
    const body = breakdownWire({ months: [{ month: '2026-08' }, { month: '2026-09' }] });
    delete (body.months as Record<string, unknown>[])[0].semantic;
    expect(readMonthlyBreakdownSemantics(body)).toEqual({ kind: 'invalid' });
  });

  it.each([
    ['updating', { status: 'updating', retry_after_ms: 5000, reason: 'matching_failed' }],
    ['unavailable', { status: 'unavailable', retry_after_ms: 5000, reason: 'timeout' }],
  ])('%s carries no month and no figure', (kind, status) => {
    const view = readMonthlyBreakdownSemantics(breakdownWire({ status }));
    expect(view.kind).toBe(kind);
    expect(numbersIn(view)).toEqual([5000]);
  });

  it('no semantic_status is backend_outdated; a malformed excluded block or category is invalid', () => {
    expect(readMonthlyBreakdownSemantics(breakdownWire({ status: undefined }))).toEqual({ kind: 'backend_outdated' });
    expect(readMonthlyBreakdownSemantics(breakdownWire({ months: [{ month: '2026-09', excluded: { debt_payments: 1 } }] }))).toEqual({ kind: 'invalid' });
    expect(readMonthlyBreakdownSemantics(breakdownWire({ months: [{ month: '2026-09', by_category: [{ category: '', amount: 1 }] }] }))).toEqual({ kind: 'invalid' });
    expect(
      readMonthlyBreakdownSemantics(
        breakdownWire({ months: [{ month: '2026-09', by_category: [{ category: 'A', amount: 1 }, { category: 'A', amount: 2 }] }] })
      )
    ).toEqual({ kind: 'invalid' });
    expect(readMonthlyBreakdownSemantics(breakdownWire({ months: [{ month: '2026-09', excluded: excludedWire({ transfers_internal: 'x' }) }] }))).toEqual({
      kind: 'invalid',
    });
  });
});

describe('readBudgetSemantics', () => {
  it('reads signed role-aware spending per category and none of the frozen figures', () => {
    const view = readBudgetSemantics(budgetWire());
    expect(view.kind).toBe('ok');
    if (view.kind !== 'ok') return;
    expect(view.byCategoryId.get('cat-1')).toEqual({ spending: 50, recent_avg_spending: 120 });
    expect(view.byCategoryId.get('cat-2')).toEqual({ spending: -60, recent_avg_spending: 0 });
    expect(numbersIn(view)).not.toContain(FROZEN_SPENT);
    expect(numbersIn(view)).not.toContain(7777);
  });

  it('refused keeps no figure and exposes none of the server detail (ids, amounts)', () => {
    const view = readBudgetSemantics(budgetWire({ status: REFUSED_STATUS }));
    expect(view).toEqual({ kind: 'refused' });
  });

  it.each([
    ['updating', { status: 'updating', retry_after_ms: 5000, reason: 'matching_pending' }],
    ['unavailable', { status: 'unavailable', retry_after_ms: 5000, reason: 'request_failed' }],
  ])('%s keeps no figure', (kind, status) => {
    expect(readBudgetSemantics(budgetWire({ status })).kind).toBe(kind);
  });

  it('ok with a category that has no role-aware figure is invalid, never the frozen `spent`', () => {
    const body = budgetWire({ categories: [budgetCategoryWire({ id: 'cat-1', spending: 50, recent_avg_spending: 1 }), budgetCategoryWire({ id: 'cat-2' })] });
    expect(readBudgetSemantics(body)).toEqual({ kind: 'invalid' });
  });

  it('no semantic_status is backend_outdated', () => {
    expect(readBudgetSemantics(budgetWire({ status: undefined }))).toEqual({ kind: 'backend_outdated' });
  });
});

describe('totalBudgetSpending', () => {
  it('adds signed spending in cents, and is null when any category has no figure', () => {
    const byId = new Map([
      ['a', { spending: 0.1, recent_avg_spending: 0 }],
      ['b', { spending: 0.2, recent_avg_spending: 0 }],
      ['c', { spending: -60, recent_avg_spending: 0 }],
    ]);
    expect(totalBudgetSpending(byId, ['a', 'b'])).toBe(0.3);
    expect(totalBudgetSpending(byId, ['a', 'b', 'c'])).toBe(-59.7);
    expect(totalBudgetSpending(byId, ['a', 'missing'])).toBeNull();
    expect(totalBudgetSpending(byId, [])).toBe(0);
  });
});

describe('readEffectsResponse', () => {
  it('reads rows with the server signed amounts, the complete total and count, and the cursor', () => {
    const rows = [effectRowWire({ effect_amount: 75 }), effectRowWire({ effect_amount: -60, effect_role: 'refund' }), effectRowWire({ effect_amount: 50, allocation: 'interest' })];
    const page = readEffectsResponse(effectsPageWire(rows, { total_amount: 2980.5, total_count: 120 }, 'cursor-1'));
    expect(page.kind).toBe('ok');
    if (page.kind !== 'ok') return;
    expect(page.rows.map((r) => r.effect_amount)).toEqual([75, -60, 50]);
    expect(page.rows[2].allocation).toBe('interest');
    expect(page.total_amount).toBe(2980.5);
    expect(page.total_count).toBe(120);
    expect(page.next_cursor).toBe('cursor-1');
  });

  it('a split row keeps its split id and note; a plain row has neither', () => {
    const page = readEffectsResponse(
      effectsPageWire([effectRowWire({ allocation: 'split', split_id: 'split-1', split_note: 'half' }), effectRowWire()], { total_amount: 20, total_count: 2 })
    );
    expect(page.kind === 'ok' && page.rows.map((r) => [r.split_id, r.split_note])).toEqual([
      ['split-1', 'half'],
      [null, null],
    ]);
  });

  it('updating and unavailable carry no row and no total', () => {
    expect(readEffectsResponse({ status: 'updating', retry_after_ms: 5000, reason: 'matching_pending' })).toEqual({
      kind: 'updating',
      reason: 'matching_pending',
      retryAfterMs: 5000,
    });
    expect(readEffectsResponse({ status: 'unavailable', retry_after_ms: 5000, reason: 'timeout' }).kind).toBe('unavailable');
  });

  it.each([
    ['no status', { rows: [], total_amount: 0, total_count: 0, next_cursor: null }],
    ['rows that are not a list', { status: 'ok', rows: {}, total_amount: 0, total_count: 0, next_cursor: null }],
    ['a missing total', { status: 'ok', rows: [], total_count: 0, next_cursor: null }],
    ['a NaN total', { status: 'ok', rows: [], total_amount: Number.NaN, total_count: 0, next_cursor: null }],
    ['a negative count', { status: 'ok', rows: [], total_amount: 0, total_count: -1, next_cursor: null }],
    ['a missing cursor field', { status: 'ok', rows: [], total_amount: 0, total_count: 0 }],
    ['an empty cursor', { status: 'ok', rows: [], total_amount: 0, total_count: 0, next_cursor: '' }],
    ['a row without an amount', effectsPageWire([{ ...effectRowWire(), effect_amount: undefined }], { total_amount: 0, total_count: 1 })],
    ['a row with a string amount', effectsPageWire([effectRowWire({ effect_amount: '10' })], { total_amount: 10, total_count: 1 })],
    ['a row with an unknown allocation', effectsPageWire([effectRowWire({ allocation: 'guess' })], { total_amount: 10, total_count: 1 })],
    ['a row without a transaction', effectsPageWire([{ ...effectRowWire(), transaction: null }], { total_amount: 10, total_count: 1 })],
    ['a row with a malformed date', effectsPageWire([effectRowWire({}, { date: 'Sep 12' })], { total_amount: 10, total_count: 1 })],
    ['a body that is not an object', 'ok'],
  ])('%s is invalid', (_name, body) => {
    expect(readEffectsResponse(body)).toEqual({ kind: 'invalid' });
  });
});

describe('the drill-down measures', () => {
  it('are exactly the measures the backend publishes (backend CASH_FLOW_MEASURES), including the neutral credit bucket', () => {
    expect([...EFFECT_MEASURES]).toEqual([
      'spending',
      'income',
      'debt_payments',
      'known_principal',
      'debt_payments_unknown_principal',
      'refunds',
      'transfers_internal',
      'transfers_external',
      'credit_card_payments_tracked',
      'credit_card_payments_untracked',
      'credit_card_payments_returned_tracked',
      'credit_card_payments_returned_untracked',
      'credit_card_payments_externally_funded',
      'credit_card_payments_reversed_externally',
      'card_payments_unresolved_credit',
      'card_payments_unresolved_payments',
      'card_payments_unresolved_returns',
      'unclassified',
    ]);
  });
});

describe('failureOf', () => {
  it('keeps only the machine-readable code of a failed request', () => {
    expect(failureOf(Object.assign(new Error('One transaction has inconsistent data'), { code: 'semantic_integrity_error', transaction_id: 'secret' }))).toEqual({
      kind: 'failed',
      code: 'semantic_integrity_error',
    });
    expect(failureOf(new Error('Failed to fetch'))).toEqual({ kind: 'failed', code: null });
    expect(failureOf(null)).toEqual({ kind: 'failed', code: null });
  });
});
