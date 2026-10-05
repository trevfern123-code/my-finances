import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSnapshot = vi.hoisted(() => vi.fn());
vi.mock('./financialSnapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./financialSnapshot')>()),
  readFinancialSnapshot: mockSnapshot,
}));
const mockPoll = vi.hoisted(() => vi.fn());
vi.mock('./cardPaymentStateReader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cardPaymentStateReader')>()),
  readCardPaymentStates: mockPoll,
}));

import type { FinancialSnapshotRequest } from './financialSnapshot';
import { AggregateTooLargeError } from './fetchAllPages';
import {
  decodeEffectCursor,
  EFFECT_MEASURES,
  EffectsRestartRequiredError,
  encodeEffectCursor,
  InvalidEffectQueryError,
  isCalendarDate,
  readBudget,
  readEffectRows,
  readMonthlyBreakdown,
  readSummary,
  SEMANTIC_READ_BACKOFF_MS,
  SEMANTIC_READ_MAX_SNAPSHOTS,
  SEMANTIC_READ_RETRY_AFTER_MS,
  type EffectPage,
  type EffectQuery,
  type EffectRowView,
} from './semanticReadPath';
import {
  aggregateCashFlow,
  CardPaymentStateIntegrityError,
  PAIRING_PAD_DAYS,
  SemanticAggregationIntegrityError,
  SplitAllocationMismatchError,
  type AggregationTransaction,
  type CashFlowTotals,
} from './semanticAggregation';
import { SemanticIntegrityError } from './semanticEffects';
import { categorySpendRowsOf } from './dataService';
import { ACCOUNT, AUGUST, CATEGORY, LOAN_M, SEPTEMBER, fixtureAccounts, fixtureTransactions, withRow } from '../testUtils/phaseBFixture';
import { cashFlowInput, pairDecision } from '../testUtils/cardStatesFromOracle';
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

// Financial Semantics Phase B, slice I1: the backend read path.
//
// `readFinancialSnapshot` is replaced by an in-memory "database" (`db`). Each call answers from the
// database state at that moment — exactly as one SQL statement sees one committed state — and a test
// changes `db.state` between calls to model commits. So every test says precisely which committed
// state each request observed, and how many requests there were.

const USER = 'user-1';

const db: { state: Snapshot; cards: CardState; afterSnapshot: (() => void) | null } = {
  state: fixtureSnapshot(),
  cards: { fresh: 7 },
  afterSnapshot: null,
};
const snapshotRequests = (): FinancialSnapshotRequest[] => mockSnapshot.mock.calls.map((call) => call[1] as FinancialSnapshotRequest);

function serve(state: Snapshot, cards: CardState = { fresh: 7 }): void {
  db.state = state;
  db.cards = cards;
}

const sleeps: number[] = [];
const options = {
  sleep: async (ms: number) => {
    sleeps.push(ms);
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  sleeps.length = 0;
  db.afterSnapshot = null;
  serve(fixtureSnapshot());
  mockSnapshot.mockImplementation(async (_user: string, request: FinancialSnapshotRequest) => {
    // The answer is built from the state at the moment of the call; a commit scheduled "right after
    // the statement" changes the database only once the answer exists.
    const answer = serveSnapshot(db.state, request, db.cards);
    const after = db.afterSnapshot;
    db.afterSnapshot = null;
    after?.();
    return answer;
  });
  mockPoll.mockImplementation(async () => ('fresh' in db.cards ? freshStates(db.state, db.cards.fresh) : staleStates(db.cards.stale)));
});

const SUMMARY_ARGS = { range: { start: AUGUST.start }, currentMonth: SEPTEMBER };
const expectedTotals = (state: Snapshot, period = SEPTEMBER): CashFlowTotals =>
  aggregateCashFlow(cashFlowInput({ accounts: state.accounts, transactions: state.transactions, period, decisions: state.decisions }));

describe('one snapshot per read — the figures of one committed state', () => {
  it('the §9.1 fixture: September cash flow 1 827.10 and the monthly view, from exactly ONE request', async () => {
    const result = await readSummary(USER, SUMMARY_ARGS, options);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.currentMonth).toEqual(expectedTotals(fixtureSnapshot()));
    expect(result.value.currentMonth).toMatchObject({ cashFlow: 1827.1, spending: 525, income: 3002.1, debtPayments: 650, knownPrincipal: 350 });
    expect(Math.round(result.value.currentMonth.savingsRate! * 1000) / 10).toBe(72.5);
    expect(result.value.monthly.map((m) => [m.month, m.cashFlow, m.unclassifiedCount])).toEqual([
      ['2026-08', -45, 1],
      ['2026-09', 1827.1, 0],
    ]);
    // No pages, no second statement, no version bracket, no poll, no wait.
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(mockPoll).not.toHaveBeenCalled();
    expect(sleeps).toEqual([]);
  });

  it('the request: rows for the covered range padded for transfer context; card states for the covered range; no splits', async () => {
    await readSummary(USER, { range: { start: '2026-08-01', end: '2026-09-01' }, currentMonth: SEPTEMBER }, options);
    expect(PAIRING_PAD_DAYS).toBe(6);
    expect(mockSnapshot).toHaveBeenLastCalledWith(USER, {
      rows: { start: '2026-07-26', end: '2026-10-07' },
      cardStates: { from: '2026-08-01', to: '2026-10-01' },
    });
    // An open-ended reporting range stays open-ended on both.
    await readSummary(USER, SUMMARY_ARGS, options);
    expect(mockSnapshot).toHaveBeenLastCalledWith(USER, { rows: { start: '2026-07-26' }, cardStates: { from: '2026-08-01', to: undefined } });
  });

  it('the frozen inputs come from the same rows as the role-aware figures, and are exactly what the frozen read returns', async () => {
    const state = fixtureSnapshot();
    const result = await readSummary(USER, { range: { start: '2026-08-01', end: '2026-09-01' }, currentMonth: SEPTEMBER }, options);
    if (result.status !== 'ok') throw new Error('expected ok');
    const frozenOf = (range: { start: string; end: string }) => includedTransactions(state, range).map((t) => ({ amount: t.amount, date: t.date }));
    expect(result.frozen.range).toEqual(frozenOf({ start: '2026-08-01', end: '2026-09-01' }));
    expect(result.frozen.currentMonth).toEqual(frozenOf(SEPTEMBER));
    // The padding rows fetched for transfer pairing are never part of a frozen figure.
    expect(result.frozen.range.every((row) => row.date >= '2026-08-01' && row.date < '2026-09-01')).toBe(true);
    // The excluded account's $999 is in neither.
    expect(result.frozen.currentMonth.some((row) => row.amount === 999)).toBe(false);
  });

  it('an unresolved card payment is a range with no single figure; a stored decision resolves it', async () => {
    const state = fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '5b', { date: '2026-09-17' })) });
    serve(state);
    const result = await readSummary(USER, SUMMARY_ARGS, options);
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.value.currentMonth).toMatchObject({
      cashFlow: null,
      savingsRate: null,
      cashFlowRange: { low: 927.1, high: 1827.1 },
      creditCardPaymentsUntracked: 0,
      cardPaymentsUnresolvedCredit: 900,
    });
    expect(result.value.currentMonth.cardPaymentsUnresolved).toMatchObject({ count: 1, paymentsAmount: 900 });

    const pay = state.transactions.find((t) => t.id === idOf('5a'))!;
    const card = state.transactions.find((t) => t.id === idOf('5b'))!;
    serve({ ...state, decisions: [pairDecision('d', pay, card)] }, { fresh: 8 });
    const confirmed = await readSummary(USER, SUMMARY_ARGS, options);
    expect(confirmed.status === 'ok' && confirmed.value.currentMonth.cashFlow).toBe(1827.1);
  });
});

describe('interference cannot produce a mixed result (review findings F1 and F2)', () => {
  it('F1 — a pending row replaced by its posted row around the read is counted once: the result is the before-state or the after-state, never both rows', async () => {
    const pending: AggregationTransaction = { ...fixtureTransactions()[1], id: uuid(70), amount: 100, date: '2026-09-21' };
    const posted: AggregationTransaction = { ...pending, id: uuid(71), date: '2026-09-23' };
    const before = fixtureSnapshot({ transactions: [...withUuids(fixtureTransactions()), pending] });
    const after = fixtureSnapshot({ transactions: [...withUuids(fixtureTransactions()), posted] });
    serve(before);
    // The sync's replacement commits immediately after the statement was answered.
    db.afterSnapshot = () => serve(after, { fresh: 8 });

    const first = await readSummary(USER, SUMMARY_ARGS, options);
    if (first.status !== 'ok') throw new Error('expected ok');
    expect(first.value.currentMonth.spending).toBe(625); // 525 + the pending $100, once
    expect(first.value.currentMonth).toEqual(expectedTotals(before));
    expect(mockSnapshot).toHaveBeenCalledTimes(1); // nothing was read after the commit, so nothing could mix

    const second = await readSummary(USER, SUMMARY_ARGS, options);
    if (second.status !== 'ok') throw new Error('expected ok');
    expect(second.value.currentMonth.spending).toBe(625); // the posted $100, once — never 725
    expect(second.value.currentMonth).toEqual(expectedTotals(after));
    // The frozen inputs of each response hold the row once too.
    expect(first.frozen.currentMonth.filter((row) => row.amount === 100)).toHaveLength(1);
    expect(second.frozen.currentMonth.filter((row) => row.amount === 100)).toHaveLength(1);
  });

  it('F1 — the budget and both spending drill-downs see the replacement the same way', async () => {
    const pending: AggregationTransaction = { ...fixtureTransactions()[1], id: uuid(70), amount: 100, date: '2026-09-21' };
    const posted: AggregationTransaction = { ...pending, id: uuid(71), date: '2026-09-23' };
    const before = fixtureSnapshot({ transactions: [...withUuids(fixtureTransactions()), pending] });
    const after = fixtureSnapshot({ transactions: [...withUuids(fixtureTransactions()), posted] });

    for (const read of [
      async () => {
        const r = await readBudget(USER, { current: SEPTEMBER });
        return r.status === 'ok' ? r.value.current.byCategory.get(CATEGORY.groceries) : null;
      },
      async () => {
        const r = await readEffectRows(USER, { ...SEPTEMBER, measure: 'spending', bucket: { kind: 'budget_category', id: CATEGORY.groceries }, limit: 50 });
        return r.status === 'ok' ? r.value.total_amount : null;
      },
      async () => {
        const r = await readEffectRows(USER, { ...SEPTEMBER, measure: 'spending', bucket: { kind: 'plaid_category', category: 'FOOD_AND_DRINK' }, limit: 50 });
        return r.status === 'ok' ? r.value.total_amount - 130 : null; // FOOD_AND_DRINK = Groceries 370 + Dining 80 + Household 50
      },
    ]) {
      mockSnapshot.mockClear();
      serve(before);
      db.afterSnapshot = () => serve(after);
      expect(await read()).toBe(370); // 270 + 100, once
      expect(mockSnapshot).toHaveBeenCalledTimes(1);
      expect(await read()).toBe(370); // still once after the replacement
    }
  });

  it('F2 — principal-only edits (which the matching version does not watch) never yield figures of a state that did not exist', async () => {
    // Two $400 linked payments. Committed states: principal (350, 350) → (250, 350) → (250, 300).
    const linked = (id: number, principal: number): AggregationTransaction => ({
      ...fixtureTransactions()[7],
      id: uuid(id),
      date: '2026-09-12',
      manualLoanId: LOAN_M,
      principalPortion: principal,
    });
    const others = withUuids(fixtureTransactions().filter((r) => r.id !== '6'));
    const stateOf = (a: number, b: number) => fixtureSnapshot({ transactions: [...others, linked(80, a), linked(81, b)] });
    const states = [stateOf(350, 350), stateOf(250, 350), stateOf(250, 300)];
    // The card states are untouched throughout: the matching version never moves (it stays 7).
    const committed = states.map((state) => expectedTotals(state)).map((t) => [t.knownPrincipal, t.spending]);
    expect(committed).toEqual([
      [700, 575],
      [600, 675],
      [550, 725],
    ]);

    serve(states[0]);
    db.afterSnapshot = () => {
      serve(states[1]);
    };
    const seen: number[][] = [];
    for (let i = 0; i < 3; i++) {
      const result = await readSummary(USER, SUMMARY_ARGS, options);
      if (result.status !== 'ok') throw new Error('expected ok');
      seen.push([result.value.currentMonth.knownPrincipal, result.value.currentMonth.spending]);
      if (i === 1) serve(states[2]);
    }
    // Every response is exactly one committed state — in particular never the mixed (650, 150)-style pair.
    for (const figures of seen) expect(committed).toContainEqual(figures);
    expect(seen).toEqual(committed);
  });

  it('F2 — a split re-allocation around a budget read gives one allocation or the other, never a mixture', async () => {
    const before = fixtureSnapshot();
    const after = fixtureSnapshot();
    after.splits = [
      { id: 'split-n1', transaction_id: idOf('10'), budget_category_id: CATEGORY.dining, amount: 120, note: null },
      { id: 'split-n2', transaction_id: idOf('10'), budget_category_id: CATEGORY.shopping, amount: 80, note: null },
    ];
    serve(before);
    db.afterSnapshot = () => serve(after);
    const first = await readBudget(USER, { current: SEPTEMBER });
    const second = await readBudget(USER, { current: SEPTEMBER });
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('expected ok');
    expect(Object.fromEntries(first.value.current.byCategory)).toEqual({
      [CATEGORY.groceries]: 270,
      [CATEGORY.dining]: 80,
      [CATEGORY.shopping]: 0,
      [CATEGORY.household]: 50,
    });
    expect(Object.fromEntries(second.value.current.byCategory)).toEqual({
      [CATEGORY.groceries]: 120,
      [CATEGORY.dining]: 200,
      [CATEGORY.shopping]: 80,
    });
    // Each response allocates the whole $200 exactly once.
    for (const r of [first, second]) expect(r.value.current.total).toBe(525);
  });
});

describe('stale matching state withholds every role-aware figure, and keeps the frozen inputs', () => {
  it('matching_pending: one snapshot, two short polls of the versions, no further snapshot, no role-aware figure', async () => {
    serve(fixtureSnapshot(), { stale: null });
    const result = await readSummary(USER, SUMMARY_ARGS, options);
    expect(Object.keys(result).sort()).toEqual(['frozen', 'reason', 'retryAfterMs', 'status']);
    expect(result).toMatchObject({ status: 'updating', retryAfterMs: SEMANTIC_READ_RETRY_AFTER_MS, reason: 'matching_pending' });
    // The only data it carries is the frozen inputs: rows of { amount, date }, nothing role-aware.
    if (result.status !== 'updating') throw new Error('expected updating');
    expect(Object.keys(result.frozen).sort()).toEqual(['currentMonth', 'range']);
    for (const row of [...result.frozen.range, ...result.frozen.currentMonth]) expect(Object.keys(row).sort()).toEqual(['amount', 'date']);
    // The frozen inputs are still the snapshot's rows.
    expect(result.status === 'updating' && result.frozen.currentMonth).toEqual(
      includedTransactions(fixtureSnapshot(), SEPTEMBER).map((t) => ({ amount: t.amount, date: t.date }))
    );
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(mockPoll).toHaveBeenCalledTimes(SEMANTIC_READ_BACKOFF_MS.length);
    expect(sleeps).toEqual([...SEMANTIC_READ_BACKOFF_MS]);
    // The poll asks for versions only: an empty date range.
    expect(mockPoll).toHaveBeenCalledWith(USER, { from: '2026-08-01', to: '2026-08-01' });
  });

  it('a user with no version row at all (never evaluated) is matching_pending', async () => {
    serve(fixtureSnapshot(), { stale: null, inputVersion: null });
    expect(await readSummary(USER, SUMMARY_ARGS, options)).toMatchObject({ status: 'updating', reason: 'matching_pending' });
  });

  it('matching_failed: the database records a failed evaluation', async () => {
    serve(fixtureSnapshot(), { stale: '22012' });
    expect(await readSummary(USER, SUMMARY_ARGS, options)).toMatchObject({ status: 'updating', reason: 'matching_failed' });
  });

  it('stale states are never worked around: no in-module pairing, no sign-based figure passed off as role-aware', async () => {
    // 5a/5b would pair trivially from the rows alone.
    serve(fixtureSnapshot(), { stale: null });
    const result = await readSummary(USER, SUMMARY_ARGS, options);
    expect(result.status).toBe('updating');
    expect(result).not.toHaveProperty('value');
  });

  it('an evaluation that finishes during the wait: a poll reports fresh, ONE more snapshot is taken, and its own content decides', async () => {
    serve(fixtureSnapshot(), { stale: null });
    mockPoll.mockImplementationOnce(async () => {
      db.cards = { fresh: 8 }; // the evaluation commits
      return freshStates(db.state, 8);
    });
    const result = await readSummary(USER, SUMMARY_ARGS, options);
    expect(result.status === 'ok' && result.value.currentMonth.cashFlow).toBe(1827.1);
    expect(mockSnapshot).toHaveBeenCalledTimes(2);
    expect(mockPoll).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([SEMANTIC_READ_BACKOFF_MS[0]]);
  });

  it('bounded: if the second snapshot is stale again (another input changed), the answer is updating — never a third snapshot', async () => {
    serve(fixtureSnapshot(), { stale: null });
    mockPoll.mockImplementation(async () => freshStates(db.state, 8)); // the poll saw fresh, but the snapshot after it is stale again
    const result = await readSummary(USER, SUMMARY_ARGS, options);
    expect(result.status).toBe('updating');
    expect(mockSnapshot).toHaveBeenCalledTimes(SEMANTIC_READ_MAX_SNAPSHOTS);
    expect(SEMANTIC_READ_MAX_SNAPSHOTS).toBe(2);
  });

  it('a poll that gets no usable answer ends the wait; the snapshot already read still withholds the figures', async () => {
    serve(fixtureSnapshot(), { stale: null });
    mockPoll.mockResolvedValue({ kind: 'unavailable', reason: 'timeout' });
    const result = await readSummary(USER, SUMMARY_ARGS, options);
    expect(result).toMatchObject({ status: 'updating', reason: 'matching_pending' });
    expect(mockPoll).toHaveBeenCalledTimes(1);
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
  });

  it('the Monthly Breakdown and a cash-flow drill-down are withheld the same way; a drill-down gets no rows and no total', async () => {
    serve(fixtureSnapshot(), { stale: null });
    const breakdown = await readMonthlyBreakdown(USER, { start: AUGUST.start }, options);
    expect(breakdown).toMatchObject({ status: 'updating', reason: 'matching_pending' });
    expect(breakdown).not.toHaveProperty('value');
    const effects = await readEffectRows(USER, { ...SEPTEMBER, measure: 'income', limit: 50 }, options);
    expect(effects).toEqual({ status: 'updating', retryAfterMs: SEMANTIC_READ_RETRY_AFTER_MS, reason: 'matching_pending' });
  });
});

describe('unavailable is kept apart from updating', () => {
  it.each(['objects_missing', 'request_error', 'timeout', 'request_failed', 'unexpected_response'] as const)(
    'a snapshot that got no usable answer (%s): nothing at all is returned — no frozen inputs, no figures, no poll, no retry',
    async (reason) => {
      mockSnapshot.mockResolvedValue({ kind: 'unavailable', reason });
      const expected = { status: 'unavailable', retryAfterMs: SEMANTIC_READ_RETRY_AFTER_MS, reason };
      expect(await readSummary(USER, SUMMARY_ARGS, options)).toEqual(expected);
      expect(await readMonthlyBreakdown(USER, { start: AUGUST.start }, options)).toEqual(expected);
      expect(await readBudget(USER, { current: SEPTEMBER })).toEqual(expected);
      expect(await readEffectRows(USER, { ...SEPTEMBER, measure: 'income', limit: 50 }, options)).toEqual(expected);
      expect(await readEffectRows(USER, { ...SEPTEMBER, measure: 'spending', limit: 50 }, options)).toEqual(expected);
      expect(mockSnapshot).toHaveBeenCalledTimes(5);
      expect(mockPoll).not.toHaveBeenCalled();
      expect(sleeps).toEqual([]);
    }
  );

  it('a second snapshot that got no usable answer (after a poll reported fresh) is unavailable, not a stale result', async () => {
    serve(fixtureSnapshot(), { stale: null });
    mockPoll.mockImplementationOnce(async () => freshStates(db.state, 8));
    mockSnapshot.mockImplementationOnce(async (_u: string, request: FinancialSnapshotRequest) => serveSnapshot(db.state, request, db.cards));
    mockSnapshot.mockImplementationOnce(async () => ({ kind: 'unavailable', reason: 'timeout' }));
    expect(await readSummary(USER, SUMMARY_ARGS, options)).toEqual({ status: 'unavailable', retryAfterMs: SEMANTIC_READ_RETRY_AFTER_MS, reason: 'timeout' });
  });
});

describe('later-read observation — not autonomous recovery', () => {
  it('updating now; figures on a later read once SOMETHING ELSE has made the stored states fresh; nothing is cached', async () => {
    serve(fixtureSnapshot(), { stale: null });
    expect((await readSummary(USER, SUMMARY_ARGS, options)).status).toBe('updating');
    // An existing evaluator ran (not this module: it only ever calls the two read functions).
    db.cards = { fresh: 9 };
    const later = await readSummary(USER, SUMMARY_ARGS, options);
    expect(later.status === 'ok' && later.value.currentMonth.cashFlow).toBe(1827.1);
  });

  it('while nothing evaluates, every later read stays updating: the read path does not make a stale user fresh', async () => {
    serve(fixtureSnapshot(), { stale: null });
    for (let i = 0; i < 3; i++) expect((await readSummary(USER, SUMMARY_ARGS, options)).status).toBe('updating');
  });

  it('a failed evaluation that later succeeds, an unavailable read that later answers, and a corrected bad row are all observed', async () => {
    serve(fixtureSnapshot(), { stale: 'XX000' });
    expect(await readSummary(USER, SUMMARY_ARGS, options)).toMatchObject({ status: 'updating', reason: 'matching_failed' });
    mockSnapshot.mockResolvedValueOnce({ kind: 'unavailable', reason: 'request_failed' });
    expect((await readSummary(USER, SUMMARY_ARGS, options)).status).toBe('unavailable');
    serve(fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '6', { principalPortion: 450 })) }));
    await expect(readSummary(USER, SUMMARY_ARGS, options)).rejects.toBeInstanceOf(SemanticIntegrityError);
    serve(fixtureSnapshot(), { fresh: 10 }); // the user fixed the principal
    const fixed = await readSummary(USER, SUMMARY_ARGS, options);
    expect(fixed.status === 'ok' && fixed.value.currentMonth.knownPrincipal).toBe(350);
  });
});

describe('integrity failures are thrown, never turned into a status or a plausible figure', () => {
  it('R9: an impossible loan principal fails every read and names the row', async () => {
    serve(fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '6', { principalPortion: 450 })) }));
    for (const read of [
      () => readSummary(USER, SUMMARY_ARGS, options),
      () => readMonthlyBreakdown(USER, { start: AUGUST.start }, options),
      () => readBudget(USER, { current: SEPTEMBER }),
      () => readEffectRows(USER, { ...SEPTEMBER, measure: 'debt_payments', limit: 50 }, options),
      () => readEffectRows(USER, { ...SEPTEMBER, measure: 'spending', limit: 50 }, options),
      () => readEffectRows(USER, { ...SEPTEMBER, measure: 'spending', bucket: { kind: 'budget_category', id: null }, limit: 50 }, options),
      () => readEffectRows(USER, { ...SEPTEMBER, measure: 'spending', bucket: { kind: 'plaid_category', category: 'FOOD_AND_DRINK' }, limit: 50 }, options),
    ]) {
      const error = await read().then(
        () => null,
        (err: unknown) => err
      );
      expect(error).toBeInstanceOf(SemanticAggregationIntegrityError);
      expect((error as SemanticAggregationIntegrityError).transactionId).toBe(idOf('6'));
    }
  });

  it('a NULL role is merely unclassified (R0): counted and reported, not a failure', async () => {
    serve(fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '2', { effectiveRole: null })) }));
    const result = await readSummary(USER, SUMMARY_ARGS, options);
    expect(result.status === 'ok' && result.value.currentMonth).toMatchObject({ spending: 525, unclassifiedCount: 1, unclassifiedAmount: 120 });
  });

  it('a card leg with no stored state in a FRESH snapshot is an integrity failure, never an untracked payment', async () => {
    const state = fixtureSnapshot();
    mockSnapshot.mockImplementation(async (_u: string, request: FinancialSnapshotRequest) => {
      const answer = serveSnapshot(state, request, { fresh: 7 });
      if (answer.kind === 'snapshot' && answer.snapshot.cardPayments?.kind === 'fresh') {
        const states = answer.snapshot.cardPayments.states;
        states.legs = states.legs.filter((leg) => leg.transactionId !== idOf('5a'));
      }
      return answer;
    });
    const error = await readSummary(USER, SUMMARY_ARGS, options).then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(CardPaymentStateIntegrityError);
    expect((error as CardPaymentStateIntegrityError).transactionId).toBe(idOf('5a'));
  });

  it('a range beyond the snapshot limits fails with aggregate_too_large — no partial figures', async () => {
    mockSnapshot.mockRejectedValue(new AggregateTooLargeError('the financial snapshot', 'holds 10001 transactions'));
    await expect(readSummary(USER, SUMMARY_ARGS, options)).rejects.toMatchObject({ code: 'aggregate_too_large' });
    await expect(readBudget(USER, { current: SEPTEMBER })).rejects.toMatchObject({ code: 'aggregate_too_large' });
    await expect(readEffectRows(USER, { ...SEPTEMBER, measure: 'spending', limit: 50 }, options)).rejects.toMatchObject({ code: 'aggregate_too_large' });
  });
});

describe('readMonthlyBreakdown', () => {
  it('September by Plaid category with loan interest, the excluded lines, and the frozen input — one snapshot', async () => {
    const result = await readMonthlyBreakdown(USER, { start: AUGUST.start }, options);
    if (result.status !== 'ok') throw new Error('expected ok');
    const sept = result.value.find((m) => m.month === '2026-09')!;
    expect(Object.fromEntries(sept.byCategory)).toEqual({ FOOD_AND_DRINK: 400, GENERAL_MERCHANDISE: 0, TRANSFER_OUT: 75, LOAN_INTEREST: 50 });
    expect(sept.excluded).toMatchObject({ transfersInternal: 500, creditCardPaymentsTracked: 900, debtPayments: 650 });
    expect(result.value.map((m) => m.month)).toEqual(['2026-08', '2026-09']);
    expect(result.frozen).toEqual(
      includedTransactions(fixtureSnapshot(), { start: AUGUST.start }).map((t) => ({ amount: t.amount, date: t.date, category: t.plaidCategory }))
    );
    // The frozen rows name exactly the months the role-aware result has.
    expect([...new Set(result.frozen.map((row) => row.date.slice(0, 7)))].sort()).toEqual(result.value.map((m) => m.month));
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('readBudget — one snapshot of categories, transactions and splits; independent of card-payment state', () => {
  it('current and recent periods; no card state requested, so it works while matching is stale or missing', async () => {
    serve(fixtureSnapshot(), { stale: null });
    const result = await readBudget(USER, { current: SEPTEMBER, recent: AUGUST });
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(Object.fromEntries(result.value.current.byCategory)).toEqual({
      [CATEGORY.groceries]: 270,
      [CATEGORY.dining]: 80,
      [CATEGORY.shopping]: 0,
      [CATEGORY.household]: 50,
    });
    expect(result.value.current.unassigned).toBe(125);
    expect(result.value.recent.byCategory.get(CATEGORY.dining)).toBe(45);
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSnapshot).toHaveBeenCalledWith(USER, { rows: { start: '2026-08-01', end: '2026-10-01' }, splits: true, budgetCategories: true });
    expect(mockPoll).not.toHaveBeenCalled();
  });

  it('the frozen inputs are the category list and exactly the rows the frozen read computes for each period', async () => {
    const state = fixtureSnapshot();
    const result = await readBudget(USER, { current: SEPTEMBER, recent: AUGUST });
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.frozen.categories).toEqual(state.categories);
    const frozenOf = (range: { start: string; end: string }) => {
      const rows = includedTransactions(state, range).map((t) => ({ id: t.id, budget_category_id: t.budgetCategoryId, amount: t.amount }));
      const ids = new Set(rows.map((r) => r.id));
      return categorySpendRowsOf(rows, state.splits!.filter((s) => ids.has(s.transaction_id)));
    };
    expect(result.frozen.spendRows.current).toEqual(frozenOf(SEPTEMBER));
    expect(result.frozen.spendRows.recent).toEqual(frozenOf(AUGUST));
  });

  it('a negative category total is preserved, not clamped', async () => {
    serve(fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '8a', { date: '2026-08-18' })) }));
    const result = await readBudget(USER, { current: SEPTEMBER });
    expect(result.status === 'ok' && result.value.current.byCategory.get(CATEGORY.shopping)).toBe(-60);
  });

  it('a split that does not sum to its transaction: refused, the rows named, NO role-aware figure — the frozen inputs are kept', async () => {
    const state = fixtureSnapshot();
    state.splits![0] = { ...state.splits![0], amount: 149.99 };
    serve(state);
    const result = await readBudget(USER, { current: SEPTEMBER, recent: AUGUST });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') return;
    expect(result).not.toHaveProperty('value');
    expect(result.mismatch).toBeInstanceOf(SplitAllocationMismatchError);
    expect(result.mismatch.transactionId).toBe(idOf('10'));
    expect(result.mismatch).not.toBeInstanceOf(SemanticIntegrityError);
    expect(result.frozen.categories).toHaveLength(4);
    expect(result.frozen.spendRows.current.length).toBeGreaterThan(0);
  });
});

// ---- Drill-down ----------------------------------------------------------------------------------

const cents = (dollars: number) => Math.round(dollars * 100);

/** Reads every page of a bucket and checks the invariants each page must hold. */
async function allPages(query: Omit<EffectQuery, 'cursor'>): Promise<{ rows: EffectRowView[]; pages: EffectPage[] }> {
  const pages: EffectPage[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const result = await readEffectRows(USER, { ...query, cursor }, options);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    pages.push(result.value);
    cursor = result.value.next_cursor;
    if (cursor === null) break;
  }
  const rows = pages.flatMap((p) => p.rows);
  // The complete total and count are on EVERY page, and identical.
  for (const page of pages) {
    expect(page.total_amount).toBe(pages[0].total_amount);
    expect(page.total_count).toBe(pages[0].total_count);
  }
  expect(rows).toHaveLength(pages[0].total_count);
  expect(rows.reduce((sum, r) => sum + cents(r.effect_amount), 0)).toBe(cents(pages[0].total_amount));
  // (date desc, id desc), and no transaction's effects on two pages.
  const keys = rows.map((r) => `${r.transaction.date}|${r.transaction.id}`);
  expect([...keys].sort().reverse()).toEqual(keys);
  const pageOfTransaction = new Map<string, number>();
  pages.forEach((page, index) => {
    for (const row of page.rows) {
      const seen = pageOfTransaction.get(row.transaction.id);
      expect(seen === undefined || seen === index).toBe(true);
      pageOfTransaction.set(row.transaction.id, index);
    }
  });
  return { rows, pages };
}

describe('readEffectRows — every bucket reconciles to its published total, across pages', () => {
  it('every budget category bucket, at page sizes 1, 2 and 50: Σ rows = total_amount = the budget figure', async () => {
    const budget = await readBudget(USER, { current: SEPTEMBER });
    if (budget.status !== 'ok') throw new Error('expected ok');
    const buckets: [string | null, number][] = [...Array.from(budget.value.current.byCategory.entries()), [null, budget.value.current.unassigned]];
    expect(buckets).toHaveLength(5);
    for (const [id, figure] of buckets) {
      for (const limit of [1, 2, 50]) {
        const { pages } = await allPages({ ...SEPTEMBER, measure: 'spending', bucket: { kind: 'budget_category', id }, limit });
        expect(pages[0].total_amount).toBe(figure);
      }
    }
  });

  it('Shopping lists both rows and totals $0.00; unassigned lists the loan\'s interest and the Venmo row', async () => {
    const shopping = await allPages({ ...SEPTEMBER, measure: 'spending', bucket: { kind: 'budget_category', id: CATEGORY.shopping }, limit: 50 });
    expect(shopping.pages[0]).toMatchObject({ total_amount: 0, total_count: 2 });
    expect(shopping.rows.map((r) => [r.transaction.id, r.effect_role, r.effect_amount])).toEqual([
      [idOf('8b'), 'refund', -60],
      [idOf('8a'), 'expense', 60],
    ]);
    const unassigned = await allPages({ ...SEPTEMBER, measure: 'spending', bucket: { kind: 'budget_category', id: null }, limit: 50 });
    expect(unassigned.pages[0]).toMatchObject({ total_amount: 125, total_count: 2 });
    expect(unassigned.rows.find((r) => r.transaction.id === idOf('6'))).toMatchObject({
      effect_role: 'expense',
      effect_amount: 50,
      allocation: 'interest',
      budget_category_id: null,
      plaid_category: 'LOAN_INTEREST',
      transaction: { effective_role: 'debt_payment' },
    });
  });

  it('a split parent contributes one row per split, with the split\'s own category, id and note', async () => {
    const groceries = await allPages({ ...SEPTEMBER, measure: 'spending', bucket: { kind: 'budget_category', id: CATEGORY.groceries }, limit: 50 });
    expect(groceries.pages[0].total_amount).toBe(270);
    expect(groceries.rows.find((r) => r.transaction.id === idOf('10'))).toEqual({
      transaction: {
        id: idOf('10'),
        date: '2026-09-22',
        name: `Name of ${idOf('10')}`,
        merchant_name: null,
        account: { id: ACCOUNT.X, name: `Account ${ACCOUNT.X}`, nickname: null },
        pending: false,
        effective_role: 'expense',
        user_role_override: null,
        needs_review: false,
      },
      effect_role: 'expense',
      effect_amount: 150,
      allocation: 'split',
      split_id: 'split-10a',
      split_note: 'note split-10a',
      budget_category_id: CATEGORY.groceries,
      plaid_category: 'FOOD_AND_DRINK',
    });
  });

  it('a page never splits one transaction\'s effects, and may exceed its limit to keep them together', async () => {
    const state = fixtureSnapshot();
    state.splits = [
      { id: 'split-a', transaction_id: idOf('10'), budget_category_id: CATEGORY.groceries, amount: 100, note: null },
      { id: 'split-b', transaction_id: idOf('10'), budget_category_id: CATEGORY.groceries, amount: 50, note: null },
      { id: 'split-c', transaction_id: idOf('10'), budget_category_id: CATEGORY.household, amount: 50, note: null },
    ];
    serve(state);
    const { pages } = await allPages({ ...SEPTEMBER, measure: 'spending', bucket: { kind: 'budget_category', id: CATEGORY.groceries }, limit: 1 });
    expect(pages[0].total_count).toBe(3);
    expect(pages.map((p) => p.rows.map((r) => r.transaction.id))).toEqual([[idOf('10'), idOf('10')], [idOf('2')]]);
  });

  it('every Plaid category bucket reconciles to the Monthly Breakdown\'s figure; LOAN_INTEREST is a bucket', async () => {
    const breakdown = await readMonthlyBreakdown(USER, { ...SEPTEMBER }, options);
    if (breakdown.status !== 'ok') throw new Error('expected ok');
    const sept = breakdown.value.find((m) => m.month === '2026-09')!;
    expect(sept.byCategory.size).toBe(4);
    for (const [category, figure] of sept.byCategory) {
      for (const limit of [1, 50]) {
        const { pages } = await allPages({ ...SEPTEMBER, measure: 'spending', bucket: { kind: 'plaid_category', category }, limit });
        expect(pages[0].total_amount).toBe(figure);
      }
    }
  });

  it('F5 — unbucketed spending: every expense and refund effect, signed, summing to the summary\'s own spending; interest keeps its allocation', async () => {
    const summary = await readSummary(USER, { range: SEPTEMBER, currentMonth: SEPTEMBER }, options);
    if (summary.status !== 'ok') throw new Error('expected ok');
    for (const limit of [1, 3, 50]) {
      const { rows, pages } = await allPages({ ...SEPTEMBER, measure: 'spending', limit });
      expect(pages[0].total_amount).toBe(summary.value.currentMonth.spending);
      expect(pages[0].total_amount).toBe(525);
      expect(rows).toHaveLength(7); // 2, 3, 6 (interest), 8a, 8b, 9, 10
      expect(rows.find((r) => r.transaction.id === idOf('6'))).toMatchObject({ effect_amount: 50, allocation: 'interest', plaid_category: 'LOAN_INTEREST' });
      expect(rows.find((r) => r.transaction.id === idOf('8b'))).toMatchObject({ effect_role: 'refund', effect_amount: -60 });
      // The split parent appears once, whole: cash-flow spending never reads splits.
      expect(rows.filter((r) => r.transaction.id === idOf('10')).map((r) => [r.effect_amount, r.allocation])).toEqual([[200, 'row']]);
    }
    // It reads no card state, so it is available while matching is stale.
    serve(fixtureSnapshot(), { stale: null });
    const stale = await readEffectRows(USER, { ...SEPTEMBER, measure: 'spending', limit: 50 }, options);
    expect(stale.status === 'ok' && stale.value.total_amount).toBe(525);
  });

  it('F5 — debt_payments_unknown_principal: the debt payments with no manual-loan split, summing exactly to the published amount', async () => {
    const summary = await readSummary(USER, { range: SEPTEMBER, currentMonth: SEPTEMBER }, options);
    if (summary.status !== 'ok') throw new Error('expected ok');
    const { rows, pages } = await allPages({ ...SEPTEMBER, measure: 'debt_payments_unknown_principal', limit: 50 });
    expect(pages[0].total_amount).toBe(summary.value.currentMonth.debtPaymentsUnknownPrincipal);
    expect(rows.map((r) => [r.transaction.id, r.effect_amount, r.allocation])).toEqual([[idOf('7'), 300, 'row']]);
    // With an explicit debt_payment override the linked row's whole $400 has no known split either.
    serve(fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), '6', { userRoleOverride: 'debt_payment' })) }));
    const overridden = await allPages({ ...SEPTEMBER, measure: 'debt_payments_unknown_principal', limit: 50 });
    expect(overridden.pages[0].total_amount).toBe(700);
  });

  it('every cash-flow measure reconciles to the summary\'s own total, for the fixture and a card-heavy variant', async () => {
    const totalOf: Record<(typeof EFFECT_MEASURES)[number], (t: CashFlowTotals) => number> = {
      spending: (t) => t.spending,
      income: (t) => t.income,
      debt_payments: (t) => t.debtPayments,
      known_principal: (t) => t.knownPrincipal,
      debt_payments_unknown_principal: (t) => t.debtPaymentsUnknownPrincipal,
      refunds: (t) => t.refunds,
      transfers_internal: (t) => t.transfersInternal,
      transfers_external: (t) => t.transfersExternal,
      credit_card_payments_tracked: (t) => t.creditCardPaymentsTracked,
      credit_card_payments_untracked: (t) => t.creditCardPaymentsUntracked,
      credit_card_payments_returned_tracked: (t) => t.creditCardPaymentsReturnedTracked,
      credit_card_payments_returned_untracked: (t) => t.creditCardPaymentsReturnedUntracked,
      credit_card_payments_externally_funded: (t) => t.creditCardPaymentsExternallyFunded,
      credit_card_payments_reversed_externally: (t) => t.creditCardPaymentsReversedExternally,
      card_payments_unresolved_credit: (t) => t.cardPaymentsUnresolvedCredit,
      card_payments_unresolved_payments: (t) => t.cardPaymentsUnresolved.paymentsAmount,
      card_payments_unresolved_returns: (t) => t.cardPaymentsUnresolved.returnsAmount,
      unclassified: (t) => t.unclassifiedAmount,
    };
    const cardHeavy = fixtureSnapshot({
      transactions: withUuids([
        ...withRow(withRow(fixtureTransactions(), '9', { effectiveRole: 'internal_transfer', userRoleOverride: 'internal_transfer' }), '5b', {
          date: '2026-09-17', // 5a and 5b are 7 days apart: both unresolved
        }),
        { ...fixtureTransactions()[5], id: uuid(91), amount: -40, date: '2026-09-27' }, // an unresolved return into checking
        { ...fixtureTransactions()[6], id: uuid(92), amount: 15, date: '2026-09-29' }, // an unmatched reversal on the card
      ]),
    });
    let nonZero = 0;
    for (const state of [fixtureSnapshot(), cardHeavy]) {
      serve(state);
      const summary = await readSummary(USER, { range: SEPTEMBER, currentMonth: SEPTEMBER }, options);
      if (summary.status !== 'ok') throw new Error('expected ok');
      for (const measure of EFFECT_MEASURES) {
        for (const limit of [2, 50]) {
          const { pages } = await allPages({ ...SEPTEMBER, measure, limit });
          expect(pages[0].total_amount, measure).toBe(totalOf[measure](summary.value.currentMonth));
          if (pages[0].total_amount !== 0) nonZero++;
        }
      }
    }
    expect(nonZero).toBeGreaterThan(20);
    // The unresolved measures have rows in the card-heavy variant.
    serve(cardHeavy);
    expect((await allPages({ ...SEPTEMBER, measure: 'card_payments_unresolved_payments', limit: 50 })).pages[0].total_amount).toBe(900);
    expect((await allPages({ ...SEPTEMBER, measure: 'card_payments_unresolved_returns', limit: 50 })).pages[0].total_amount).toBe(40);
    expect((await allPages({ ...SEPTEMBER, measure: 'card_payments_unresolved_credit', limit: 50 })).pages[0].total_amount).toBe(885); // +900 − 15
  });

  it('an empty bucket is an empty page with a zero total, not an error', async () => {
    const result = await readEffectRows(USER, { ...SEPTEMBER, measure: 'spending', bucket: { kind: 'plaid_category', category: 'TRAVEL' }, limit: 50 }, options);
    expect(result).toEqual({ status: 'ok', value: { rows: [], total_amount: 0, total_count: 0, next_cursor: null } });
  });
});

describe('readEffectRows — the continuation contract (review finding F3)', () => {
  const FOOD = { ...SEPTEMBER, measure: 'spending' as const, bucket: { kind: 'plaid_category' as const, category: 'FOOD_AND_DRINK' }, limit: 1 };
  const firstPage = async (query: EffectQuery = FOOD) => {
    const result = await readEffectRows(USER, query, options);
    if (result.status !== 'ok' || result.value.next_cursor === null) throw new Error('expected a first page with a continuation');
    return result.value;
  };
  const change = (id: string, edit: Partial<AggregationTransaction>): Snapshot =>
    fixtureSnapshot({ transactions: withUuids(withRow(fixtureTransactions(), id, edit)) });
  const restarts = async (query: EffectQuery) => {
    const error = await readEffectRows(USER, query, options).then(
      (value) => value,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(EffectsRestartRequiredError);
    expect(error).toMatchObject({ code: 'effects_restart_required', reason: 'snapshot_changed' });
  };

  it('the cursor is base64url of version|fingerprint|date|id, and round-trips', async () => {
    const page = await firstPage();
    const decoded = decodeEffectCursor(page.next_cursor!);
    expect(decoded).toEqual({ fingerprint: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), date: '2026-09-22', id: idOf('10') });
    expect(Buffer.from(page.next_cursor!, 'base64url').toString('utf8')).toBe(`2|${decoded.fingerprint}|2026-09-22|${idOf('10')}`);
    expect(encodeEffectCursor(decoded)).toBe(page.next_cursor);
  });

  it('the fingerprint is deterministic: the same state gives the same cursor, on every request and for every page size', async () => {
    const a = decodeEffectCursor((await firstPage()).next_cursor!).fingerprint;
    const b = decodeEffectCursor((await firstPage()).next_cursor!).fingerprint;
    const c = decodeEffectCursor((await firstPage({ ...FOOD, limit: 2 })).next_cursor!).fingerprint;
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('an unchanged result continues: the pages concatenate to the first page\'s total', async () => {
    const page1 = await firstPage();
    const page2 = await readEffectRows(USER, { ...FOOD, cursor: page1.next_cursor }, options);
    if (page2.status !== 'ok') throw new Error('expected ok');
    expect(page2.value.total_amount).toBe(page1.total_amount);
    expect(page2.value.rows.map((r) => r.transaction.id)).toEqual([idOf('3')]);
  });

  it('a change elsewhere that leaves this bucket\'s result identical does not force a restart', async () => {
    const page1 = await firstPage();
    serve(change('1', { amount: -3100 })); // income changed; FOOD_AND_DRINK is byte-for-byte the same
    const page2 = await readEffectRows(USER, { ...FOOD, cursor: page1.next_cursor }, options);
    expect(page2.status).toBe('ok');
  });

  it.each([
    ['an already-returned row changed amount', () => change('10', { amount: 210 })],
    ['a not-yet-returned row changed amount', () => change('2', { amount: 121 })],
    ['a row changed date (it would otherwise be repeated or skipped)', () => change('3', { date: '2026-09-25' })],
    ['a row left the bucket (category change)', () => change('3', { plaidCategory: 'TRAVEL' })],
    ['a row left the bucket (role change)', () => change('2', { effectiveRole: 'internal_transfer', userRoleOverride: 'internal_transfer' })],
    ['a row was deleted', () => fixtureSnapshot({ transactions: withUuids(fixtureTransactions().filter((r) => r.id !== '2')) })],
    [
      'a row was inserted',
      () => fixtureSnapshot({ transactions: [...withUuids(fixtureTransactions()), { ...withUuids(fixtureTransactions())[1], id: uuid(60), date: '2026-09-04' }] }),
    ],
    [
      'a pending row was replaced by its posted row (new id)',
      () => fixtureSnapshot({ transactions: withUuids(fixtureTransactions()).map((t) => (t.id === idOf('2') ? { ...t, id: uuid(61) } : t)) }),
    ],
  ])('a later page after %s is refused: restart required, with no rows and no total', async (_name, next) => {
    const page1 = await firstPage();
    serve(next());
    await restarts({ ...FOOD, cursor: page1.next_cursor });
  });

  it('amounts moved between two rows with the total and the count unchanged still restart: the fingerprint covers every row, not only the total', async () => {
    const page1 = await firstPage();
    // Row 2: 120 → 130, row 3: 80 → 70. FOOD_AND_DRINK is still 400 over three rows.
    serve(fixtureSnapshot({ transactions: withUuids(withRow(withRow(fixtureTransactions(), '2', { amount: 130 }), '3', { amount: 70 })) }));
    const unchangedTotal = await readEffectRows(USER, { ...FOOD }, options);
    expect(unchangedTotal.status === 'ok' && [unchangedTotal.value.total_amount, unchangedTotal.value.total_count]).toEqual([page1.total_amount, page1.total_count]);
    await restarts({ ...FOOD, cursor: page1.next_cursor });
  });

  it('a principal edit restarts a debt drill-down; a split edit restarts a budget drill-down; a matching change restarts a card drill-down', async () => {
    // Principal: two linked rows so the bucket has two pages.
    const linked = (id: number, principal: number): AggregationTransaction => ({ ...fixtureTransactions()[7], id: uuid(id), manualLoanId: LOAN_M, principalPortion: principal });
    const loans = (a: number, b: number) => fixtureSnapshot({ transactions: [...withUuids(fixtureTransactions()), linked(82, a), linked(83, b)] });
    serve(loans(350, 350));
    const principalQuery = { ...SEPTEMBER, measure: 'known_principal' as const, limit: 1 };
    const principalPage = await firstPage(principalQuery);
    serve(loans(350, 250));
    await restarts({ ...principalQuery, cursor: principalPage.next_cursor });

    // Splits.
    serve(fixtureSnapshot());
    const groceries = { ...SEPTEMBER, measure: 'spending' as const, bucket: { kind: 'budget_category' as const, id: CATEGORY.groceries }, limit: 1 };
    const splitPage = await firstPage(groceries);
    const resplit = fixtureSnapshot();
    resplit.splits = [
      { id: 'split-10a', transaction_id: idOf('10'), budget_category_id: CATEGORY.groceries, amount: 140, note: 'note split-10a' },
      { id: 'split-10b', transaction_id: idOf('10'), budget_category_id: CATEGORY.household, amount: 60, note: 'note split-10b' },
    ];
    serve(resplit);
    await restarts({ ...groceries, cursor: splitPage.next_cursor });

    // Matching state: a second, late card payment is unresolved, then the user confirms it.
    const late = [
      { ...fixtureTransactions()[5], id: uuid(84), amount: 250, date: '2026-09-18' },
      { ...fixtureTransactions()[6], id: uuid(85), amount: -250, date: '2026-09-26' },
    ];
    const withLate = fixtureSnapshot({ transactions: [...withUuids(fixtureTransactions()), ...late] });
    serve(withLate);
    const trackedQuery = { ...SEPTEMBER, measure: 'credit_card_payments_tracked' as const, limit: 1 };
    const before = await readEffectRows(USER, trackedQuery, options);
    expect(before.status === 'ok' && before.value).toMatchObject({ total_amount: 900, total_count: 1, next_cursor: null });
    // With the pair confirmed the bucket has two rows, hence a cursor; un-confirming it changes the result.
    serve({ ...withLate, decisions: [pairDecision('d', late[0], late[1])] }, { fresh: 8 });
    const cardPage = await firstPage(trackedQuery);
    expect(cardPage.total_amount).toBe(1150);
    serve(withLate, { fresh: 9 });
    await restarts({ ...trackedQuery, cursor: cardPage.next_cursor });
  });

  it('a display-only change to a row (its name) also restarts: the pages must describe the same result byte for byte', async () => {
    const page1 = await firstPage();
    const renamed = fixtureSnapshot();
    mockSnapshot.mockImplementationOnce(async (_u: string, request: FinancialSnapshotRequest) => {
      const answer = serveSnapshot(renamed, request, db.cards);
      if (answer.kind === 'snapshot') answer.snapshot.transactions.find((t) => t.id === idOf('3'))!.name = 'Renamed';
      return answer;
    });
    await restarts({ ...FOOD, cursor: page1.next_cursor });
  });

  it('a cursor is bound to its query: reuse with another range, measure or bucket is rejected', async () => {
    const page1 = await firstPage();
    await restarts({ ...FOOD, start: '2026-09-02', cursor: page1.next_cursor });
    await restarts({ ...FOOD, end: '2026-09-30', cursor: page1.next_cursor });
    await restarts({ ...FOOD, bucket: { kind: 'plaid_category', category: 'GENERAL_MERCHANDISE' }, cursor: page1.next_cursor });
    await restarts({ ...FOOD, bucket: { kind: 'budget_category', id: CATEGORY.groceries }, cursor: page1.next_cursor });
    await restarts({ ...FOOD, bucket: undefined, cursor: page1.next_cursor });
    await restarts({ ...SEPTEMBER, measure: 'income', limit: 1, cursor: page1.next_cursor });
    // The page size is not part of the result: a different limit on a later page is fine.
    expect((await readEffectRows(USER, { ...FOOD, limit: 50, cursor: page1.next_cursor }, options)).status).toBe('ok');
  });

  it('when the matching state is stale on a later page the answer is updating — not a restart — and the same cursor works once it is fresh', async () => {
    const incomes = fixtureSnapshot({
      transactions: [...withUuids(fixtureTransactions()), { ...withUuids(fixtureTransactions())[0], id: uuid(62), amount: -200, date: '2026-09-14' }],
    });
    serve(incomes);
    const query = { ...SEPTEMBER, measure: 'income' as const, limit: 1 };
    const page1 = await firstPage(query);
    db.cards = { stale: null };
    expect(await readEffectRows(USER, { ...query, cursor: page1.next_cursor }, options)).toEqual({
      status: 'updating',
      retryAfterMs: SEMANTIC_READ_RETRY_AFTER_MS,
      reason: 'matching_pending',
    });
    db.cards = { fresh: 8 };
    expect((await readEffectRows(USER, { ...query, cursor: page1.next_cursor }, options)).status).toBe('ok');
  });

  it('a malformed, old-format or impossible cursor is refused before anything is read', async () => {
    const fingerprint = 'A'.repeat(43);
    const encode = (text: string) => Buffer.from(text, 'utf8').toString('base64url');
    const bad = [
      'not base64!',
      '***',
      encode(`2026-09-01|${idOf('2')}`), // the old date|id cursor
      encode(`1|${fingerprint}|2026-09-01|${idOf('2')}`), // wrong version
      encode(`2|short|2026-09-01|${idOf('2')}`),
      encode(`2|${fingerprint}|2026-09-01|not-a-uuid`),
      encode(`2|${fingerprint}|2026-02-30|${idOf('2')}`), // a date that does not exist
      encode(`2|${fingerprint}|2026-13-01|${idOf('2')}`),
      encode(`2|${fingerprint}|2026-09-01|${idOf('2')}|extra`),
    ];
    for (const cursor of bad) {
      const error = await readEffectRows(USER, { ...FOOD, cursor }, options).then(
        () => null,
        (err: unknown) => err
      );
      expect(error, cursor).toBeInstanceOf(InvalidEffectQueryError);
      expect((error as InvalidEffectQueryError).code).toBe('invalid_cursor');
    }
    await expect(readEffectRows(USER, { ...SEPTEMBER, measure: 'income', bucket: FOOD.bucket, limit: 50 }, options)).rejects.toMatchObject({ code: 'invalid_effect_query' });
    await expect(readEffectRows(USER, { ...FOOD, limit: 0 }, options)).rejects.toMatchObject({ code: 'invalid_effect_query' });
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('isCalendarDate accepts real dates only', () => {
    expect(isCalendarDate('2026-09-30')).toBe(true);
    expect(isCalendarDate('2024-02-29')).toBe(true);
    for (const value of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-9-1', '20260901', '']) expect(isCalendarDate(value), value).toBe(false);
  });
});
