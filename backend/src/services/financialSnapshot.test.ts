import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { rpc: mockRpc, from: vi.fn() } }));

import {
  FINANCIAL_SNAPSHOT_TIMEOUT_MS,
  parseFinancialSnapshot,
  readFinancialSnapshot,
  SNAPSHOT_MAX_SPLITS,
  SNAPSHOT_MAX_TRANSACTIONS,
  type FinancialSnapshotRequest,
} from './financialSnapshot';
import { AggregateTooLargeError } from './fetchAllPages';

// Financial Semantics Phase B, slice I1: the coherent financial read. One call of
// get_financial_read_snapshot — one statement, one database snapshot — and a payload that is either
// exactly the documented shape or not used at all.

/** `.rpc(...).abortSignal(signal)` resolves to `result(signal)`, like postgrest-js. */
function respond(result: (signal: AbortSignal) => Promise<unknown>) {
  const abortSignal = vi.fn((signal: AbortSignal) => result(signal));
  mockRpc.mockReturnValue({ abortSignal });
  return abortSignal;
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

const USER = '11111111-1111-4111-8111-111111111111';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const loggedText = () => JSON.stringify(warn.mock.calls);

const txn = (n: number, date: string, overrides: Record<string, unknown> = {}) => ({
  id: uuid(n),
  account_id: uuid(900),
  date,
  amount: 12.5,
  category: 'FOOD_AND_DRINK',
  budget_category_id: null,
  effective_role: 'expense',
  user_role_override: null,
  manual_loan_id: null,
  principal_portion: null,
  name: 'Coffee',
  merchant_name: null,
  pending: false,
  needs_review: false,
  plaid_transaction_id: `plaid-${n}`,
  pending_transaction_id: null,
  accounts: { name: 'Checking', nickname: null, type: 'depository', exclude_from_cash_flow: false },
  ...overrides,
});
const split = (n: number, parent: number, overrides: Record<string, unknown> = {}) => ({
  id: uuid(n),
  transaction_id: uuid(parent),
  budget_category_id: uuid(800),
  amount: 5,
  note: null,
  ...overrides,
});
const cardStates = { fresh: true, inputVersion: 7, evaluatedVersion: 7, legs: [], decisions: [], supersededTransactionIds: [] };
const payload = (overrides: Record<string, unknown> = {}) => ({
  tooLarge: false,
  transactionCount: 2,
  splitCount: 0,
  maxTransactions: 10000,
  maxSplits: 25000,
  transactions: [txn(1, '2026-09-01'), txn(2, '2026-09-02')],
  splits: null,
  budgetCategories: null,
  cardPayments: null,
  ...overrides,
});

const ROWS_ONLY: FinancialSnapshotRequest = { rows: { start: '2026-09-01', end: '2026-10-01' } };
const EVERYTHING: FinancialSnapshotRequest = {
  rows: { start: '2026-08-26', end: '2026-10-07' },
  splits: true,
  budgetCategories: true,
  cardStates: { from: '2026-09-01', to: '2026-10-01' },
};

describe('readFinancialSnapshot — the request', () => {
  it('is ONE rpc call carrying the whole read: rows, and nothing optional unless asked', async () => {
    const abortSignal = respond(async () => ({ data: payload(), error: null }));
    await readFinancialSnapshot(USER, ROWS_ONLY);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('get_financial_read_snapshot', {
      p_user_id: USER,
      p_from: '2026-09-01',
      p_to: '2026-10-01',
      p_include_splits: false,
      p_include_budget_categories: false,
      p_include_card_states: false,
      p_card_states_from: null,
      p_card_states_to: null,
    });
    expect(abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
  });

  it('asks for splits, budget categories and card states in the SAME call', async () => {
    respond(async () => ({
      data: payload({ splitCount: 1, splits: [split(10, 1)], budgetCategories: [{ id: uuid(800), name: 'Food' }], cardPayments: cardStates }),
      error: null,
    }));
    await readFinancialSnapshot(USER, EVERYTHING);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('get_financial_read_snapshot', {
      p_user_id: USER,
      p_from: '2026-08-26',
      p_to: '2026-10-07',
      p_include_splits: true,
      p_include_budget_categories: true,
      p_include_card_states: true,
      p_card_states_from: '2026-09-01',
      p_card_states_to: '2026-10-01',
    });
  });

  it('an open-ended range sends null upper bounds; the limits are never a request parameter', async () => {
    respond(async () => ({ data: payload({ cardPayments: cardStates }), error: null }));
    await readFinancialSnapshot(USER, { rows: { start: '2026-08-26' }, cardStates: { from: '2026-09-01' } });
    const args = mockRpc.mock.calls[0][1] as Record<string, unknown>;
    expect(args).toMatchObject({ p_to: null, p_card_states_to: null });
    expect(Object.keys(args).some((key) => /max|limit/i.test(key))).toBe(false);
  });

  it('documents a finite default timeout', () => {
    expect(Number.isFinite(FINANCIAL_SNAPSHOT_TIMEOUT_MS)).toBe(true);
  });
});

describe('readFinancialSnapshot — the payload', () => {
  it('returns the rows exactly as sent, with null for every part that was not requested', async () => {
    respond(async () => ({ data: payload(), error: null }));
    const read = await readFinancialSnapshot(USER, ROWS_ONLY);
    expect(read).toEqual({
      kind: 'snapshot',
      snapshot: { transactions: [txn(1, '2026-09-01'), txn(2, '2026-09-02')], splits: null, budgetCategories: null, cardPayments: null },
    });
  });

  it('returns splits, categories and FRESH card states when requested', async () => {
    const categories = [{ id: uuid(800), user_id: USER, name: 'Food', budget_amount: 400, color: null, sort_order: 1, emoji: null, archived_at: null }];
    respond(async () => ({
      data: payload({ splitCount: 2, splits: [split(10, 1), split(11, 1)], budgetCategories: categories, cardPayments: cardStates }),
      error: null,
    }));
    const read = await readFinancialSnapshot(USER, EVERYTHING);
    if (read.kind !== 'snapshot') throw new Error('expected a snapshot');
    expect(read.snapshot.splits).toEqual([split(10, 1), split(11, 1)]);
    expect(read.snapshot.budgetCategories).toEqual(categories);
    expect(read.snapshot.cardPayments).toEqual({ kind: 'fresh', inputVersion: 7, states: { legs: [], supersededTransactionIds: [] } });
  });

  it('passes STALE card states through as stale — the rows are still returned, the states are not', async () => {
    respond(async () => ({
      data: payload({ cardPayments: { fresh: false, inputVersion: 9, evaluatedVersion: 7, lastErrorCode: '22012' } }),
      error: null,
    }));
    const read = await readFinancialSnapshot(USER, { ...ROWS_ONLY, cardStates: { from: '2026-09-01', to: '2026-10-01' } });
    if (read.kind !== 'snapshot') throw new Error('expected a snapshot');
    expect(read.snapshot.cardPayments).toEqual({ kind: 'stale', inputVersion: 9, evaluatedVersion: 7, lastErrorCode: '22012' });
    expect(read.snapshot.transactions).toHaveLength(2);
  });

  it('an empty range is an empty snapshot, not an error', async () => {
    respond(async () => ({ data: payload({ transactionCount: 0, transactions: [] }), error: null }));
    expect(await readFinancialSnapshot(USER, ROWS_ONLY)).toMatchObject({ kind: 'snapshot', snapshot: { transactions: [] } });
  });

  it.each([
    ['null', null],
    ['an array', [payload()]],
    ['no tooLarge flag', payload({ tooLarge: undefined })],
    ['a string count', payload({ transactionCount: '2' })],
    ['a count that does not match the rows (a truncated list)', payload({ transactionCount: 3 })],
    ['transactions missing', payload({ transactions: undefined })],
    ['rows out of (date, id) order', payload({ transactions: [txn(2, '2026-09-02'), txn(1, '2026-09-01')] })],
    ['a repeated row', payload({ transactions: [txn(1, '2026-09-01'), txn(1, '2026-09-01')] })],
    ['a row on an account excluded from cash flow', payload({ transactions: [txn(1, '2026-09-01', { accounts: { name: 'X', nickname: null, type: null, exclude_from_cash_flow: true } }), txn(2, '2026-09-02')] })],
    ['a string amount', payload({ transactions: [txn(1, '2026-09-01', { amount: '12.50' }), txn(2, '2026-09-02')] })],
    ['a malformed date', payload({ transactions: [txn(1, '2026-9-1'), txn(2, '2026-09-02')] })],
    ['a numeric role', payload({ transactions: [txn(1, '2026-09-01', { effective_role: 1 }), txn(2, '2026-09-02')] })],
    ['a string principal', payload({ transactions: [txn(1, '2026-09-01', { principal_portion: '350' }), txn(2, '2026-09-02')] })],
    ['a row without its account', payload({ transactions: [txn(1, '2026-09-01', { accounts: null }), txn(2, '2026-09-02')] })],
    ['a missing lineage id', payload({ transactions: [txn(1, '2026-09-01', { plaid_transaction_id: undefined }), txn(2, '2026-09-02')] })],
  ])('a payload outside the documented shape (%s) is unavailable — never coerced into rows', async (_name, data) => {
    respond(async () => ({ data, error: null }));
    expect(await readFinancialSnapshot(USER, ROWS_ONLY)).toEqual({ kind: 'unavailable', reason: 'unexpected_response' });
    expect(parseFinancialSnapshot(data, ROWS_ONLY)).toBeNull();
  });

  it.each([
    ['splits missing although requested', payload({ splits: null, cardPayments: cardStates, budgetCategories: [] })],
    ['a split count that does not match', payload({ splitCount: 2, splits: [split(10, 1)], cardPayments: cardStates, budgetCategories: [] })],
    ['splits out of (transaction_id, id) order', payload({ splitCount: 2, splits: [split(11, 2), split(10, 1)], cardPayments: cardStates, budgetCategories: [] })],
    ['a split without a category', payload({ splitCount: 1, splits: [split(10, 1, { budget_category_id: null })], cardPayments: cardStates, budgetCategories: [] })],
    ['categories missing although requested', payload({ splits: [], cardPayments: cardStates, budgetCategories: null })],
    ['a category without an id', payload({ splits: [], cardPayments: cardStates, budgetCategories: [{ name: 'Food' }] })],
    ['card states missing although requested', payload({ splits: [], budgetCategories: [], cardPayments: null })],
    ['card states that claim fresh with different versions', payload({ splits: [], budgetCategories: [], cardPayments: { ...cardStates, evaluatedVersion: 6 } })],
  ])('a requested part that is not in the documented shape (%s) makes the whole snapshot unavailable', async (_name, data) => {
    respond(async () => ({ data, error: null }));
    expect(await readFinancialSnapshot(USER, EVERYTHING)).toEqual({ kind: 'unavailable', reason: 'unexpected_response' });
  });

  it('splits sent although not requested are not the documented shape either', async () => {
    respond(async () => ({ data: payload({ splitCount: 1, splits: [split(10, 1)] }), error: null }));
    expect(await readFinancialSnapshot(USER, ROWS_ONLY)).toEqual({ kind: 'unavailable', reason: 'unexpected_response' });
  });
});

describe('readFinancialSnapshot — beyond the limits nothing is computed', () => {
  it('tooLarge throws aggregate_too_large with the counts and the limits; no rows are ever returned', async () => {
    respond(async () => ({
      data: { tooLarge: true, transactionCount: 10001, splitCount: 12, maxTransactions: 10000, maxSplits: 25000 },
      error: null,
    }));
    const error = await readFinancialSnapshot(USER, EVERYTHING).then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(AggregateTooLargeError);
    expect((error as AggregateTooLargeError).code).toBe('aggregate_too_large');
    expect((error as Error).message).toMatch(/10001 transactions and 12 splits/);
    expect((error as Error).message).toMatch(/refusing to return a partial result/);
    expect(SNAPSHOT_MAX_TRANSACTIONS).toBe(10_000);
    expect(SNAPSHOT_MAX_SPLITS).toBe(25_000);
  });

  it('a tooLarge payload that also carried rows is still refused: the rows are not used', async () => {
    respond(async () => ({ data: { ...payload(), tooLarge: true, splitCount: 25001 }, error: null }));
    await expect(readFinancialSnapshot(USER, EVERYTHING)).rejects.toBeInstanceOf(AggregateTooLargeError);
  });
});

describe('readFinancialSnapshot — no usable answer', () => {
  it.each(['PGRST202', '42883'])('a missing function (%s) is objects_missing: the migration is not applied', async (code) => {
    respond(async () => ({ data: null, error: { code, message: `function public.get_financial_read_snapshot(${USER}) does not exist` }, status: 404 }));
    expect(await readFinancialSnapshot(USER, ROWS_ONLY)).toEqual({ kind: 'unavailable', reason: 'objects_missing' });
    expect(loggedText()).toContain(code);
    expect(loggedText()).not.toContain(USER);
    expect(loggedText()).not.toContain('does not exist');
  });

  it('another PostgREST error is request_error; a status-0 failure and a thrown value are request_failed; none of them throws', async () => {
    respond(async () => ({ data: null, error: { code: '57014', message: `canceling statement for ${USER}` }, status: 500 }));
    expect(await readFinancialSnapshot(USER, ROWS_ONLY)).toEqual({ kind: 'unavailable', reason: 'request_error' });
    respond(async () => ({ data: null, error: { message: 'TypeError: fetch failed', code: '' }, status: 0 }));
    expect(await readFinancialSnapshot(USER, ROWS_ONLY)).toEqual({ kind: 'unavailable', reason: 'request_failed' });
    respond(async () => {
      throw new TypeError(`socket hang up for ${USER}`);
    });
    expect(await readFinancialSnapshot(USER, ROWS_ONLY)).toEqual({ kind: 'unavailable', reason: 'request_failed' });
    mockRpc.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(await readFinancialSnapshot(USER, ROWS_ONLY)).toEqual({ kind: 'unavailable', reason: 'request_failed' });
    expect(loggedText()).not.toContain(USER);
    expect(loggedText()).not.toContain('canceling');
  });

  it('a timeout is its own outcome whether the client resolves or rejects on abort', async () => {
    respond(
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () => resolve({ data: null, error: { message: 'AbortError', code: '' }, status: 0 }));
        })
    );
    expect(await readFinancialSnapshot(USER, ROWS_ONLY, { timeoutMs: 5 })).toEqual({ kind: 'unavailable', reason: 'timeout' });
    respond(
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        })
    );
    expect(await readFinancialSnapshot(USER, ROWS_ONLY, { timeoutMs: 5 })).toEqual({ kind: 'unavailable', reason: 'timeout' });
  });
});
