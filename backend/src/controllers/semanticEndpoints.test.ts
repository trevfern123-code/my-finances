import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const mockData = vi.hoisted(() => ({
  getAccountBalancesForUser: vi.fn(),
  getTransactionsSince: vi.fn(),
  getCategorizedTransactionsSince: vi.fn(),
  getUserPreferences: vi.fn(),
  listBudgetCategories: vi.fn(),
  getCategorySpendRows: vi.fn(),
}));
vi.mock('../services/dataService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/dataService')>()),
  ...mockData,
}));
const mockSnapshot = vi.hoisted(() => vi.fn());
vi.mock('../services/financialSnapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/financialSnapshot')>()),
  readFinancialSnapshot: mockSnapshot,
}));
const mockPoll = vi.hoisted(() => vi.fn());
vi.mock('../services/cardPaymentStateReader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/cardPaymentStateReader')>()),
  readCardPaymentStates: mockPoll,
}));

import { getMonthlyBreakdown, getSpendingSummary, listTransactionEffects } from './plaidController';
import { listBudgetCategories } from './budgetCategoryController';
import { errorHandler } from '../middleware/errorHandler';
import { SemanticResultInconsistentError, semanticErrorResponse } from '../middleware/semanticErrors';
import { API_LEVEL, MIN_CLIENT_API_LEVEL } from '../middleware/clientApiLevel';
import { alignMonths, cashFlowFields, monthlyBreakdownSemanticFields, SEMANTIC_FIELDS_MIN_CLIENT_API_LEVEL } from './semanticResponse';
import { categorySpendRowsOf } from '../services/dataService';
import type { FinancialSnapshotRequest } from '../services/financialSnapshot';
import { AggregateSnapshotUnavailableError, AggregateTooLargeError, KeysetOrderError } from '../services/fetchAllPages';
import {
  aggregateCashFlow,
  aggregateMonthlyBreakdown,
  CardPaymentStateIntegrityError,
  SemanticAggregationIntegrityError,
  SplitAllocationMismatchError,
} from '../services/semanticAggregation';
import { SemanticIntegrityError } from '../services/semanticEffects';
import { EFFECT_MEASURES, SEMANTIC_READ_RETRY_AFTER_MS } from '../services/semanticReadPath';
import { CATEGORY, SEPTEMBER, fixtureTransactions, withRow } from '../testUtils/phaseBFixture';
import { cashFlowInput } from '../testUtils/cardStatesFromOracle';
import {
  fixtureSnapshot,
  freshStates,
  idOf,
  includedTransactions,
  serveSnapshot,
  staleStates,
  uuid,
  withUuids,
  type CardState,
  type Snapshot,
} from '../testUtils/semanticSnapshot';

// Financial Semantics Phase B, slice I1 — the role-aware read path on the wire.
//
// The database is replaced by the §9.1 fixture: the frozen reads (`dataService`) and the snapshot
// function (`readFinancialSnapshot`) both answer from `db.state` at the moment they are called.
// Everything between them and the response is real: the controllers, the read path, the pure
// aggregation module and the error handler. "Today" is 2026-09-20, so September is the current month.

const USER = 'user-1';
const NOW = new Date('2026-09-20T12:00:00Z');

const db: { state: Snapshot; cards: CardState; afterSnapshot: (() => void) | null } = { state: fixtureSnapshot(), cards: { fresh: 7 }, afterSnapshot: null };

function serve(state: Snapshot, cards: CardState = { fresh: 7 }): void {
  db.state = state;
  db.cards = cards;
}

function wireDatabase(): void {
  mockData.getAccountBalancesForUser.mockResolvedValue([
    { type: 'depository', current_balance: 5000 },
    { type: 'credit', current_balance: 400 },
  ]);
  mockData.getTransactionsSince.mockImplementation(async (_user: string, start: string, end?: string) =>
    includedTransactions(db.state, { start, end }).map((t) => ({ amount: t.amount, date: t.date }))
  );
  mockData.getCategorizedTransactionsSince.mockImplementation(async (_user: string, start: string, end?: string) =>
    includedTransactions(db.state, { start, end }).map((t) => ({ amount: t.amount, date: t.date, category: t.plaidCategory }))
  );
  mockData.getCategorySpendRows.mockImplementation(async (_user: string, range: { start: string; end: string }) => {
    const rows = includedTransactions(db.state, range).map((t) => ({ id: t.id, budget_category_id: t.budgetCategoryId, amount: t.amount }));
    const ids = new Set(rows.map((r) => r.id));
    return categorySpendRowsOf(rows, (db.state.splits ?? []).filter((s) => ids.has(s.transaction_id)));
  });
  mockData.getUserPreferences.mockResolvedValue({ recent_avg_months: 1 });
  mockData.listBudgetCategories.mockImplementation(async () => db.state.categories ?? []);
  mockSnapshot.mockImplementation(async (_user: string, request: FinancialSnapshotRequest) => {
    const answer = serveSnapshot(db.state, request, db.cards);
    const after = db.afterSnapshot;
    db.afterSnapshot = null;
    after?.();
    return answer;
  });
  mockPoll.mockImplementation(async () => ('fresh' in db.cards ? freshStates(db.state, db.cards.fresh) : staleStates(db.cards.stale)));
}
const frozenReads = () => [mockData.getTransactionsSince, mockData.getCategorizedTransactionsSince, mockData.getCategorySpendRows, mockData.listBudgetCategories];
const frozenReadCount = () => frozenReads().reduce((sum, mock) => sum + mock.mock.calls.length, 0);

function request(level: number | undefined, query: Record<string, unknown> = {}): Request {
  return {
    user: { id: USER },
    query,
    params: {},
    get: (name: string) => (name.toLowerCase() === 'x-client-api-level' && level !== undefined ? String(level) : undefined),
  } as unknown as Request;
}

interface Captured {
  status: number;
  body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Runs a controller the way the app does: a thrown error goes to the real global error handler. */
async function call(handler: (req: Request, res: Response, next: NextFunction) => Promise<void>, req: Request): Promise<Captured> {
  const captured: Captured = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      // What the client receives is the serialized body: NaN, undefined and Maps do not survive it.
      captured.body = JSON.parse(JSON.stringify(body));
      return res;
    },
  } as unknown as Response;
  let failure: unknown;
  let failed = false;
  await handler(req, res, ((err: unknown) => {
    failed = true;
    failure = err;
  }) as NextFunction);
  if (failed) errorHandler(failure, req, res, (() => {}) as NextFunction);
  return captured;
}

const round = (value: number) => Math.round(value * 100) / 100;
const SEMANTIC_CASH_FLOW_KEYS = [
  'spending',
  'income_semantic',
  'debt_payments',
  'known_principal',
  'debt_payments_unknown_principal',
  'transfers_internal',
  'transfers_external',
  'credit_card_payments_tracked',
  'credit_card_payments_untracked',
  'credit_card_payments_returned_tracked',
  'credit_card_payments_returned_untracked',
  'credit_card_payments_externally_funded',
  'credit_card_payments_reversed_externally',
  'card_payments_unresolved_credit',
  'refunds',
  'cash_flow',
  'cash_flow_range',
  'savings_rate',
  'savings_rate_range',
  'card_payments_unresolved',
  'unclassified_count',
  'unclassified_amount',
];

let errorLog: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] }); // the read path's short wait uses real timers
  vi.setSystemTime(NOW);
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  db.afterSnapshot = null;
  serve(fixtureSnapshot());
  wireDatabase();
});
afterEach(() => {
  vi.useRealTimers();
  errorLog.mockRestore();
});

describe('the compatibility contract this slice relies on', () => {
  it('the backend level is NOT raised here, no client is refused, and every semantic surface starts at level 2', () => {
    expect(API_LEVEL).toBe(1);
    expect(MIN_CLIENT_API_LEVEL).toBe(0);
    expect(SEMANTIC_FIELDS_MIN_CLIENT_API_LEVEL).toBe(2);
  });
});

describe('GET /api/plaid/summary', () => {
  it.each([undefined, 0, 1])('a client at level %s gets exactly today\'s response: the frozen reads only, no snapshot, no semantic field', async (level) => {
    const { status, body } = await call(getSpendingSummary, request(level));
    expect(status).toBe(200);
    expect(Object.keys(body)).toEqual(['net_worth', 'total_assets', 'total_liabilities', 'monthly_spending', 'current_month']);
    expect(body.monthly_spending.map((m: object) => Object.keys(m))).toEqual([
      ['month', 'spent', 'income'],
      ['month', 'spent', 'income'],
    ]);
    expect(Object.keys(body.current_month)).toEqual(['spent', 'income']);
    // Design §9.1 "Sign-based (today)": income 4 462.10, spending 2 635.00.
    expect(round(body.current_month.income)).toBe(4462.1);
    expect(round(body.current_month.spent)).toBe(2635);
    expect(mockData.getTransactionsSince).toHaveBeenCalledTimes(2);
    expect(mockSnapshot).not.toHaveBeenCalled();
    expect(mockPoll).not.toHaveBeenCalled();
  });

  it('level 2: frozen and role-aware fields from ONE snapshot — the frozen fields are identical to a level-1 response, and no frozen read is made', async () => {
    const legacy = (await call(getSpendingSummary, request(1))).body;
    vi.clearAllMocks();
    wireDatabase();
    const { status, body } = await call(getSpendingSummary, request(2));
    expect(status).toBe(200);
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(frozenReadCount()).toBe(0);

    // Frozen (design §6.4): every pre-existing field, unchanged — exactly equal, not approximately.
    for (const key of ['net_worth', 'total_assets', 'total_liabilities']) expect(body[key]).toBe(legacy[key]);
    expect(body.monthly_spending.map((m: any) => ({ month: m.month, spent: m.spent, income: m.income }))).toEqual(legacy.monthly_spending);
    expect({ spent: body.current_month.spent, income: body.current_month.income }).toEqual(legacy.current_month);

    // New (design §5 C1–C4, §9.1 "Phase B").
    expect(body.semantic_status).toEqual({ status: 'ok' });
    expect(Object.keys(body.current_month)).toEqual(['spent', 'income', ...SEMANTIC_CASH_FLOW_KEYS]);
    expect(body.current_month).toMatchObject({
      spending: 525,
      income_semantic: 3002.1,
      debt_payments: 650,
      known_principal: 350,
      debt_payments_unknown_principal: 300,
      transfers_internal: 500,
      transfers_external: 0,
      credit_card_payments_tracked: 900,
      credit_card_payments_untracked: 0,
      credit_card_payments_externally_funded: 0,
      card_payments_unresolved_credit: 0,
      refunds: -60,
      cash_flow: 1827.1,
      cash_flow_range: { low: 1827.1, high: 1827.1 },
      card_payments_unresolved: { count: 0, payments_amount: 0, returns_amount: 0, by_reason: {} },
      unclassified_count: 0,
    });
    expect(Math.round(body.current_month.savings_rate * 1000) / 10).toBe(72.5);
    // The sign-based net and the role-aware cash flow agree for the fixture (§6.4) — the gross figures differ.
    expect(round(body.current_month.income - body.current_month.spent)).toBe(body.current_month.cash_flow);
    expect(body.monthly_spending.map((m: any) => [m.month, m.cash_flow, m.unclassified_count])).toEqual([
      ['2026-08', -45, 1],
      ['2026-09', 1827.1, 0],
    ]);
  });

  it('level 2 with an unresolved card payment: cash_flow is null, the range carries both figures, and the card leg is an unresolved card credit', async () => {
    serve(fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '5b', { date: '2026-09-17' })) }));
    const { body } = await call(getSpendingSummary, request(2));
    expect(body.semantic_status).toEqual({ status: 'ok' });
    expect(body.current_month).toMatchObject({
      cash_flow: null,
      savings_rate: null,
      cash_flow_range: { low: 927.1, high: 1827.1 },
      credit_card_payments_tracked: 0,
      credit_card_payments_untracked: 0,
      credit_card_payments_externally_funded: 0, // never asserted for an unresolved leg
      card_payments_unresolved_credit: 900,
      card_payments_unresolved: { count: 1, payments_amount: 900, returns_amount: 0, by_reason: { possible_match: 1 } },
    });
  });

  it.each([
    ['stale matching state', { stale: null }, { status: 'updating', retry_after_ms: SEMANTIC_READ_RETRY_AFTER_MS, reason: 'matching_pending' }],
    ['a failed evaluation', { stale: '22012' }, { status: 'updating', retry_after_ms: SEMANTIC_READ_RETRY_AFTER_MS, reason: 'matching_failed' }],
  ] as const)('level 2 with %s: HTTP 200, NO role-aware figure anywhere, frozen fields intact — from the snapshot, not a second read', async (_name, cards, expectedStatus) => {
    const legacy = (await call(getSpendingSummary, request(1))).body;
    vi.clearAllMocks();
    wireDatabase();
    db.cards = cards;
    const { status, body } = await call(getSpendingSummary, request(2));
    expect(status).toBe(200);
    expect(body.semantic_status).toEqual(expectedStatus);
    const { semantic_status: _status, ...rest } = body;
    expect(rest).toEqual(legacy);
    for (const key of SEMANTIC_CASH_FLOW_KEYS) {
      expect(body.current_month).not.toHaveProperty(key);
      for (const month of body.monthly_spending) expect(month).not.toHaveProperty(key);
    }
    expect(frozenReadCount()).toBe(0);
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
  });

  it.each(['objects_missing', 'timeout', 'request_failed'] as const)(
    'level 2 when the snapshot could not be read (%s): HTTP 200, `unavailable` — distinct from updating — with the frozen fields from the frozen reads',
    async (reason) => {
      const legacy = (await call(getSpendingSummary, request(1))).body;
      vi.clearAllMocks();
      wireDatabase();
      mockSnapshot.mockResolvedValue({ kind: 'unavailable', reason });
      const { status, body } = await call(getSpendingSummary, request(2));
      expect(status).toBe(200);
      expect(body.semantic_status).toEqual({ status: 'unavailable', retry_after_ms: SEMANTIC_READ_RETRY_AFTER_MS, reason });
      const { semantic_status: _status, ...rest } = body;
      expect(rest).toEqual(legacy);
      expect(mockData.getTransactionsSince).toHaveBeenCalledTimes(2);
    }
  );

  it('level 2 with an impossible loan principal: 500 semantic_integrity_error naming only the user\'s own row; a level-1 request keeps its frozen behaviour', async () => {
    serve(fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '6', { principalPortion: 450 })) }));
    const { status, body } = await call(getSpendingSummary, request(2));
    expect(status).toBe(500);
    expect(body).toEqual({
      error: 'One transaction has inconsistent data, so these figures are paused.',
      code: 'semantic_integrity_error',
      transaction_id: idOf('6'),
    });
    // No new semantic failure reaches a released client.
    const legacy = await call(getSpendingSummary, request(1));
    expect(legacy.status).toBe(200);
    expect(round(legacy.body.current_month.spent)).toBe(2635);
  });

  it('level 2 with a card leg that has no stored state in a fresh snapshot: 500 card_payment_state_integrity', async () => {
    mockSnapshot.mockImplementation(async (_user: string, snapshotRequest: FinancialSnapshotRequest) => {
      const answer = serveSnapshot(db.state, snapshotRequest, db.cards);
      if (answer.kind === 'snapshot' && answer.snapshot.cardPayments?.kind === 'fresh') {
        const states = answer.snapshot.cardPayments.states;
        states.legs = states.legs.filter((leg) => leg.transactionId !== idOf('5a'));
      }
      return answer;
    });
    const { status, body } = await call(getSpendingSummary, request(2));
    expect(status).toBe(500);
    expect(body).toEqual({
      error: 'A card payment has no usable matching state, so these figures are paused.',
      code: 'card_payment_state_integrity',
      transaction_id: idOf('5a'),
    });
  });

  it('a later request observes fresh state once something else has evaluated — the request itself evaluates nothing', async () => {
    db.cards = { stale: null };
    expect((await call(getSpendingSummary, request(2))).body.semantic_status.status).toBe('updating');
    expect((await call(getSpendingSummary, request(2))).body.semantic_status.status).toBe('updating'); // still stale: nothing evaluated
    db.cards = { fresh: 8 };
    const { body } = await call(getSpendingSummary, request(2));
    expect(body.semantic_status).toEqual({ status: 'ok' });
    expect(body.current_month.cash_flow).toBe(1827.1);
  });

  it('the snapshot covers the same reporting range as the frozen read', async () => {
    await call(getSpendingSummary, request(1, { range_id: 'last_month' }));
    const [, legacyStart, legacyEnd] = mockData.getTransactionsSince.mock.calls[0];
    expect([legacyStart, legacyEnd]).toEqual(['2026-08-01', '2026-09-01']);
    await call(getSpendingSummary, request(2, { range_id: 'last_month' }));
    // Rows for [last month, end of the current month) padded for transfer context; card states for that range.
    expect(mockSnapshot).toHaveBeenCalledWith(USER, {
      rows: { start: '2026-07-26', end: '2026-10-07' },
      cardStates: { from: '2026-08-01', to: '2026-10-01' },
    });
  });
});

describe('month alignment (review finding F4)', () => {
  // The first October transaction commits just as the request is being served.
  const withOctober = () =>
    fixtureSnapshot({ transactions: [...withUuids(fixtureTransactions()), { ...withUuids(fixtureTransactions())[1], id: uuid(50), date: '2026-10-02', amount: 33 }] });

  it('a month created around the request: each response has the month in BOTH halves or in neither — never role-aware-only, never frozen-only', async () => {
    db.afterSnapshot = () => serve(withOctober(), { fresh: 8 });
    const before = (await call(getSpendingSummary, request(2, { months: '3' }))).body;
    const after = (await call(getSpendingSummary, request(2, { months: '3' }))).body;
    expect(before.monthly_spending.map((m: any) => m.month)).toEqual(['2026-08', '2026-09']);
    expect(after.monthly_spending.map((m: any) => m.month)).toEqual(['2026-08', '2026-09', '2026-10']);
    for (const body of [before, after]) {
      expect(body.semantic_status).toEqual({ status: 'ok' });
      for (const month of body.monthly_spending) {
        expect(Object.keys(month)).toEqual(['month', 'spent', 'income', ...SEMANTIC_CASH_FLOW_KEYS]);
      }
    }
    expect(after.monthly_spending[2]).toMatchObject({ month: '2026-10', spent: 33, spending: 33 });
  });

  it('a month that disappears around the request (its only row is deleted) is absent from both halves of the next response', async () => {
    serve(withOctober());
    db.afterSnapshot = () => serve(fixtureSnapshot(), { fresh: 8 });
    const before = (await call(getMonthlyBreakdown, request(2, { months: '3' }))).body;
    const after = (await call(getMonthlyBreakdown, request(2, { months: '3' }))).body;
    expect(before.months.map((m: any) => [m.month, 'semantic' in m])).toEqual([
      ['2026-08', true],
      ['2026-09', true],
      ['2026-10', true],
    ]);
    expect(after.months.map((m: any) => [m.month, 'semantic' in m])).toEqual([
      ['2026-08', true],
      ['2026-09', true],
    ]);
  });

  it('alignMonths pairs every month, in order, and treats a one-sided month as an integrity failure instead of dropping it', () => {
    const frozen = [{ month: '2026-08', spent: 1 }, { month: '2026-09', spent: 2 }];
    const semantic = [{ month: '2026-09', spending: 20 }, { month: '2026-08', spending: 10 }];
    expect(alignMonths(frozen, semantic)).toEqual([
      [frozen[0], semantic[1]],
      [frozen[1], semantic[0]],
    ]);
    expect(alignMonths([], [])).toEqual([]);
    // Role-aware-only month (the F4 defect would have dropped it):
    expect(() => alignMonths(frozen, [...semantic, { month: '2026-10', spending: 5 }])).toThrow(SemanticResultInconsistentError);
    expect(() => alignMonths(frozen, [...semantic, { month: '2026-10', spending: 5 }])).toThrow(/2026-10 is present only in the role-aware result/);
    // Frozen-only month (the F4 defect would have published it under `ok`):
    expect(() => alignMonths(frozen, [semantic[0]])).toThrow(/2026-08 is present only in the frozen result/);
    expect(semanticErrorResponse(new SemanticResultInconsistentError('month 2026-10 …'))).toEqual({
      status: 500,
      body: { error: 'These figures could not be assembled consistently, so none were returned.', code: 'semantic_result_inconsistent' },
    });
  });
});

describe('GET /api/plaid/monthly-breakdown', () => {
  it('below level 2: exactly today\'s months; no snapshot', async () => {
    const { body } = await call(getMonthlyBreakdown, request(1));
    expect(Object.keys(body)).toEqual(['months']);
    expect(body.months.map((m: object) => Object.keys(m))).toEqual([
      ['month', 'total_spent', 'total_income', 'by_category'],
      ['month', 'total_spent', 'total_income', 'by_category'],
    ]);
    const sept = body.months[1];
    expect(round(sept.total_spent)).toBe(2635);
    expect(round(sept.total_income)).toBe(4462.1);
    expect(sept.by_category.find((c: any) => c.category === 'LOAN_PAYMENTS').amount).toBe(1600); // 900 + 400 + 300, sign-based
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('level 2: each month gains `semantic` from the same snapshot; the frozen fields beside it are identical to a level-1 response', async () => {
    const legacy = (await call(getMonthlyBreakdown, request(1))).body;
    vi.clearAllMocks();
    wireDatabase();
    const { body } = await call(getMonthlyBreakdown, request(2));
    expect(body.semantic_status).toEqual({ status: 'ok' });
    expect(frozenReadCount()).toBe(0);
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(body.months.map(({ semantic: _semantic, ...frozen }: any) => frozen)).toEqual(legacy.months);
    expect(body.months[1].semantic).toEqual({
      spending: 525,
      income: 3002.1,
      // FOOD_AND_DRINK 400, TRANSFER_OUT 75, LOAN_INTEREST 50, GENERAL_MERCHANDISE 0 (60 − 60) — design §9.1.
      by_category: [
        { category: 'FOOD_AND_DRINK', amount: 400 },
        { category: 'TRANSFER_OUT', amount: 75 },
        { category: 'LOAN_INTEREST', amount: 50 },
        { category: 'GENERAL_MERCHANDISE', amount: 0 },
      ],
      excluded: {
        transfers_internal: 500,
        transfers_external: 0,
        credit_card_payments_tracked: 900,
        credit_card_payments_untracked: 0,
        credit_card_payments_returned_untracked: 0,
        debt_payments: 650,
        card_payments_unresolved: { count: 0, payments_amount: 0, returns_amount: 0, by_reason: {} },
      },
    });
  });

  it('level 2 while matching is stale: no `semantic` block on any month; frozen months intact', async () => {
    const legacy = (await call(getMonthlyBreakdown, request(1))).body;
    db.cards = { stale: null };
    const { status, body } = await call(getMonthlyBreakdown, request(2));
    expect(status).toBe(200);
    expect(body.months).toEqual(legacy.months);
    expect(body.semantic_status).toEqual({ status: 'updating', retry_after_ms: SEMANTIC_READ_RETRY_AFTER_MS, reason: 'matching_pending' });
  });

  it('level 2 when the snapshot is unavailable: frozen months from the frozen read, `unavailable`', async () => {
    const legacy = (await call(getMonthlyBreakdown, request(1))).body;
    mockSnapshot.mockResolvedValue({ kind: 'unavailable', reason: 'objects_missing' });
    const { status, body } = await call(getMonthlyBreakdown, request(2));
    expect(status).toBe(200);
    expect(body).toEqual({ months: legacy.months, semantic_status: { status: 'unavailable', retry_after_ms: SEMANTIC_READ_RETRY_AFTER_MS, reason: 'objects_missing' } });
  });

  it('level 2 with inconsistent loan data: 500 semantic_integrity_error; level 1 is unaffected', async () => {
    serve(fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '6', { principalPortion: 450 })) }));
    const { status, body } = await call(getMonthlyBreakdown, request(2));
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'semantic_integrity_error', transaction_id: idOf('6') });
    expect((await call(getMonthlyBreakdown, request(1))).status).toBe(200);
  });
});

describe('GET /api/budget-categories', () => {
  const categoryOf = (body: any, id: string) => body.categories.find((c: any) => c.id === id);

  it('below level 2: exactly today\'s categories — `spent` and `recent_avg_spent` only; no snapshot', async () => {
    const { body } = await call(listBudgetCategories, request(1));
    expect(Object.keys(body)).toEqual(['categories']);
    for (const category of body.categories) {
      expect(category).not.toHaveProperty('spending');
      expect(category).not.toHaveProperty('recent_avg_spending');
    }
    expect(categoryOf(body, CATEGORY.groceries).spent).toBe(270);
    expect(categoryOf(body, CATEGORY.dining).recent_avg_spent).toBe(45);
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('level 2: categories, frozen and role-aware spend from ONE snapshot; the frozen part is identical to a level-1 response', async () => {
    const legacy = (await call(listBudgetCategories, request(1))).body;
    vi.clearAllMocks();
    wireDatabase();
    const { body } = await call(listBudgetCategories, request(2));
    expect(body.semantic_status).toEqual({ status: 'ok' });
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSnapshot).toHaveBeenCalledWith(USER, { rows: { start: '2026-08-01', end: '2026-10-01' }, splits: true, budgetCategories: true });
    expect(frozenReadCount()).toBe(0);
    expect(body.categories.map(({ spending: _s, recent_avg_spending: _r, ...frozen }: any) => frozen)).toEqual(legacy.categories);
    // Design §9.1: Groceries 270, Dining 80, Shopping 0 (60 − 60), Household 50.
    expect(body.categories.map((c: any) => [c.id, c.spending])).toEqual([
      [CATEGORY.groceries, 270],
      [CATEGORY.dining, 80],
      [CATEGORY.shopping, 0],
      [CATEGORY.household, 50],
    ]);
    expect(categoryOf(body, CATEGORY.dining).recent_avg_spending).toBe(45);
  });

  it('level 2: a negative category total is preserved (a refund of last month\'s purchase)', async () => {
    serve(fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '8a', { date: '2026-08-18' })) }));
    const { body } = await call(listBudgetCategories, request(2));
    expect(categoryOf(body, CATEGORY.shopping).spending).toBe(-60);
    expect(categoryOf(body, CATEGORY.shopping).recent_avg_spending).toBe(60);
  });

  it('level 2 while matching is stale: the budget is still published (it reads no card state)', async () => {
    db.cards = { stale: null };
    const { body } = await call(listBudgetCategories, request(2));
    expect(body.semantic_status).toEqual({ status: 'ok' });
    expect(categoryOf(body, CATEGORY.groceries).spending).toBe(270);
    expect(mockPoll).not.toHaveBeenCalled();
  });

  it('level 2 with a split that no longer adds up: HTTP 200, category list and frozen fields kept, the result REFUSED and every role-aware figure withheld', async () => {
    const state = fixtureSnapshot();
    state.splits![0] = { ...state.splits![0], amount: 149.99 };
    serve(state);
    const legacy = (await call(listBudgetCategories, request(1))).body;
    const { status, body } = await call(listBudgetCategories, request(2));
    expect(status).toBe(200);
    expect(body.categories).toEqual(legacy.categories);
    expect(body.categories).toHaveLength(4);
    for (const category of body.categories) {
      expect(category).not.toHaveProperty('spending');
      expect(category).not.toHaveProperty('recent_avg_spending');
    }
    expect(body.semantic_status).toEqual({
      status: 'refused',
      code: 'split_allocation_mismatch',
      transaction_id: idOf('10'),
      mismatches: [{ transaction_id: idOf('10'), parent_amount: 200, split_total: 199.99 }],
    });
  });

  it('level 2 when the snapshot is unavailable: frozen fields from the frozen reads, `unavailable`, no role-aware field', async () => {
    const legacy = (await call(listBudgetCategories, request(1))).body;
    mockSnapshot.mockResolvedValue({ kind: 'unavailable', reason: 'objects_missing' });
    const { status, body } = await call(listBudgetCategories, request(2));
    expect(status).toBe(200);
    expect(body).toEqual({ categories: legacy.categories, semantic_status: { status: 'unavailable', retry_after_ms: SEMANTIC_READ_RETRY_AFTER_MS, reason: 'objects_missing' } });
  });

  it('level 2 with inconsistent loan data: 500 semantic_integrity_error; level 1 is unaffected', async () => {
    serve(fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '6', { principalPortion: 450 })) }));
    const { status, body } = await call(listBudgetCategories, request(2));
    expect(status).toBe(500);
    expect(body).toMatchObject({ code: 'semantic_integrity_error', transaction_id: idOf('6') });
    expect((await call(listBudgetCategories, request(1))).status).toBe(200);
  });
});

describe('GET /api/plaid/transactions/effects', () => {
  const SEPT = { start: '2026-09-01', end: '2026-10-01' };
  // Real budget categories have uuid ids, and the endpoint accepts nothing else: give the fixture's some.
  const CATEGORY_ID: Record<string, string> = Object.fromEntries(Object.values(CATEGORY).map((id, i) => [id, uuid(9001 + i)]));
  const withCategoryIds = (snapshot: Snapshot): Snapshot => ({
    ...snapshot,
    transactions: snapshot.transactions.map((t) => ({ ...t, budgetCategoryId: t.budgetCategoryId === null ? null : CATEGORY_ID[t.budgetCategoryId] })),
    splits: (snapshot.splits ?? []).map((s) => ({ ...s, budget_category_id: CATEGORY_ID[s.budget_category_id] })),
  });
  const effects = (query: Record<string, unknown>) => call(listTransactionEffects, request(2, query));

  it.each([undefined, 0, 1])('a client at level %s gets 404, and nothing is read', async (level) => {
    // `request(level, …)` directly: an absent header must stay absent.
    const { status, body } = await call(listTransactionEffects, request(level, { ...SEPT, plaid_category: 'FOOD_AND_DRINK' }));
    expect(status).toBe(404);
    expect(body).toEqual({ error: 'Not found' });
    expect(mockSnapshot).not.toHaveBeenCalled();
    expect(frozenReadCount()).toBe(0);
    // Even a request that would be invalid is simply not found: no Phase B detail is exposed.
    expect((await call(listTransactionEffects, request(level, { measure: 'nonsense' }))).status).toBe(404);
  });

  it('a budget bucket: rows in the §7.3 shape, with the complete total and count', async () => {
    serve(withCategoryIds(fixtureSnapshot()));
    const { status, body } = await effects({ ...SEPT, budget_category_id: CATEGORY_ID[CATEGORY.shopping] });
    expect(status).toBe(200);
    expect(Object.keys(body)).toEqual(['status', 'rows', 'total_amount', 'total_count', 'next_cursor']);
    expect(body).toMatchObject({ status: 'ok', total_amount: 0, total_count: 2, next_cursor: null });
    expect(body.rows.map((r: any) => [r.transaction.id, r.effect_role, r.effect_amount, r.allocation])).toEqual([
      [idOf('8b'), 'refund', -60, 'row'],
      [idOf('8a'), 'expense', 60, 'row'],
    ]);
    expect(Object.keys(body.rows[0])).toEqual(['transaction', 'effect_role', 'effect_amount', 'allocation', 'budget_category_id', 'plaid_category']);
    expect(Object.keys(body.rows[0].transaction)).toEqual([
      'id',
      'date',
      'name',
      'merchant_name',
      'account',
      'pending',
      'effective_role',
      'user_role_override',
      'needs_review',
    ]);
  });

  it('`unassigned`, a Plaid category and LOAN_INTEREST are buckets; pages carry the complete total and never split a transaction', async () => {
    expect((await effects({ ...SEPT, budget_category_id: 'unassigned' })).body).toMatchObject({ total_amount: 125, total_count: 2 });
    const interest = await effects({ ...SEPT, plaid_category: 'LOAN_INTEREST' });
    expect(interest.body.rows.map((r: any) => [r.transaction.id, r.effect_amount, r.allocation, r.budget_category_id])).toEqual([[idOf('6'), 50, 'interest', null]]);

    // FOOD_AND_DRINK: three transactions, paged one at a time.
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 3; page++) {
      const { body } = await effects({ ...SEPT, plaid_category: 'FOOD_AND_DRINK', limit: '1', ...(cursor ? { cursor } : {}) });
      expect(body).toMatchObject({ total_amount: 400, total_count: 3 });
      expect(body.rows).toHaveLength(1);
      seen.push(body.rows[0].transaction.id);
      cursor = body.next_cursor ?? undefined;
      expect(body.next_cursor === null).toBe(page === 2);
    }
    expect(seen).toEqual([idOf('10'), idOf('3'), idOf('2')]); // (date desc, id desc)
  });

  it('the result changed between two pages: 409 effects_restart_required, with no rows, total or cursor; restarting from page 1 works', async () => {
    const page1 = (await effects({ ...SEPT, plaid_category: 'FOOD_AND_DRINK', limit: '1' })).body;
    serve(fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '10', { amount: 210 })) }), { fresh: 8 });
    const page2 = await effects({ ...SEPT, plaid_category: 'FOOD_AND_DRINK', limit: '1', cursor: page1.next_cursor });
    expect(page2.status).toBe(409);
    expect(page2.body).toEqual({
      error: 'The result changed since the first page; restart from the first page',
      code: 'effects_restart_required',
      reason: 'snapshot_changed',
    });
    const restarted = await effects({ ...SEPT, plaid_category: 'FOOD_AND_DRINK', limit: '1' });
    expect(restarted.status).toBe(200);
    expect(restarted.body.total_amount).toBe(410);
  });

  it('a cursor reused with another bucket, measure or range is rejected the same way', async () => {
    const page1 = (await effects({ ...SEPT, plaid_category: 'FOOD_AND_DRINK', limit: '1' })).body;
    for (const query of [
      { ...SEPT, plaid_category: 'GENERAL_MERCHANDISE', limit: '1', cursor: page1.next_cursor },
      { ...SEPT, measure: 'income', limit: '1', cursor: page1.next_cursor },
      { start: '2026-09-02', end: '2026-10-01', plaid_category: 'FOOD_AND_DRINK', limit: '1', cursor: page1.next_cursor },
    ]) {
      const { status, body } = await effects(query);
      expect(status).toBe(409);
      expect(body.code).toBe('effects_restart_required');
      expect(body).not.toHaveProperty('rows');
      expect(body).not.toHaveProperty('total_amount');
    }
  });

  it('a cash-flow measure while matching is stale: HTTP 200 `updating` with no rows and no total — not a restart; spending is still served', async () => {
    db.cards = { stale: null };
    const { status, body } = await effects({ ...SEPT, measure: 'credit_card_payments_untracked' });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'updating', retry_after_ms: SEMANTIC_READ_RETRY_AFTER_MS, reason: 'matching_pending' });
    expect((await effects({ ...SEPT, budget_category_id: 'unassigned' })).body.status).toBe('ok');
    expect((await effects({ ...SEPT })).body).toMatchObject({ status: 'ok', total_amount: 525 });
  });

  it('when the snapshot could not be read: HTTP 200 `unavailable` with no rows and no total', async () => {
    mockSnapshot.mockResolvedValue({ kind: 'unavailable', reason: 'timeout' });
    const { status, body } = await effects({ ...SEPT, measure: 'income' });
    expect(status).toBe(200);
    expect(body).toEqual({ status: 'unavailable', retry_after_ms: SEMANTIC_READ_RETRY_AFTER_MS, reason: 'timeout' });
  });

  it('the default limit is 50 and the maximum 200', async () => {
    serve(
      fixtureSnapshot({
        transactions: withUuids(Array.from({ length: 260 }, (_, i) => ({ ...fixtureTransactions()[0], id: uuid(1000 + i), amount: -1, date: '2026-09-02' }))),
        splits: [],
      })
    );
    expect((await effects({ ...SEPT, measure: 'income' })).body.rows).toHaveLength(50);
    const clamped = (await effects({ ...SEPT, measure: 'income', limit: '5000' })).body;
    expect(clamped.rows).toHaveLength(200);
    expect(clamped).toMatchObject({ total_count: 260, total_amount: 260 });
    expect(clamped.next_cursor).not.toBeNull();
  });

  it.each([
    ['no dates', {}],
    ['a malformed date', { start: '2026-9-1', end: '2026-10-01' }],
    ['start not before end', { start: '2026-10-01', end: '2026-10-01' }],
    ['a date that does not exist', { start: '2026-02-30', end: '2026-10-01', plaid_category: 'FOOD_AND_DRINK' }],
    ['a month that does not exist', { start: '2026-09-01', end: '2026-13-01', plaid_category: 'FOOD_AND_DRINK' }],
    ['an unknown measure', { ...SEPT, measure: 'net_worth' }],
    ['a repeated measure (must not fall through to the default)', { ...SEPT, measure: ['income', 'spending'], plaid_category: 'FOOD_AND_DRINK' }],
    ['a repeated measure naming the default twice', { ...SEPT, measure: ['spending', 'spending'], plaid_category: 'FOOD_AND_DRINK' }],
    ['a structured measure', { ...SEPT, measure: { a: 'spending' }, plaid_category: 'FOOD_AND_DRINK' }],
    ['both buckets', { ...SEPT, budget_category_id: 'unassigned', plaid_category: 'FOOD_AND_DRINK' }],
    ['a bucket on a non-spending measure', { ...SEPT, measure: 'income', plaid_category: 'INCOME' }],
    ['a budget_category_id that is not an id', { ...SEPT, budget_category_id: "x' or 1=1" }],
    ['an empty plaid_category', { ...SEPT, plaid_category: '' }],
    ['a repeated bucket parameter', { ...SEPT, plaid_category: ['A', 'B'] }],
    ['a zero limit', { ...SEPT, plaid_category: 'FOOD_AND_DRINK', limit: '0' }],
    ['a non-numeric limit', { ...SEPT, plaid_category: 'FOOD_AND_DRINK', limit: '10abc' }],
  ])('400 invalid_effect_query for %s, before anything is read', async (_name, query) => {
    const { status, body } = await effects(query);
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_effect_query');
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('400 invalid_cursor for a malformed cursor, an old-format cursor, a repeated cursor and a cursor with an impossible date', async () => {
    const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
    const fingerprint = 'A'.repeat(43);
    for (const cursor of [
      'not-a-cursor',
      encode(`2026-09-22|${idOf('10')}`),
      encode(`2|${fingerprint}|2026-02-30|${idOf('10')}`),
      encode(`2|${fingerprint}|2026-13-01|${idOf('10')}`),
      ['a', 'b'],
    ]) {
      const { status, body } = await effects({ ...SEPT, plaid_category: 'FOOD_AND_DRINK', cursor });
      expect(status).toBe(400);
      expect(body.code).toBe('invalid_cursor');
    }
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('a budget drill-down over mismatched splits is refused with 409 split_allocation_mismatch', async () => {
    const state = fixtureSnapshot();
    state.splits![0] = { ...state.splits![0], amount: 149.99 };
    serve(withCategoryIds(state));
    const { status, body } = await effects({ ...SEPT, budget_category_id: CATEGORY_ID[CATEGORY.groceries] });
    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'split_allocation_mismatch', transaction_id: idOf('10') });
    expect(body.error).not.toMatch(/199\.99|149\.99/);
  });
});

describe('every published amount has a drill-down that reconciles to it (review finding F5)', () => {
  const SEPT = { start: '2026-09-01', end: '2026-10-01' };

  // The PUBLISHED WIRE FIELDS, classified here — independently of the implementation's measure list.
  // A field is either an amount explained by a measure, or explicitly exempt for a stated reason.
  const CASH_FLOW_FIELD: Record<string, { measure: string } | { exempt: 'rate' | 'range' | 'count' | 'derived' | 'container' }> = {
    spending: { measure: 'spending' },
    income_semantic: { measure: 'income' },
    debt_payments: { measure: 'debt_payments' },
    known_principal: { measure: 'known_principal' },
    debt_payments_unknown_principal: { measure: 'debt_payments_unknown_principal' },
    transfers_internal: { measure: 'transfers_internal' },
    transfers_external: { measure: 'transfers_external' },
    credit_card_payments_tracked: { measure: 'credit_card_payments_tracked' },
    credit_card_payments_untracked: { measure: 'credit_card_payments_untracked' },
    credit_card_payments_returned_tracked: { measure: 'credit_card_payments_returned_tracked' },
    credit_card_payments_returned_untracked: { measure: 'credit_card_payments_returned_untracked' },
    credit_card_payments_externally_funded: { measure: 'credit_card_payments_externally_funded' },
    credit_card_payments_reversed_externally: { measure: 'credit_card_payments_reversed_externally' },
    card_payments_unresolved_credit: { measure: 'card_payments_unresolved_credit' },
    refunds: { measure: 'refunds' },
    unclassified_amount: { measure: 'unclassified' },
    // cash_flow = income − spending − debt_payments − untracked + returned_untracked + transfers_external.
    cash_flow: { exempt: 'derived' },
    cash_flow_range: { exempt: 'range' },
    savings_rate: { exempt: 'rate' },
    savings_rate_range: { exempt: 'range' },
    unclassified_count: { exempt: 'count' },
    card_payments_unresolved: { exempt: 'container' }, // its members are classified below
  };
  const UNRESOLVED_FIELD: Record<string, { measure: string } | { exempt: 'count' }> = {
    count: { exempt: 'count' },
    payments_amount: { measure: 'card_payments_unresolved_payments' },
    returns_amount: { measure: 'card_payments_unresolved_returns' },
    by_reason: { exempt: 'count' },
  };
  const EXCLUDED_FIELD: Record<string, { measure: string } | { exempt: 'container' }> = {
    transfers_internal: { measure: 'transfers_internal' },
    transfers_external: { measure: 'transfers_external' },
    credit_card_payments_tracked: { measure: 'credit_card_payments_tracked' },
    credit_card_payments_untracked: { measure: 'credit_card_payments_untracked' },
    credit_card_payments_returned_untracked: { measure: 'credit_card_payments_returned_untracked' },
    debt_payments: { measure: 'debt_payments' },
    card_payments_unresolved: { exempt: 'container' },
  };

  // Every card-payment total is non-zero in this state: a tracked pair, an untracked payment and return
  // (no included card → established), fee pairs, an excluded-account payment, and unresolved legs.
  const busy = (): Snapshot =>
    fixtureSnapshot({
      transactions: withUuids([
        ...withRow(fixtureTransactions(), '9', { effectiveRole: 'internal_transfer', userRoleOverride: 'internal_transfer' }),
        { ...fixtureTransactions()[5], id: uuid(201), amount: 250, date: '2026-09-14' }, // cash payment, card leg 8 days later: unresolved
        { ...fixtureTransactions()[6], id: uuid(202), amount: -250, date: '2026-09-22' },
        { ...fixtureTransactions()[5], id: uuid(203), amount: -40, date: '2026-09-27' }, // an unresolved return into checking
        { ...fixtureTransactions()[6], id: uuid(204), amount: 15, date: '2026-09-29' }, // an unmatched reversal on the card
        { ...fixtureTransactions()[1], id: uuid(205), amount: 12, date: '2026-09-03', effectiveRole: null }, // unclassified
      ]),
    });

  it('the classification covers exactly the fields the wire mappers publish — a new amount field cannot be added without a drill-down or a stated exemption', () => {
    const state = busy();
    const totals = aggregateCashFlow(cashFlowInput({ accounts: state.accounts, transactions: state.transactions, period: SEPTEMBER }));
    const fields = cashFlowFields(totals);
    expect(Object.keys(fields).sort()).toEqual(Object.keys(CASH_FLOW_FIELD).sort());
    expect(Object.keys(fields.card_payments_unresolved).sort()).toEqual(Object.keys(UNRESOLVED_FIELD).sort());
    const month = aggregateMonthlyBreakdown(cashFlowInput({ accounts: state.accounts, transactions: state.transactions, period: SEPTEMBER }))[0];
    const semantic = monthlyBreakdownSemanticFields(month);
    expect(Object.keys(semantic).sort()).toEqual(['by_category', 'excluded', 'income', 'spending']);
    expect(Object.keys(semantic.excluded).sort()).toEqual(Object.keys(EXCLUDED_FIELD).sort());
    expect(Object.keys(semantic.excluded.card_payments_unresolved).sort()).toEqual(Object.keys(UNRESOLVED_FIELD).sort());
    // Every measure a field names is one the endpoint serves.
    for (const entry of [...Object.values(CASH_FLOW_FIELD), ...Object.values(UNRESOLVED_FIELD), ...Object.values(EXCLUDED_FIELD)]) {
      if ('measure' in entry) expect(EFFECT_MEASURES as readonly string[]).toContain(entry.measure);
    }
    // Only numbers that are not amounts, or that follow from amounts already drillable, are exempt.
    for (const [field, entry] of Object.entries(CASH_FLOW_FIELD)) {
      if ('exempt' in entry && entry.exempt !== 'container') expect(typeof (fields as Record<string, unknown>)[field] === 'number' ? ['rate', 'count', 'derived'] : ['range', 'rate', 'derived']).toContain(entry.exempt);
    }
  });

  it('summary: every published amount of the current month equals its drill-down total, and the rows sum to it', async () => {
    serve(busy());
    const month = (await call(getSpendingSummary, request(2))).body.current_month;
    const check = async (field: string, published: number, measure: string) => {
      const { status, body } = await call(listTransactionEffects, request(2, { ...SEPT, measure, limit: '200' }));
      expect(status, field).toBe(200);
      expect(body.status, field).toBe('ok');
      expect(body.total_amount, field).toBe(published);
      expect(round(body.rows.reduce((sum: number, r: any) => sum + r.effect_amount, 0)), field).toBe(published);
    };
    let nonZero = 0;
    for (const [field, entry] of Object.entries(CASH_FLOW_FIELD)) {
      if (!('measure' in entry)) continue;
      await check(field, month[field], entry.measure);
      if (month[field] !== 0) nonZero++;
    }
    for (const [field, entry] of Object.entries(UNRESOLVED_FIELD)) {
      if (!('measure' in entry)) continue;
      await check(`card_payments_unresolved.${field}`, month.card_payments_unresolved[field], entry.measure);
      if (month.card_payments_unresolved[field] !== 0) nonZero++;
    }
    // The state exercises most totals for real, not as 0 = 0.
    expect(nonZero).toBeGreaterThanOrEqual(12);
    expect(month).toMatchObject({ debt_payments_unknown_principal: 300, card_payments_unresolved_credit: 235, unclassified_amount: 12 });
    // The derived figure follows from the drillable ones (here as a range: two cash legs are unresolved).
    const established = round(
      month.income_semantic - month.spending - month.debt_payments - month.credit_card_payments_untracked + month.credit_card_payments_returned_untracked + month.transfers_external
    );
    expect(month.cash_flow_range).toEqual({
      low: round(established - month.card_payments_unresolved.payments_amount),
      high: round(established + month.card_payments_unresolved.returns_amount),
    });
  });

  it('monthly breakdown and budget: spending, income, every category and every excluded line reconcile for the month', async () => {
    serve(busy());
    const sept = (await call(getMonthlyBreakdown, request(2))).body.months.find((m: any) => m.month === '2026-09').semantic;
    const total = async (query: Record<string, unknown>) => (await call(listTransactionEffects, request(2, { ...SEPT, limit: '200', ...query }))).body.total_amount;
    expect(await total({ measure: 'spending' })).toBe(sept.spending);
    expect(await total({ measure: 'income' })).toBe(sept.income);
    for (const { category, amount } of sept.by_category) expect(await total({ plaid_category: category }), category).toBe(amount);
    expect(round(sept.by_category.reduce((sum: number, c: any) => sum + c.amount, 0))).toBe(sept.spending);
    for (const [field, entry] of Object.entries(EXCLUDED_FIELD)) {
      if ('measure' in entry) expect(await total({ measure: entry.measure }), field).toBe(sept.excluded[field]);
    }
    expect(await total({ measure: 'card_payments_unresolved_payments' })).toBe(sept.excluded.card_payments_unresolved.payments_amount);
    expect(await total({ measure: 'card_payments_unresolved_returns' })).toBe(sept.excluded.card_payments_unresolved.returns_amount);
  });
});

describe('semanticErrorResponse — explicit, sanitized failures', () => {
  it('an integrity failure relays only a fixed message, the code and the user\'s own transaction id', () => {
    const err = new SemanticAggregationIntegrityError('txn-9', 'principal_portion 450.00 exceeds the amount 400.00');
    const response = semanticErrorResponse(err)!;
    expect(response).toEqual({
      status: 500,
      body: { error: 'One transaction has inconsistent data, so these figures are paused.', code: 'semantic_integrity_error', transaction_id: 'txn-9' },
    });
    expect(JSON.stringify(response)).not.toMatch(/450|400\.00|principal/);
  });

  it('maps each failure of the read path, and nothing else', () => {
    expect(semanticErrorResponse(new SemanticIntegrityError('bad'))).toMatchObject({ status: 500, body: { code: 'semantic_integrity_error' } });
    expect(semanticErrorResponse(new SemanticIntegrityError('bad'))!.body).not.toHaveProperty('transaction_id');
    expect(semanticErrorResponse(new CardPaymentStateIntegrityError('t', 'missing'))).toMatchObject({
      status: 500,
      body: { code: 'card_payment_state_integrity', transaction_id: 't' },
    });
    expect(semanticErrorResponse(new AggregateTooLargeError('rows', 'exceeded 200 pages of 1000 rows'))).toMatchObject({ status: 500, body: { code: 'aggregate_too_large' } });
    const unavailable = semanticErrorResponse(new AggregateSnapshotUnavailableError('transaction history', 'objects_missing'))!;
    expect(unavailable).toEqual({
      status: 500,
      body: { error: 'This range could not be read as one consistent set; nothing partial was returned.', code: 'aggregate_snapshot_unavailable' },
    });
    const split = semanticErrorResponse(new SplitAllocationMismatchError([{ transactionId: 't', parentAmount: 10, splitTotal: Number.NaN }]))!;
    expect(split.status).toBe(409);
    expect(split.body).toMatchObject({ code: 'split_allocation_mismatch', transaction_id: 't', mismatches: [{ transaction_id: 't', parent_amount: 10, split_total: null }] });
    expect(semanticErrorResponse(new Error('anything else'))).toBeNull();
    expect(semanticErrorResponse(new KeysetOrderError('order'))).toBeNull();
    expect(semanticErrorResponse(undefined)).toBeNull();
  });

  it('a frozen (level-1) read that cannot be made coherent fails closed through the same handler', async () => {
    mockData.getTransactionsSince.mockRejectedValue(new AggregateSnapshotUnavailableError('transaction history', 'objects_missing'));
    const { status, body } = await call(getSpendingSummary, request(1));
    expect(status).toBe(500);
    expect(body.code).toBe('aggregate_snapshot_unavailable');
    expect(body).not.toHaveProperty('monthly_spending');
  });
});
