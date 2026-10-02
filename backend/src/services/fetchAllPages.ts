/**
 * Financial Semantics Phase B — complete keyset-paged fetches for aggregates
 * (FINANCIAL_SEMANTICS_PHASE_B_DESIGN.md §7.4, invariant I7: no aggregate is computed from a
 * truncated fetch).
 *
 * NOT WIRED INTO ANY LIVE QUERY YET (implementation slice 1). Today's aggregate fetches
 * (`getTransactionsSince`, `getCategorizedTransactionsSince`, `getCategorySpendRows`,
 * `getNetWorthHistory`) issue one request with no paging, and Supabase/PostgREST caps a response at
 * its `max-rows` setting (1 000 by default) — so a large enough range silently yields a
 * complete-looking but truncated total. A later slice routes those fetches through this helper.
 *
 * Design: keyset (never OFFSET) pagination over a strictly increasing key, one page at a time:
 *
 *  - The caller supplies `fetchPage(after, limit)`, which must return rows ordered by the key,
 *    ascending, strictly after `after` (null = from the beginning), at most `limit` of them. The
 *    `…KeysetFilter` builders below produce the PostgREST `or` filter for the two key shapes the
 *    design names: `(date, id)` for transactions and `(transaction_id, id)` for splits.
 *  - The loop stops only on an EMPTY page. Deliberately not on a "short" page (fewer rows than
 *    requested), as an earlier design sketch said (§7.4 now agrees, §13 Q5): if the server's own row cap is lower than the
 *    page size we ask for, every page is short, and stopping on the first one would re-create the
 *    exact silent truncation this helper exists to remove. The cost is one extra, empty request.
 *  - It verifies the key strictly increases across every row it receives (a mis-ordered query would
 *    otherwise skip or repeat rows) and fails if it does not.
 *  - A hard page ceiling fails the request with `AggregateTooLargeError` rather than returning a
 *    partial result.
 */

export class AggregateTooLargeError extends Error {
  readonly code = 'aggregate_too_large';
  constructor(label: string, maxPages: number, pageSize: number) {
    super(`aggregate_too_large: ${label} exceeded ${maxPages} pages of ${pageSize} rows; refusing to return a partial result`);
  }
}

/** The query returned rows out of key order, or re-returned a key — paging it would skip or repeat
 *  rows, so the result is refused instead. */
export class KeysetOrderError extends Error {}

export interface FetchAllPagesOptions<Row, Key> {
  /** Names the fetch in errors (never includes row data). */
  label: string;
  /** Returns up to `limit` rows strictly after `after` (null: from the start), ascending by key. */
  fetchPage: (after: Key | null, limit: number) => Promise<Row[]>;
  keyOf: (row: Row) => Key;
  /** Total order on keys: negative when a < b. */
  compareKeys: (a: Key, b: Key) => number;
  /** Rows requested per page. Default 1 000 (PostgREST's default `max-rows`). */
  pageSize?: number;
  /** Hard ceiling on non-empty pages. Default 200 (200 000 rows at the default page size). */
  maxPages?: number;
}

export const DEFAULT_PAGE_SIZE = 1000;
export const DEFAULT_MAX_PAGES = 200;

export async function fetchAllPages<Row, Key>(options: FetchAllPagesOptions<Row, Key>): Promise<Row[]> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  if (!Number.isInteger(pageSize) || pageSize <= 0) throw new RangeError('pageSize must be a positive integer');
  if (!Number.isInteger(maxPages) || maxPages <= 0) throw new RangeError('maxPages must be a positive integer');

  const all: Row[] = [];
  let after: Key | null = null;
  for (let page = 0; ; page++) {
    const rows = await options.fetchPage(after, pageSize);
    if (rows.length === 0) return all;
    if (page >= maxPages) throw new AggregateTooLargeError(options.label, maxPages, pageSize);
    if (rows.length > pageSize) {
      throw new KeysetOrderError(`${options.label}: a page returned ${rows.length} rows, more than the ${pageSize} requested`);
    }
    for (const row of rows) {
      const key = options.keyOf(row);
      if (after !== null && options.compareKeys(key, after) <= 0) {
        throw new KeysetOrderError(`${options.label}: keyset did not strictly increase; refusing a result that could skip or repeat rows`);
      }
      after = key;
      all.push(row);
    }
  }
}

// ---- Key shapes ------------------------------------------------------------------------------

/** `(date, id)` — transactions, ascending. */
export interface DateIdKey {
  date: string;
  id: string;
}

/** `(transaction_id, id)` — transaction splits, ascending. */
export interface TransactionIdIdKey {
  transactionId: string;
  id: string;
}

/**
 * Orders keys the way PostgreSQL orders them for these columns: `date` (YYYY-MM-DD) and `uuid`
 * values compare correctly as plain strings only when both are canonical — lower-case, fixed-width
 * — which is how PostgREST serialises them. Byte order, not locale order.
 */
function compareCanonical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareDateIdKeys(a: DateIdKey, b: DateIdKey): number {
  return compareCanonical(a.date, b.date) || compareCanonical(a.id, b.id);
}

export function compareTransactionIdIdKeys(a: TransactionIdIdKey, b: TransactionIdIdKey): number {
  return compareCanonical(a.transactionId, b.transactionId) || compareCanonical(a.id, b.id);
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function assertDate(value: string, what: string): void {
  if (!DATE.test(value)) throw new RangeError(`${what} must be a YYYY-MM-DD date`);
}

function assertUuid(value: string, what: string): void {
  // Also guards the filter string: nothing but hex digits and dashes can reach it.
  if (!UUID.test(value)) throw new RangeError(`${what} must be a canonical lower-case uuid`);
}

/**
 * PostgREST `or` filter selecting rows strictly after `after` in `(date, id)` order:
 * `date > d OR (date = d AND id > i)`. Use with `.order('date').order('id')` and `.limit(n)`.
 * Returns null for the first page (no filter).
 */
export function dateIdKeysetFilter(after: DateIdKey | null): string | null {
  if (after === null) return null;
  assertDate(after.date, 'keyset date');
  assertUuid(after.id, 'keyset id');
  return `date.gt.${after.date},and(date.eq.${after.date},id.gt.${after.id})`;
}

/** The same for splits in `(transaction_id, id)` order. */
export function transactionIdIdKeysetFilter(after: TransactionIdIdKey | null): string | null {
  if (after === null) return null;
  assertUuid(after.transactionId, 'keyset transaction_id');
  assertUuid(after.id, 'keyset id');
  return `transaction_id.gt.${after.transactionId},and(transaction_id.eq.${after.transactionId},id.gt.${after.id})`;
}
