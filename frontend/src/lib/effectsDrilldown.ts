import { EFFECTS_RESTART_REQUIRED, type EffectsQuery } from './api';
import { toCents, type EffectRow, type EffectsResponse } from './semanticModel';
import { UPDATING_REFETCH_MAX_ATTEMPTS, updatingRefetchDelayMs } from './updatingRefetch';

/**
 * Financial Semantics Phase B, integration slice I2 — loading one drill-down from
 * `GET /api/plaid/transactions/effects` (design §7.3; PHASE_B_I1_BACKEND_READ_PATH.md §3).
 *
 * The server decides what the result is. This loader only accumulates the pages of ONE result and
 * checks that what it accumulated is that result:
 * - rows are appended in the server's order, with the server's signed `effect_amount`; nothing is
 *   filtered or re-signed here;
 * - the total and the count shown are the server's `total_amount` / `total_count`, never the sum of
 *   the rows loaded so far;
 * - a continuation the server refuses with `effects_restart_required` discards every accumulated
 *   row at once and starts again from page 1, a bounded number of times;
 * - when the last page arrives, the rows must number `total_count` and sum, in integer cents, to
 *   `total_amount`. Anything else is a client-side integrity failure and nothing is listed;
 * - an `updating` answer lists nothing and is asked again automatically, a bounded number of times,
 *   after the server's hint (lib/updatingRefetch.ts). `unavailable` and every failure wait for the
 *   user.
 *
 * There is no second consistency mechanism here: whether two pages describe one result is the
 * server's fingerprint check, and this loader acts on its answer.
 */

export const EFFECTS_PAGE_LIMIT = 50;
/** How many times one load may start over because the result changed, before it stops and asks. */
export const EFFECTS_MAX_RESTARTS = 2;

export type EffectsFailure =
  /** The request failed. `code` is the server's code when it sent one. */
  | { kind: 'request_failed'; code: string | null; status: number | null }
  /** The result changed on every attempt, up to the restart limit. */
  | { kind: 'kept_changing' }
  /** The response was not the reviewed shape. */
  | { kind: 'malformed' }
  /** The pages did not add up to the total they declared. */
  | { kind: 'not_reconciled' };

export type EffectsDrilldownState =
  /** Page 1 is being requested; nothing is listed. `restarting` after the server refused a continuation. */
  | { phase: 'loading'; restarting: boolean }
  | {
      phase: 'ready';
      rows: EffectRow[];
      /** The server's complete total for the bucket, in integer cents. */
      totalCents: number;
      totalCount: number;
      /** Σ `effect_amount` of the rows loaded so far, in integer cents. Equal to `totalCents` once complete. */
      loadedCents: number;
      nextCursor: string | null;
      loadingMore: boolean;
    }
  /** `autoRetrying`: another automatic refetch is scheduled or in flight. */
  | { phase: 'updating'; reason: string; autoRetrying: boolean }
  | { phase: 'unavailable'; reason: string }
  | { phase: 'failed'; failure: EffectsFailure };

export type FetchEffectsPage = (cursor: string | null, signal: AbortSignal) => Promise<EffectsResponse>;

export interface EffectsLoader {
  getState(): EffectsDrilldownState;
  subscribe(listener: () => void): () => void;
  /** Requests page 1, discarding anything loaded. Also the user's "Try again". */
  start(): void;
  /** Requests the next page of the result being shown. Ignored unless one is available and idle. */
  loadMore(): void;
  /** Aborts whatever is in flight; no later response changes the state. */
  dispose(): void;
}

/** A stable identity for a query: a different key is a different drill-down. */
export function effectsQueryKey(query: EffectsQuery): string {
  const bucket =
    query.measure === 'spending' && query.bucket
      ? query.bucket.kind === 'budget_category'
        ? `budget:${query.bucket.id ?? ''}`
        : `plaid:${query.bucket.category}`
      : '';
  return [query.start, query.end, query.measure, bucket].join('|');
}

export function createEffectsLoader(fetchPage: FetchEffectsPage): EffectsLoader {
  let state: EffectsDrilldownState = { phase: 'loading', restarting: false };
  const listeners = new Set<() => void>();
  // Every request belongs to a generation; a response of an older generation is dropped.
  let generation = 0;
  let controller: AbortController | null = null;
  let restarts = 0;
  // Automatic refetches after an `updating` answer, within the current load.
  let updatingRefetches = 0;
  let updatingTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  // The transactions listed on the pages accumulated so far.
  const seen = new Set<string>();

  function set(next: EffectsDrilldownState) {
    state = next;
    for (const listener of Array.from(listeners)) listener();
  }

  function fail(failure: EffectsFailure) {
    seen.clear();
    set({ phase: 'failed', failure });
  }

  function accept(page: Extract<EffectsResponse, { kind: 'ok' }>, cursor: string | null) {
    const totalCents = toCents(page.total_amount);
    const previous = cursor !== null && state.phase === 'ready' ? state : null;
    if (cursor !== null && !previous) return; // a continuation of a result no longer shown
    // Every page of one result declares the same complete total.
    if (previous && (previous.totalCents !== totalCents || previous.totalCount !== page.total_count)) return fail({ kind: 'not_reconciled' });
    if (!previous) seen.clear();

    // The server returns all effects of one transaction together, so a transaction that already
    // appeared on an EARLIER page would be a repeated row: the pages are then not one result.
    let loadedCents = previous ? previous.loadedCents : 0;
    const inThisPage = new Set<string>();
    for (const row of page.rows) {
      if (seen.has(row.transaction.id)) return fail({ kind: 'not_reconciled' });
      inThisPage.add(row.transaction.id);
      loadedCents += toCents(row.effect_amount);
    }
    for (const id of inThisPage) seen.add(id);
    const rows = previous ? [...previous.rows, ...page.rows] : page.rows;

    if (rows.length > page.total_count) return fail({ kind: 'not_reconciled' });
    if (page.next_cursor === null) {
      // Complete: the rows must be exactly the result the total describes.
      if (rows.length !== page.total_count || loadedCents !== totalCents) return fail({ kind: 'not_reconciled' });
    } else if (page.rows.length === 0 || page.next_cursor === cursor) {
      // A continuation that makes no progress would be asked for again forever.
      return fail({ kind: 'not_reconciled' });
    }
    set({ phase: 'ready', rows, totalCents, totalCount: page.total_count, loadedCents, nextCursor: page.next_cursor, loadingMore: false });
  }

  function cancelUpdatingRefetch() {
    if (updatingTimer !== null) clearTimeout(updatingTimer);
    updatingTimer = null;
  }

  async function request(cursor: string | null) {
    const mine = ++generation;
    // Whatever asks now supersedes a wait that was pending: one request, or one timer, at a time.
    cancelUpdatingRefetch();
    controller?.abort();
    const own = new AbortController();
    controller = own;
    let response: EffectsResponse;
    try {
      response = await fetchPage(cursor, own.signal);
    } catch (err) {
      if (disposed || mine !== generation) return;
      const { code, status } = (err ?? {}) as { code?: unknown; status?: unknown };
      if (code === EFFECTS_RESTART_REQUIRED) {
        // The pages already loaded no longer describe one result: drop them before anything else,
        // so they are never shown beside a newer total.
        seen.clear();
        if (restarts >= EFFECTS_MAX_RESTARTS) return fail({ kind: 'kept_changing' });
        restarts += 1;
        set({ phase: 'loading', restarting: true });
        void request(null);
        return;
      }
      return fail({ kind: 'request_failed', code: typeof code === 'string' ? code : null, status: typeof status === 'number' ? status : null });
    }
    if (disposed || mine !== generation) return;
    switch (response.kind) {
      case 'ok':
        return accept(response, cursor);
      case 'updating': {
        // No rows and no total came with this answer, so none stay on screen. The read is repeated
        // after the server's hint, a bounded number of times; the state stays `updating` meanwhile.
        seen.clear();
        const autoRetrying = updatingRefetches < UPDATING_REFETCH_MAX_ATTEMPTS;
        set({ phase: 'updating', reason: response.reason, autoRetrying });
        if (autoRetrying) {
          updatingTimer = setTimeout(() => {
            updatingTimer = null;
            if (disposed) return;
            updatingRefetches += 1;
            void request(null);
          }, updatingRefetchDelayMs(response.retryAfterMs));
        }
        return;
      }
      case 'unavailable':
        // Nothing is established about this list, and nothing is retried automatically.
        seen.clear();
        return set({ phase: 'unavailable', reason: response.reason });
      case 'invalid':
        return fail({ kind: 'malformed' });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start() {
      if (disposed) return;
      restarts = 0;
      updatingRefetches = 0;
      seen.clear();
      set({ phase: 'loading', restarting: false });
      void request(null);
    },
    loadMore() {
      if (disposed || state.phase !== 'ready' || state.loadingMore || state.nextCursor === null) return;
      const cursor = state.nextCursor;
      set({ ...state, loadingMore: true });
      void request(cursor);
    },
    dispose() {
      disposed = true;
      generation += 1;
      cancelUpdatingRefetch();
      controller?.abort();
      listeners.clear();
    },
  };
}
