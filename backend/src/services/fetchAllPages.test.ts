import { describe, expect, it, vi } from 'vitest';
import {
  AggregateTooLargeError,
  compareDateIdKeys,
  compareTransactionIdIdKeys,
  dateIdKeysetFilter,
  fetchAllPages,
  KeysetOrderError,
  transactionIdIdKeysetFilter,
  type DateIdKey,
  type TransactionIdIdKey,
} from './fetchAllPages';
import { aggregateCashFlow, type AggregationTransaction } from './semanticAggregation';

// Financial Semantics Phase B, slice 1: the internal pagination helper (design §7.4, invariant I7).
// The fake server below behaves like PostgREST for these queries: it applies the helper's own `or`
// keyset filter string, orders ascending, honours `limit`, and silently caps every response at its
// `max-rows` — the behaviour that makes today's single-request aggregate fetches truncate.

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

type TxnRow = {
  id: string;
  date: string;
  amount: number;
};
type SplitRow = {
  id: string;
  transaction_id: string;
  amount: number;
};

/** Evaluates exactly the filter shapes the builders emit: `col1.gt.V,and(col1.eq.V,col2.gt.W)`. */
function evaluateKeysetFilter(filter: string | null, row: Record<string, string>): boolean {
  if (filter === null) return true;
  const m = /^(\w+)\.gt\.([^,]+),and\((\w+)\.eq\.([^,]+),(\w+)\.gt\.([^)]+)\)$/.exec(filter);
  if (!m) throw new Error(`fake server cannot parse filter ${filter}`);
  const [, c1, v1, c1b, v1b, c2, v2] = m;
  if (c1 !== c1b || v1 !== v1b) throw new Error('malformed keyset filter');
  return row[c1] > v1 || (row[c1] === v1 && row[c2] > v2);
}

function fakeServer<Row extends Record<string, unknown>>(rows: Row[], sortKeys: (keyof Row)[], maxRows: number) {
  const sorted = [...rows].sort((a, b) => {
    for (const k of sortKeys) {
      const av = String(a[k]);
      const bv = String(b[k]);
      if (av !== bv) return av < bv ? -1 : 1;
    }
    return 0;
  });
  const requests: { filter: string | null; limit: number; returned: number }[] = [];
  return {
    requests,
    query(filter: string | null, limit: number): Row[] {
      const matching = sorted.filter((r) => evaluateKeysetFilter(filter, r as unknown as Record<string, string>));
      const page = matching.slice(0, Math.min(limit, maxRows));
      requests.push({ filter, limit, returned: page.length });
      return page;
    },
  };
}

function transactions(count: number): TxnRow[] {
  // Many rows share a date, so the id tiebreak is exercised at every page boundary.
  return Array.from({ length: count }, (_, i) => ({
    id: uuid(i + 1),
    date: `2026-${String(1 + (i % 9)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`,
    amount: 1 + (i % 7),
  }));
}

function fetchTransactions(server: ReturnType<typeof fakeServer<TxnRow>>, pageSize?: number) {
  return fetchAllPages<TxnRow, DateIdKey>({
    label: 'transactions',
    fetchPage: async (after, limit) => server.query(dateIdKeysetFilter(after), limit),
    keyOf: (r) => ({ date: r.date, id: r.id }),
    compareKeys: compareDateIdKeys,
    pageSize,
  });
}

describe('fetchAllPages — complete results beyond the server response limit', () => {
  it('2 500 transactions behind a 1 000-row cap: all rows, once each, in key order', async () => {
    const data = transactions(2500);
    const server = fakeServer(data, ['date', 'id'], 1000);
    const rows = await fetchTransactions(server);

    expect(rows).toHaveLength(2500);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2500);
    for (let i = 1; i < rows.length; i++) {
      expect(compareDateIdKeys({ date: rows[i - 1].date, id: rows[i - 1].id }, { date: rows[i].date, id: rows[i].id })).toBeLessThan(0);
    }
    expect(server.requests.map((r) => r.returned)).toEqual([1000, 1000, 500, 0]);
  });

  it('a server cap BELOW the page size (every page "short") still returns everything — the short-page trap', async () => {
    const data = transactions(2500);
    const server = fakeServer(data, ['date', 'id'], 400);
    const rows = await fetchTransactions(server, 1000);
    expect(rows).toHaveLength(2500);
    // A loop that stopped on the first page shorter than requested would have returned 400 rows.
    expect(server.requests[0].returned).toBe(400);
    expect(server.requests.at(-1)!.returned).toBe(0);
  });

  it('an aggregate over the paged rows equals the true total; the single-request fetch it replaces would be truncated', async () => {
    const data = transactions(2500);
    const trueTotal = data.reduce((s, r) => s + r.amount * 100, 0) / 100;
    const toAggregationRow = (r: TxnRow): AggregationTransaction => ({
      id: r.id,
      accountId: 'acct',
      date: r.date,
      amount: r.amount,
      plaidCategory: 'GENERAL_MERCHANDISE',
      budgetCategoryId: null,
      effectiveRole: 'expense',
      userRoleOverride: null,
      manualLoanId: null,
      principalPortion: null,
    });
    const accounts = [{ id: 'acct', type: 'depository', excludeFromCashFlow: false }];

    const paged = await fetchTransactions(fakeServer(data, ['date', 'id'], 1000));
    expect(aggregateCashFlow({ accounts, transactions: paged.map(toAggregationRow) }).spending).toBe(trueTotal);

    const singleRequest = fakeServer(data, ['date', 'id'], 1000).query(null, 100000);
    expect(singleRequest).toHaveLength(1000);
    expect(aggregateCashFlow({ accounts, transactions: singleRequest.map(toAggregationRow) }).spending).toBeLessThan(trueTotal);
  });

  it('1 200 splits keyed (transaction_id, id), several per transaction straddling page boundaries', async () => {
    const splits: SplitRow[] = Array.from({ length: 1200 }, (_, i) => ({
      id: uuid(10000 + i),
      transaction_id: uuid(1 + Math.floor(i / 3)), // three splits per parent
      amount: 1,
    }));
    const server = fakeServer(splits, ['transaction_id', 'id'], 1000);
    const rows = await fetchAllPages<SplitRow, TransactionIdIdKey>({
      label: 'splits',
      fetchPage: async (after, limit) => server.query(transactionIdIdKeysetFilter(after), limit),
      keyOf: (r) => ({ transactionId: r.transaction_id, id: r.id }),
      compareKeys: compareTransactionIdIdKeys,
    });
    expect(rows).toHaveLength(1200);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1200);
    expect(server.requests.map((r) => r.returned)).toEqual([1000, 200, 0]);
  });

  it('an empty table is one request and an empty result', async () => {
    const server = fakeServer<TxnRow>([], ['date', 'id'], 1000);
    await expect(fetchTransactions(server)).resolves.toEqual([]);
    expect(server.requests).toHaveLength(1);
  });
});

describe('fetchAllPages — refuses partial or unsafe results', () => {
  it('exceeding the page ceiling fails with aggregate_too_large instead of returning a partial result', async () => {
    const server = fakeServer(transactions(500), ['date', 'id'], 100);
    const run = fetchAllPages<TxnRow, DateIdKey>({
      label: 'transactions',
      fetchPage: async (after, limit) => server.query(dateIdKeysetFilter(after), limit),
      keyOf: (r) => ({ date: r.date, id: r.id }),
      compareKeys: compareDateIdKeys,
      pageSize: 100,
      maxPages: 3,
    });
    await expect(run).rejects.toBeInstanceOf(AggregateTooLargeError);
    await expect(
      fetchAllPages<TxnRow, DateIdKey>({
        label: 'transactions',
        fetchPage: async (after, limit) => server.query(dateIdKeysetFilter(after), limit),
        keyOf: (r) => ({ date: r.date, id: r.id }),
        compareKeys: compareDateIdKeys,
        pageSize: 100,
        maxPages: 3,
      })
    ).rejects.toMatchObject({ code: 'aggregate_too_large' });
  });

  it('exactly the ceiling\'s worth of rows is still returned in full', async () => {
    const server = fakeServer(transactions(300), ['date', 'id'], 100);
    const rows = await fetchAllPages<TxnRow, DateIdKey>({
      label: 'transactions',
      fetchPage: async (after, limit) => server.query(dateIdKeysetFilter(after), limit),
      keyOf: (r) => ({ date: r.date, id: r.id }),
      compareKeys: compareDateIdKeys,
      pageSize: 100,
      maxPages: 3,
    });
    expect(rows).toHaveLength(300);
  });

  it('a query that ignores the keyset (returns the same page again) is refused, not looped or duplicated', async () => {
    const firstPage = transactions(1000);
    const fetchPage = vi.fn(async () => firstPage);
    await expect(
      fetchAllPages<TxnRow, DateIdKey>({
        label: 'transactions',
        fetchPage,
        keyOf: (r) => ({ date: r.date, id: r.id }),
        compareKeys: compareDateIdKeys,
      })
    ).rejects.toBeInstanceOf(KeysetOrderError);
    expect(fetchPage).toHaveBeenCalledTimes(1); // the unordered first page is itself rejected
  });

  it('a page larger than requested is refused', async () => {
    const data = transactions(20).sort((a, b) => compareDateIdKeys(a, b));
    await expect(
      fetchAllPages<TxnRow, DateIdKey>({
        label: 'transactions',
        fetchPage: async () => data,
        keyOf: (r) => ({ date: r.date, id: r.id }),
        compareKeys: compareDateIdKeys,
        pageSize: 10,
      })
    ).rejects.toBeInstanceOf(KeysetOrderError);
  });

  it('rejects a non-positive page size or ceiling', async () => {
    const base = {
      label: 'x',
      fetchPage: async () => [] as TxnRow[],
      keyOf: (r: TxnRow) => ({ date: r.date, id: r.id }),
      compareKeys: compareDateIdKeys,
    };
    await expect(fetchAllPages({ ...base, pageSize: 0 })).rejects.toBeInstanceOf(RangeError);
    await expect(fetchAllPages({ ...base, maxPages: -1 })).rejects.toBeInstanceOf(RangeError);
  });
});

describe('keyset filter builders', () => {
  it('produce the PostgREST `or` filter for strictly-after, and null for the first page', () => {
    expect(dateIdKeysetFilter(null)).toBeNull();
    expect(dateIdKeysetFilter({ date: '2026-09-10', id: uuid(5) })).toBe(
      `date.gt.2026-09-10,and(date.eq.2026-09-10,id.gt.${uuid(5)})`
    );
    expect(transactionIdIdKeysetFilter({ transactionId: uuid(1), id: uuid(2) })).toBe(
      `transaction_id.gt.${uuid(1)},and(transaction_id.eq.${uuid(1)},id.gt.${uuid(2)})`
    );
  });

  it('reject anything that is not a canonical date / lower-case uuid — nothing else can reach the filter string', () => {
    expect(() => dateIdKeysetFilter({ date: '2026-9-1', id: uuid(1) })).toThrow(RangeError);
    expect(() => dateIdKeysetFilter({ date: '2026-09-01', id: `${uuid(1)},id.gt.0` })).toThrow(RangeError);
    expect(() => dateIdKeysetFilter({ date: '2026-09-01', id: uuid(0xabcdef).toUpperCase() })).toThrow(RangeError);
    expect(() => transactionIdIdKeysetFilter({ transactionId: 'x)', id: uuid(1) })).toThrow(RangeError);
  });

  it('key comparison is byte order, with the id breaking date ties', () => {
    expect(compareDateIdKeys({ date: '2026-09-01', id: uuid(9) }, { date: '2026-09-02', id: uuid(1) })).toBeLessThan(0);
    expect(compareDateIdKeys({ date: '2026-09-01', id: uuid(1) }, { date: '2026-09-01', id: uuid(2) })).toBeLessThan(0);
    expect(compareDateIdKeys({ date: '2026-09-01', id: uuid(2) }, { date: '2026-09-01', id: uuid(2) })).toBe(0);
  });
});
