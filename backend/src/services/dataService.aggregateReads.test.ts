import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFrom = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { from: mockFrom, rpc: vi.fn() } }));
const mockSnapshot = vi.hoisted(() => vi.fn());
vi.mock('./financialSnapshot', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./financialSnapshot')>()),
  readFinancialSnapshot: mockSnapshot,
}));

import { categorySpendRowsOf, getCategorizedTransactionsSince, getCategorySpendRows, getNetWorthHistory, getTransactionsSince } from './dataService';
import { AggregateSnapshotUnavailableError, AggregateTooLargeError } from './fetchAllPages';
import { aggregateSpendByCategory } from './budgetPeriod';

// Financial Semantics Phase B, slice I1 — the frozen (sign-based) aggregate reads.
//
// A published aggregate must come from ONE coherent database state and must never be silently
// truncated. So each frozen read is one statement: the single request main has always made, now with
// an exact row count that proves it complete; beyond one response, the snapshot function; and if that
// is unusable, a failure — never a truncated total, never pages from several states.
//
// The fake table below behaves like PostgREST for these calls: it CAPS a response at `serverCap` rows
// whatever was asked for, and — when the request asks for an exact count — reports the count of ALL
// matching rows, computed with the rows.

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Request {
  table: string;
  select: string;
  countOption: unknown;
  filters: [string, ...unknown[]][];
  returned: number;
}

function fakeTable<Row extends Record<string, unknown>>(rows: Row[], keyColumns: string[], serverCap = 1000) {
  const requests: Request[] = [];
  const keyOf = (row: Row) => keyColumns.map((c) => String(row[c]));
  const compare = (a: string[], b: string[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return 0;
  };
  const sorted = [...rows].sort((a, b) => compare(keyOf(a), keyOf(b)));

  const make = (table: string) => {
    const request: Request = { table, select: '', countOption: undefined, filters: [], returned: 0 };
    let after: string | null = null;
    let limit: number | null = null;
    const builder: Record<string, unknown> = {};
    builder.select = vi.fn((columns: string, options?: { count?: string }) => {
      request.select = columns;
      request.countOption = options?.count;
      return builder;
    });
    for (const method of ['eq', 'gte', 'lt', 'order']) {
      builder[method] = vi.fn((...args: unknown[]) => {
        request.filters.push([method, ...args]);
        return builder;
      });
    }
    // Only the net-worth read pages (rows keyed by date alone).
    builder.gt = vi.fn((column: string, value: string) => {
      request.filters.push(['gt', column, value]);
      after = value;
      return builder;
    });
    builder.or = vi.fn(() => {
      throw new Error('a keyset page of transactions or splits was requested: these reads must never page');
    });
    builder.limit = vi.fn((count: number) => {
      limit = count;
      return builder;
    });
    builder.then = (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => {
      const matching = after === null ? sorted : sorted.filter((row) => String(row[keyColumns[0]]) > after!);
      const page = matching.slice(0, Math.min(limit ?? Number.POSITIVE_INFINITY, serverCap));
      request.returned = page.length;
      requests.push(request);
      return Promise.resolve({ data: page, error: null, count: request.countOption === 'exact' ? matching.length : null }).then(onFulfilled, onRejected);
    };
    return builder;
  };
  return { make, requests };
}

/** `count` transactions spread over 13 months, with cent-level amounts of both signs. */
function transactions(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const day = new Date(Date.UTC(2025, 8, 1));
    day.setUTCDate(day.getUTCDate() + (i % 395));
    return {
      id: uuid(i + 1),
      date: day.toISOString().slice(0, 10),
      amount: (i % 7 === 0 ? -1 : 1) * (10 + (i % 90) + (i % 100) / 100),
      category: i % 3 === 0 ? 'FOOD_AND_DRINK' : null,
      budget_category_id: i % 4 === 0 ? 'cat-a' : null,
    };
  });
}
const cents = (rows: { amount: number }[]) => rows.reduce((sum, r) => sum + Math.round(r.amount * 100), 0);
const byKey = <T extends { date: string; id: string }>(rows: T[]) => [...rows].sort((a, b) => (a.date + a.id < b.date + b.id ? -1 : 1));

/** The snapshot function's answer for `rows` (and optionally their splits). */
const snapshotOf = (rows: ReturnType<typeof transactions>, splits: { transaction_id: string; budget_category_id: string; amount: number }[] | null = null) => ({
  kind: 'snapshot',
  snapshot: { transactions: byKey(rows), splits, budgetCategories: null, cardPayments: null },
});

beforeEach(() => {
  vi.resetAllMocks();
});

describe('a frozen read that fits one response: one statement, exactly as before, proven complete', () => {
  it('getTransactionsSince makes ONE request, asks for the exact count, and never touches the snapshot function', async () => {
    const data = transactions(700);
    const table = fakeTable(data, ['date', 'id']);
    mockFrom.mockImplementation((name: string) => table.make(name));

    const rows = await getTransactionsSince('user-1', '2025-09-01', '2026-10-01');

    expect(table.requests).toHaveLength(1); // not two: no terminating empty page any more
    expect(table.requests[0].countOption).toBe('exact');
    expect(rows).toHaveLength(700);
    expect(cents(rows)).toBe(cents(data));
    // The frozen shape, exactly.
    expect(Object.keys(rows[0]).sort()).toEqual(['amount', 'date']);
    expect(mockSnapshot).not.toHaveBeenCalled();
    // The same ownership, exclusion and range filters as before; a deterministic (date, id) order.
    expect(table.requests[0].table).toBe('transactions');
    expect(table.requests[0].filters).toEqual([
      ['eq', 'accounts.plaid_items.user_id', 'user-1'],
      ['eq', 'accounts.exclude_from_cash_flow', false],
      ['gte', 'date', '2025-09-01'],
      ['lt', 'date', '2026-10-01'],
      ['order', 'date', { ascending: true }],
      ['order', 'id', { ascending: true }],
    ]);
  });

  it('a response of exactly the server cap is complete when the count says so', async () => {
    const data = transactions(1000);
    const table = fakeTable(data, ['date', 'id']);
    mockFrom.mockImplementation((name: string) => table.make(name));
    expect(await getTransactionsSince('user-1', '2025-09-01')).toHaveLength(1000);
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('getCategorizedTransactionsSince and getCategorySpendRows behave the same way', async () => {
    const data = transactions(300);
    const txnTable = fakeTable(data, ['date', 'id']);
    const splits = data.slice(0, 20).map((t, i) => ({ id: uuid(5000 + i), transaction_id: t.id, budget_category_id: 'cat-b', amount: t.amount }));
    const splitTable = fakeTable(splits, ['transaction_id', 'id']);
    mockFrom.mockImplementation((name: string) => (name === 'transactions' ? txnTable.make(name) : splitTable.make(name)));

    const categorized = await getCategorizedTransactionsSince('user-1', '2025-09-01');
    expect(Object.keys(categorized[0]).sort()).toEqual(['amount', 'category', 'date']);
    expect(cents(categorized)).toBe(cents(data));

    const spend = await getCategorySpendRows('user-1', { start: '2025-09-01', end: '2026-10-01' });
    expect(Object.keys(spend[0]).sort()).toEqual(['amount', 'budget_category_id']);
    expect(spend).toEqual(categorySpendRowsOf(byKey(data), splits));
    expect(cents(spend)).toBe(cents(data)); // every transaction's whole amount, exactly once
    // Two requests for the spend, as main has always made: transactions, then splits.
    expect(txnTable.requests.map((r) => r.countOption)).toEqual(['exact', 'exact']);
    expect(splitTable.requests.map((r) => r.countOption)).toEqual(['exact']);
    expect(mockSnapshot).not.toHaveBeenCalled();
  });
});

describe('a frozen read beyond one response: one coherent snapshot, never pages', () => {
  it('getTransactionsSince over 2 500 rows: one capped request reveals the count, then ONE snapshot supplies every row', async () => {
    const data = transactions(2500);
    const table = fakeTable(data, ['date', 'id']);
    mockFrom.mockImplementation((name: string) => table.make(name));
    mockSnapshot.mockResolvedValue(snapshotOf(data));

    const rows = await getTransactionsSince('user-1', '2025-09-01');

    expect(table.requests.map((r) => r.returned)).toEqual([1000]); // capped — and recognised as incomplete
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(mockSnapshot).toHaveBeenCalledWith('user-1', { rows: { start: '2025-09-01', end: undefined }, splits: false });
    expect(rows).toHaveLength(2500);
    expect(cents(rows)).toBe(cents(data));
    expect(Object.keys(rows[0]).sort()).toEqual(['amount', 'date']);
    // What the capped request alone would have published: a complete-looking, wrong total.
    expect(cents(byKey(data).slice(0, 1000))).not.toBe(cents(data));
  });

  it('a server cap below 1 000 changes nothing: the count, not the page size, decides completeness', async () => {
    const data = transactions(900);
    const table = fakeTable(data, ['date', 'id'], 400);
    mockFrom.mockImplementation((name: string) => table.make(name));
    mockSnapshot.mockResolvedValue(snapshotOf(data));
    const rows = await getTransactionsSince('user-1', '2025-09-01');
    expect(table.requests[0].returned).toBe(400);
    expect(rows).toHaveLength(900);
    expect(cents(rows)).toBe(cents(data));
  });

  it('getCategorizedTransactionsSince over 2 500 rows keeps its shape', async () => {
    const data = transactions(2500);
    const table = fakeTable(data, ['date', 'id']);
    mockFrom.mockImplementation((name: string) => table.make(name));
    mockSnapshot.mockResolvedValue(snapshotOf(data));
    const rows = await getCategorizedTransactionsSince('user-1', '2025-09-01', '2026-10-01');
    expect(rows).toHaveLength(2500);
    expect(Object.keys(rows[0]).sort()).toEqual(['amount', 'category', 'date']);
    expect(rows.filter((r) => r.category === 'FOOD_AND_DRINK')).toHaveLength(data.filter((r) => r.category === 'FOOD_AND_DRINK').length);
    expect(mockSnapshot).toHaveBeenCalledWith('user-1', { rows: { start: '2025-09-01', end: '2026-10-01' }, splits: false });
  });

  it('getCategorySpendRows: too many transactions → the transactions AND their splits come from one snapshot; the splits are not read separately', async () => {
    const txns = transactions(1500).map((t) => ({ ...t, amount: Math.abs(t.amount) }));
    const splits = txns.slice(0, 400).flatMap((t, i) => {
      const third = Math.round(Math.round(t.amount * 100) / 3) / 100;
      const rest = Math.round((t.amount - 2 * third) * 100) / 100;
      return [
        { id: uuid(100000 + i * 3), transaction_id: t.id, budget_category_id: 'cat-b', amount: third },
        { id: uuid(100001 + i * 3), transaction_id: t.id, budget_category_id: 'cat-c', amount: third },
        { id: uuid(100002 + i * 3), transaction_id: t.id, budget_category_id: 'cat-d', amount: rest },
      ];
    });
    const txnTable = fakeTable(txns, ['date', 'id']);
    const splitTable = fakeTable(splits, ['transaction_id', 'id']);
    mockFrom.mockImplementation((name: string) => (name === 'transactions' ? txnTable.make(name) : splitTable.make(name)));
    mockSnapshot.mockResolvedValue(snapshotOf(txns, splits));

    const rows = await getCategorySpendRows('user-1', { start: '2025-09-01', end: '2026-10-01' });

    expect(txnTable.requests).toHaveLength(1);
    expect(splitTable.requests).toHaveLength(0);
    expect(mockSnapshot).toHaveBeenCalledWith('user-1', { rows: { start: '2025-09-01', end: '2026-10-01' }, splits: true });
    expect(rows).toHaveLength(1100 + 1200);
    expect(cents(rows)).toBe(cents(txns));
    const spend = aggregateSpendByCategory(rows);
    expect(Math.round((spend.get('cat-a') ?? 0) * 100)).toBe(cents(txns.slice(400).filter((t) => t.budget_category_id === 'cat-a')));
  });

  it('getCategorySpendRows: the transactions fit but the splits do not → still one snapshot of both', async () => {
    const txns = transactions(500).map((t) => ({ ...t, amount: Math.abs(t.amount) }));
    const splits = txns.slice(0, 400).flatMap((t, i) =>
      [0, 1, 2].map((k) => ({ id: uuid(200000 + i * 3 + k), transaction_id: t.id, budget_category_id: 'cat-b', amount: Math.round((t.amount / 3) * 100) / 100 }))
    );
    const txnTable = fakeTable(txns, ['date', 'id']);
    const splitTable = fakeTable(splits, ['transaction_id', 'id']);
    mockFrom.mockImplementation((name: string) => (name === 'transactions' ? txnTable.make(name) : splitTable.make(name)));
    mockSnapshot.mockResolvedValue(snapshotOf(txns, splits));
    const rows = await getCategorySpendRows('user-1', { start: '2025-09-01', end: '2026-10-01' });
    expect(splitTable.requests.map((r) => r.returned)).toEqual([1000]);
    expect(mockSnapshot).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(100 + 1200);
  });
});

describe('a frozen read fails closed — never truncated, never assembled from several states', () => {
  it.each(['objects_missing', 'timeout', 'request_failed', 'request_error', 'unexpected_response'])(
    'beyond one response with the snapshot function unusable (%s): the read is refused',
    async (reason) => {
      const data = transactions(2500);
      const table = fakeTable(data, ['date', 'id']);
      mockFrom.mockImplementation((name: string) => table.make(name));
      mockSnapshot.mockResolvedValue({ kind: 'unavailable', reason });
      for (const read of [
        () => getTransactionsSince('user-1', '2025-09-01'),
        () => getCategorizedTransactionsSince('user-1', '2025-09-01'),
        () => getCategorySpendRows('user-1', { start: '2025-09-01', end: '2026-10-01' }),
      ]) {
        const error = await read().then(
          () => null,
          (err: unknown) => err
        );
        expect(error).toBeInstanceOf(AggregateSnapshotUnavailableError);
        expect(error).toMatchObject({ code: 'aggregate_snapshot_unavailable', reason });
      }
    }
  );

  it('the same database serves a range that fits one response normally — released clients are unaffected', async () => {
    const table = fakeTable(transactions(300), ['date', 'id']);
    mockFrom.mockImplementation((name: string) => table.make(name));
    mockSnapshot.mockResolvedValue({ kind: 'unavailable', reason: 'objects_missing' });
    expect(await getTransactionsSince('user-1', '2025-09-01')).toHaveLength(300);
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('a response with no count cannot be shown to be complete, so it is refused', async () => {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gte', 'lt', 'order']) builder[method] = vi.fn(() => builder);
    builder.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve({ data: [{ amount: 1, date: '2026-09-01' }], error: null, count: null }).then(onFulfilled);
    mockFrom.mockReturnValue(builder);
    await expect(getTransactionsSince('user-1', '2026-09-01')).rejects.toThrow(/row count was not returned/);
    expect(mockSnapshot).not.toHaveBeenCalled();
  });

  it('a request error and a range beyond the snapshot limits both propagate — no partial rows', async () => {
    const builder: Record<string, unknown> = {};
    for (const method of ['select', 'eq', 'gte', 'lt', 'order']) builder[method] = vi.fn(() => builder);
    builder.then = (onFulfilled: (value: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'connection reset' }, count: null }).then(onFulfilled);
    mockFrom.mockReturnValue(builder);
    await expect(getTransactionsSince('user-1', '2026-09-01')).rejects.toThrow('Failed to load transaction history: connection reset');

    const table = fakeTable(transactions(2500), ['date', 'id']);
    mockFrom.mockImplementation((name: string) => table.make(name));
    mockSnapshot.mockRejectedValue(new AggregateTooLargeError('the financial snapshot', 'holds 10001 transactions'));
    await expect(getTransactionsSince('user-1', '2025-09-01')).rejects.toMatchObject({ code: 'aggregate_too_large' });
  });

  it('transactions and splits are never keyset-paged (the fake refuses a keyset filter)', async () => {
    const data = transactions(2500);
    const table = fakeTable(data, ['date', 'id']);
    mockFrom.mockImplementation((name: string) => table.make(name));
    mockSnapshot.mockResolvedValue(snapshotOf(data));
    await getTransactionsSince('user-1', '2025-09-01');
    await getCategorizedTransactionsSince('user-1', '2025-09-01');
    expect(table.requests.every((r) => r.filters.every((f) => f[0] !== 'gt'))).toBe(true);
  });
});

describe('getNetWorthHistory — independent daily facts', () => {
  const snapshots = (count: number) =>
    Array.from({ length: count }, (_, i) => {
      const day = new Date(Date.UTC(2023, 0, 1));
      day.setUTCDate(day.getUTCDate() + i);
      return { date: day.toISOString().slice(0, 10), net_worth: i, total_assets: i + 10, total_liabilities: 10 };
    });

  it('a history that fits one response is ONE request, proven complete by its count', async () => {
    const data = snapshots(400);
    const table = fakeTable(data, ['date']);
    mockFrom.mockImplementation((name: string) => table.make(name));
    expect(await getNetWorthHistory('user-1', '2023-01-01', '2024-06-01')).toEqual(data);
    expect(table.requests).toHaveLength(1);
    expect(table.requests[0].countOption).toBe('exact');
    expect(table.requests[0].filters).toContainEqual(['eq', 'user_id', 'user-1']);
  });

  it('1 200 daily snapshots: keyset pages by date return every one (rows are independent — one per date — so pages cannot double count)', async () => {
    const data = snapshots(1200);
    const table = fakeTable(data, ['date']);
    mockFrom.mockImplementation((name: string) => table.make(name));
    expect(await getNetWorthHistory('user-1', '2023-01-01')).toEqual(data);
    // The counted request, then pages to an empty one.
    expect(table.requests.map((r) => r.returned)).toEqual([1000, 1000, 200, 0]);
    expect(table.requests[2].filters).toContainEqual(['gt', 'date', data[999].date]);
    expect(mockSnapshot).not.toHaveBeenCalled();
  });
});
