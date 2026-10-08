import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// lib/api.ts reads Supabase and the build environment at import; only its constants and types are
// needed here.
vi.mock('./supabaseClient', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

import { EFFECTS_RESTART_REQUIRED } from './api';
import {
  createEffectsLoader,
  effectsQueryKey,
  EFFECTS_MAX_RESTARTS,
  type EffectsDrilldownState,
  type FetchEffectsPage,
} from './effectsDrilldown';
import { readEffectsResponse, type EffectsResponse } from './semanticModel';
import { UPDATING_REFETCH_MAX_ATTEMPTS, UPDATING_REFETCH_MIN_DELAY_MS } from './updatingRefetch';
import { effectRowWire, effectsPageWire } from '../testUtils/semanticFixtures';

// Financial Semantics Phase B, integration slice I2 — the drill-down continuation contract
// (PHASE_B_I1_BACKEND_READ_PATH.md §3): pages of ONE result are accumulated, a refused continuation
// discards them and restarts from page 1 a bounded number of times, and a completed list must be
// the result its total describes, in integer cents.

const page = (amounts: number[], totals: { total_amount: number; total_count: number }, next: string | null = null): EffectsResponse =>
  readEffectsResponse(
    effectsPageWire(
      amounts.map((effect_amount) => effectRowWire({ effect_amount })),
      totals,
      next
    )
  );

const restartRequired = () =>
  Object.assign(new Error('The transactions behind this list changed'), { code: EFFECTS_RESTART_REQUIRED, reason: 'snapshot_changed', status: 409 });

/** A fetcher whose every call is held until the test settles it, so interleavings are explicit. */
function controlledFetcher() {
  const calls: { cursor: string | null; signal: AbortSignal; resolve: (r: EffectsResponse) => void; reject: (e: unknown) => void }[] = [];
  const fetchPage: FetchEffectsPage = (cursor, signal) =>
    new Promise<EffectsResponse>((resolve, reject) => {
      calls.push({ cursor, signal, resolve, reject });
    });
  return { calls, fetchPage };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function ready(state: EffectsDrilldownState) {
  if (state.phase !== 'ready') throw new Error(`expected ready, got ${state.phase}`);
  return state;
}

describe('the first page', () => {
  it('requests page 1 with no cursor and shows the server total, not the loaded subtotal', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    expect(loader.getState()).toEqual({ phase: 'loading', restarting: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].cursor).toBeNull();

    calls[0].resolve(page([1240], { total_amount: 2980.5, total_count: 120 }, 'c1'));
    await settle();
    const state = ready(loader.getState());
    expect(state.rows).toHaveLength(1);
    expect(state.totalCents).toBe(298050);
    expect(state.totalCount).toBe(120);
    expect(state.loadedCents).toBe(124000);
    expect(state.nextCursor).toBe('c1');
  });

  it('notifies subscribers on every change, and not after dispose', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    const listener = vi.fn();
    loader.subscribe(listener);
    loader.start();
    expect(listener).toHaveBeenCalledTimes(1);
    loader.dispose();
    calls[0].resolve(page([10], { total_amount: 10, total_count: 1 }));
    await settle();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(loader.getState().phase).toBe('loading');
  });
});

describe('paging', () => {
  it('appends the next page in server order, using the server cursor, without changing the total', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    calls[0].resolve(page([30, 20], { total_amount: 60, total_count: 3 }, 'cursor-after-2'));
    await settle();

    loader.loadMore();
    expect(ready(loader.getState()).loadingMore).toBe(true);
    // The rows already loaded stay listed while the next page is requested.
    expect(ready(loader.getState()).rows).toHaveLength(2);
    expect(calls[1].cursor).toBe('cursor-after-2');

    calls[1].resolve(page([10], { total_amount: 60, total_count: 3 }, null));
    await settle();
    const state = ready(loader.getState());
    expect(state.rows.map((r) => r.effect_amount)).toEqual([30, 20, 10]);
    expect(state.loadedCents).toBe(6000);
    expect(state.totalCents).toBe(6000);
    expect(state.nextCursor).toBeNull();
    expect(state.loadingMore).toBe(false);
  });

  it('keeps signed amounts as the server sent them: a negative row is listed and subtracts', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    calls[0].resolve(page([60, -60], { total_amount: 0, total_count: 2 }));
    await settle();
    const state = ready(loader.getState());
    expect(state.rows.map((r) => r.effect_amount)).toEqual([60, -60]);
    expect(state.loadedCents).toBe(0);
  });

  it('ignores Load more while a page is in flight, when complete, and before the first page', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.loadMore();
    expect(calls).toHaveLength(0);
    loader.start();
    loader.loadMore();
    expect(calls).toHaveLength(1);
    calls[0].resolve(page([5], { total_amount: 15, total_count: 2 }, 'c1'));
    await settle();
    loader.loadMore();
    loader.loadMore();
    expect(calls).toHaveLength(2);
    calls[1].resolve(page([10], { total_amount: 15, total_count: 2 }, null));
    await settle();
    loader.loadMore();
    expect(calls).toHaveLength(2);
  });

  it('reconciles in integer cents: 0.1 + 0.2 equals 0.3', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    calls[0].resolve(page([0.1, 0.2], { total_amount: 0.3, total_count: 2 }));
    await settle();
    expect(ready(loader.getState()).loadedCents).toBe(30);
  });

  it('each row is converted to whole cents before it is added: amounts whose ×100 is not an integer in floating point still reconcile', async () => {
    // 1.15 × 100 = 114.99999999999999 and 0.29 × 100 = 28.999999999999996 in binary floating point;
    // their floating-point sum is not 144. In integer cents it is 115 + 29 = 144.
    expect(1.15 * 100).not.toBe(115);
    expect(0.29 * 100).not.toBe(29);
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    calls[0].resolve(page([1.15], { total_amount: 1.44, total_count: 2 }, 'c1'));
    await settle();
    expect(ready(loader.getState()).loadedCents).toBe(115);
    loader.loadMore();
    calls[1].resolve(page([0.29], { total_amount: 1.44, total_count: 2 }, null));
    await settle();
    const state = ready(loader.getState());
    expect(state.loadedCents).toBe(144);
    expect(state.totalCents).toBe(144);
    expect(Number.isInteger(state.loadedCents)).toBe(true);
  });

  it('an empty result is a complete list of nothing', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    calls[0].resolve(page([], { total_amount: 0, total_count: 0 }));
    await settle();
    expect(ready(loader.getState())).toMatchObject({ rows: [], totalCents: 0, totalCount: 0, nextCursor: null });
  });
});

describe('409 effects_restart_required', () => {
  it('discards the accumulated pages at once and restarts from page 1', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    const seen: EffectsDrilldownState[] = [];
    loader.subscribe(() => seen.push(loader.getState()));
    loader.start();
    calls[0].resolve(page([30, 20], { total_amount: 60, total_count: 3 }, 'c1'));
    await settle();
    loader.loadMore();
    calls[1].reject(restartRequired());
    await settle();

    // No rows are listed while the list reloads, and the reload asks for page 1.
    expect(loader.getState()).toEqual({ phase: 'loading', restarting: true });
    expect(calls).toHaveLength(3);
    expect(calls[2].cursor).toBeNull();

    // The new result has another total; the old rows are never shown beside it.
    calls[2].resolve(page([45], { total_amount: 45, total_count: 1 }, null));
    await settle();
    const state = ready(loader.getState());
    expect(state.rows.map((r) => r.effect_amount)).toEqual([45]);
    expect(state.totalCents).toBe(4500);

    const afterRestart = seen.slice(seen.findIndex((s) => s.phase === 'loading' && s.restarting));
    for (const s of afterRestart) {
      if (s.phase === 'ready') expect(s.rows.map((r) => r.effect_amount)).toEqual([45]);
    }
  });

  it(`stops after ${EFFECTS_MAX_RESTARTS} restarts with a retryable failure instead of looping`, async () => {
    let requests = 0;
    const fetchPage: FetchEffectsPage = async (cursor) => {
      requests += 1;
      if (cursor === null) return page([10], { total_amount: 20, total_count: 2 }, 'c1');
      throw restartRequired();
    };
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    // Each attempt: page 1, then a refused continuation.
    for (let attempt = 0; attempt <= EFFECTS_MAX_RESTARTS; attempt += 1) {
      await settle();
      expect(loader.getState().phase).toBe('ready');
      loader.loadMore();
      await settle();
    }
    await settle();
    expect(loader.getState()).toEqual({ phase: 'failed', failure: { kind: 'kept_changing' } });
    const requestsWhenStopped = requests;
    await settle();
    await settle();
    expect(requests).toBe(requestsWhenStopped);
    // 1 + MAX page-1 requests, 1 + MAX refused continuations.
    expect(requests).toBe(2 * (EFFECTS_MAX_RESTARTS + 1));
  });

  it('a refusal that keeps coming with no user action in between is also bounded', async () => {
    let requests = 0;
    const fetchPage: FetchEffectsPage = async () => {
      requests += 1;
      throw restartRequired();
    };
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    for (let i = 0; i < 10; i += 1) await settle();
    expect(loader.getState()).toEqual({ phase: 'failed', failure: { kind: 'kept_changing' } });
    expect(requests).toBe(EFFECTS_MAX_RESTARTS + 1);
  });

  it('"Try again" after the bound starts a fresh, equally bounded attempt', async () => {
    let requests = 0;
    let refuse = true;
    const fetchPage: FetchEffectsPage = async () => {
      requests += 1;
      if (refuse) throw restartRequired();
      return page([7], { total_amount: 7, total_count: 1 });
    };
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    for (let i = 0; i < 10; i += 1) await settle();
    expect(loader.getState().phase).toBe('failed');
    refuse = false;
    loader.start();
    await settle();
    expect(ready(loader.getState()).rows).toHaveLength(1);
    expect(requests).toBe(EFFECTS_MAX_RESTARTS + 2);
  });
});

describe('a completed list must be the result its total describes', () => {
  it.each([
    ['fewer rows than total_count', [10, 20], { total_amount: 30, total_count: 3 }],
    ['more rows than total_count', [10, 20], { total_amount: 30, total_count: 1 }],
    ['rows that do not sum to total_amount', [10, 20], { total_amount: 30.01, total_count: 2 }],
    ['a sum that differs only by sign', [-30], { total_amount: 30, total_count: 1 }],
  ])('%s is a client integrity failure, and nothing is listed', async (_name, amounts, totals) => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    calls[0].resolve(page(amounts, totals, null));
    await settle();
    expect(loader.getState()).toEqual({ phase: 'failed', failure: { kind: 'not_reconciled' } });
  });

  it('a later page that declares another total or count is refused', async () => {
    for (const second of [{ total_amount: 61, total_count: 3 }, { total_amount: 60, total_count: 4 }]) {
      const { calls, fetchPage } = controlledFetcher();
      const loader = createEffectsLoader(fetchPage);
      loader.start();
      calls[0].resolve(page([30, 20], { total_amount: 60, total_count: 3 }, 'c1'));
      await settle();
      loader.loadMore();
      calls[1].resolve(page([10], second, null));
      await settle();
      expect(loader.getState()).toEqual({ phase: 'failed', failure: { kind: 'not_reconciled' } });
    }
  });

  it('a transaction that reappears on a later page is refused: no duplicate row is ever listed', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    const repeated = effectRowWire({ effect_amount: 20 });
    calls[0].resolve(readEffectsResponse(effectsPageWire([effectRowWire({ effect_amount: 30 }), repeated], { total_amount: 70, total_count: 3 }, 'c1')));
    await settle();
    loader.loadMore();
    calls[1].resolve(readEffectsResponse(effectsPageWire([repeated], { total_amount: 70, total_count: 3 }, null)));
    await settle();
    expect(loader.getState()).toEqual({ phase: 'failed', failure: { kind: 'not_reconciled' } });
  });

  it('several effects of one transaction on the same page are all listed (a page never splits a transaction)', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    const txn = { id: 'txn-split' };
    calls[0].resolve(
      readEffectsResponse(
        effectsPageWire(
          [
            effectRowWire({ effect_amount: 40, allocation: 'split', split_id: 's1' }, txn),
            effectRowWire({ effect_amount: 35, allocation: 'split', split_id: 's2' }, txn),
          ],
          { total_amount: 75, total_count: 2 }
        )
      )
    );
    await settle();
    expect(ready(loader.getState()).rows).toHaveLength(2);
  });

  it('a continuation that makes no progress is refused rather than requested forever', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    calls[0].resolve(page([], { total_amount: 10, total_count: 1 }, 'c1'));
    await settle();
    expect(loader.getState()).toEqual({ phase: 'failed', failure: { kind: 'not_reconciled' } });

    const again = controlledFetcher();
    const second = createEffectsLoader(again.fetchPage);
    second.start();
    again.calls[0].resolve(page([5], { total_amount: 10, total_count: 2 }, 'same'));
    await settle();
    second.loadMore();
    again.calls[1].resolve(page([1], { total_amount: 10, total_count: 2 }, 'same'));
    await settle();
    expect(second.getState()).toEqual({ phase: 'failed', failure: { kind: 'not_reconciled' } });
  });
});

describe('states with no rows', () => {
  it.each(['updating', 'unavailable'] as const)('%s on a later page discards the rows already loaded', async (kind) => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    calls[0].resolve(page([30, 20], { total_amount: 60, total_count: 3 }, 'c1'));
    await settle();
    loader.loadMore();
    calls[1].resolve({ kind, reason: 'matching_pending', retryAfterMs: 5000 });
    await settle();
    expect(loader.getState()).toMatchObject({ phase: kind, reason: 'matching_pending' });
    expect('rows' in loader.getState()).toBe(false);
    loader.dispose();
  });

  it('a malformed response is a failure, not a list', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    calls[0].resolve(readEffectsResponse({ status: 'ok', rows: 'none' }));
    await settle();
    expect(loader.getState()).toEqual({ phase: 'failed', failure: { kind: 'malformed' } });
  });

  it('a failed request keeps only the code and the HTTP status', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    calls[0].reject(Object.assign(new Error('A split transaction no longer adds up'), { code: 'split_allocation_mismatch', status: 409, transaction_id: 'x' }));
    await settle();
    expect(loader.getState()).toEqual({ phase: 'failed', failure: { kind: 'request_failed', code: 'split_allocation_mismatch', status: 409 } });

    const notFound = controlledFetcher();
    const levelOne = createEffectsLoader(notFound.fetchPage);
    levelOne.start();
    notFound.calls[0].reject(Object.assign(new Error('Not found'), { status: 404 }));
    await settle();
    expect(levelOne.getState()).toEqual({ phase: 'failed', failure: { kind: 'request_failed', code: null, status: 404 } });
  });
});

describe('cancellation', () => {
  it('dispose aborts the request in flight and its late response changes nothing', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    loader.dispose();
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve(page([10], { total_amount: 10, total_count: 1 }));
    await settle();
    expect(loader.getState()).toEqual({ phase: 'loading', restarting: false });
    loader.start();
    loader.loadMore();
    expect(calls).toHaveLength(1);
  });

  it('a late failure after dispose is dropped too', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    loader.dispose();
    calls[0].reject(restartRequired());
    await settle();
    expect(calls).toHaveLength(1);
    expect(loader.getState().phase).toBe('loading');
  });

  it('starting again supersedes the request in flight: the older response is ignored whatever order they arrive in', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    loader.start();
    expect(calls[0].signal.aborted).toBe(true);
    calls[1].resolve(page([2], { total_amount: 2, total_count: 1 }));
    await settle();
    calls[0].resolve(page([1], { total_amount: 1, total_count: 1 }));
    await settle();
    expect(ready(loader.getState()).rows.map((r) => r.effect_amount)).toEqual([2]);
  });

  it('a continuation answered after a restart began is ignored', async () => {
    const { calls, fetchPage } = controlledFetcher();
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    calls[0].resolve(page([30], { total_amount: 40, total_count: 2 }, 'c1'));
    await settle();
    loader.loadMore();
    loader.start(); // the user's "Try again" while page 2 is in flight
    calls[1].resolve(page([10], { total_amount: 40, total_count: 2 }, null));
    await settle();
    expect(loader.getState()).toEqual({ phase: 'loading', restarting: false });
    calls[2].resolve(page([40], { total_amount: 40, total_count: 1 }, null));
    await settle();
    expect(ready(loader.getState()).rows.map((r) => r.effect_amount)).toEqual([40]);
  });
});

describe('effectsQueryKey', () => {
  it('differs for every period, measure and bucket, so one drill-down is never mistaken for another', () => {
    const period = { start: '2026-09-01', end: '2026-10-01' };
    const keys = [
      effectsQueryKey({ ...period, measure: 'spending' }),
      effectsQueryKey({ ...period, measure: 'spending', bucket: { kind: 'budget_category', id: null } }),
      effectsQueryKey({ ...period, measure: 'spending', bucket: { kind: 'budget_category', id: 'a' } }),
      effectsQueryKey({ ...period, measure: 'spending', bucket: { kind: 'plaid_category', category: 'a' } }),
      effectsQueryKey({ ...period, measure: 'income' }),
      effectsQueryKey({ ...period, measure: 'card_payments_unresolved_credit' }),
      effectsQueryKey({ start: '2026-08-01', end: '2026-09-01', measure: 'spending' }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

// I2 correction (review finding F3): an `updating` answer is asked again by the client after the
// server's hint, a bounded number of times. A read only: nothing is evaluated. Time is faked.
describe('automatic refetch after an updating answer', () => {
  const updating = (retryAfterMs = 5000): EffectsResponse => ({ kind: 'updating', reason: 'matching_pending', retryAfterMs });

  /** A fetcher that answers each call from a queue, immediately. */
  function queuedFetcher(answers: (EffectsResponse | Error)[]) {
    const cursors: (string | null)[] = [];
    const signals: AbortSignal[] = [];
    const fetchPage: FetchEffectsPage = async (cursor, signal) => {
      cursors.push(cursor);
      signals.push(signal);
      const next = answers.shift();
      if (next === undefined) throw new Error('unexpected request');
      if (next instanceof Error) throw next;
      return next;
    };
    return { cursors, signals, fetchPage };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-requests page 1 once after the hinted delay, and the ok answer replaces the updating state', async () => {
    const { cursors, fetchPage } = queuedFetcher([updating(5000), page([12.5], { total_amount: 12.5, total_count: 1 })]);
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(loader.getState()).toEqual({ phase: 'updating', reason: 'matching_pending', autoRetrying: true });
    expect(cursors).toEqual([null]);

    await vi.advanceTimersByTimeAsync(4999);
    expect(cursors).toEqual([null]);
    await vi.advanceTimersByTimeAsync(1);
    expect(cursors).toEqual([null, null]);
    const state = ready(loader.getState());
    expect(state.rows.map((r) => r.effect_amount)).toEqual([12.5]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows no rows and keeps saying updating while the refetch is in flight', async () => {
    let release!: (r: EffectsResponse) => void;
    const answers: (EffectsResponse | Promise<EffectsResponse>)[] = [updating(), new Promise<EffectsResponse>((r) => (release = r))];
    const fetchPage: FetchEffectsPage = async () => answers.shift() as EffectsResponse;
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(loader.getState()).toEqual({ phase: 'updating', reason: 'matching_pending', autoRetrying: true });
    release(page([3], { total_amount: 3, total_count: 1 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ready(loader.getState()).rows).toHaveLength(1);
  });

  it(`stops after ${UPDATING_REFETCH_MAX_ATTEMPTS} automatic refetches when every answer is updating: no infinite loop, and it says so`, async () => {
    const { cursors, fetchPage } = queuedFetcher(Array.from({ length: UPDATING_REFETCH_MAX_ATTEMPTS + 1 }, () => updating()));
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 1; attempt <= UPDATING_REFETCH_MAX_ATTEMPTS; attempt += 1) {
      await vi.advanceTimersByTimeAsync(5000);
      expect(cursors).toHaveLength(1 + attempt);
    }
    expect(loader.getState()).toEqual({ phase: 'updating', reason: 'matching_pending', autoRetrying: false });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cursors).toHaveLength(1 + UPDATING_REFETCH_MAX_ATTEMPTS);
  });

  it('a zero or tiny hint waits the minimum instead of spinning', async () => {
    const { cursors, fetchPage } = queuedFetcher(Array.from({ length: UPDATING_REFETCH_MAX_ATTEMPTS + 1 }, () => updating(0)));
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    await vi.advanceTimersByTimeAsync(UPDATING_REFETCH_MIN_DELAY_MS - 1);
    expect(cursors).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(cursors).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cursors).toHaveLength(1 + UPDATING_REFETCH_MAX_ATTEMPTS);
  });

  it('"Try again" supersedes the pending wait and starts a fresh, equally bounded budget', async () => {
    const perLoad = 1 + UPDATING_REFETCH_MAX_ATTEMPTS;
    const { cursors, fetchPage } = queuedFetcher(Array.from({ length: 2 * perLoad }, () => updating()));
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cursors).toHaveLength(perLoad);

    loader.start();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(loader.getState()).toMatchObject({ phase: 'updating', autoRetrying: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cursors).toHaveLength(2 * perLoad);
  });

  it('a manual retry while a wait is pending cancels that wait: one request, not two', async () => {
    const { cursors, fetchPage } = queuedFetcher([updating(), page([1], { total_amount: 1, total_count: 1 })]);
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    await vi.advanceTimersByTimeAsync(2000);
    loader.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ready(loader.getState()).rows).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cursors).toHaveLength(2);
  });

  it('dispose cancels the pending wait; nothing is requested afterwards', async () => {
    const { cursors, fetchPage } = queuedFetcher([updating()]);
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    await vi.advanceTimersByTimeAsync(2000);
    loader.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cursors).toHaveLength(1);
  });

  it('dispose while the automatic refetch is in flight aborts it and drops its answer', async () => {
    let release!: (r: EffectsResponse) => void;
    const signals: AbortSignal[] = [];
    const answers: (EffectsResponse | Promise<EffectsResponse>)[] = [updating(), new Promise<EffectsResponse>((r) => (release = r))];
    const fetchPage: FetchEffectsPage = async (_cursor, signal) => {
      signals.push(signal);
      return answers.shift() as EffectsResponse;
    };
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    await vi.advanceTimersByTimeAsync(5000);
    loader.dispose();
    expect(signals[1].aborted).toBe(true);
    release(page([9], { total_amount: 9, total_count: 1 }));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(loader.getState().phase).toBe('updating');
  });

  it.each([
    ['unavailable', { kind: 'unavailable', reason: 'request_failed', retryAfterMs: 5000 } as EffectsResponse],
    ['a malformed response', { kind: 'invalid' } as EffectsResponse],
    ['an integrity failure', Object.assign(new Error('paused'), { code: 'semantic_integrity_error', status: 500 })],
    ['a split mismatch', Object.assign(new Error('refused'), { code: 'split_allocation_mismatch', status: 409 })],
    ['a missing endpoint', Object.assign(new Error('Not found'), { status: 404 })],
    ['a network failure', new Error('Failed to fetch')],
  ])('%s is never retried automatically', async (_name, answer) => {
    const { cursors, fetchPage } = queuedFetcher([answer]);
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cursors).toHaveLength(1);
    expect(loader.getState().phase).not.toBe('ready');
    expect(loader.getState().phase).not.toBe('updating');
  });

  it('a failure of the automatic refetch ends it: the list shows the failure and asks no more', async () => {
    const { cursors, fetchPage } = queuedFetcher([updating(), Object.assign(new Error('paused'), { code: 'semantic_integrity_error', status: 500 })]);
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(loader.getState()).toEqual({ phase: 'failed', failure: { kind: 'request_failed', code: 'semantic_integrity_error', status: 500 } });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cursors).toHaveLength(2);
  });

  it('the 409 restart bound is separate and unchanged', async () => {
    const answers: (EffectsResponse | Error)[] = [updating()];
    for (let i = 0; i <= EFFECTS_MAX_RESTARTS; i += 1) answers.push(restartRequired());
    const { cursors, fetchPage } = queuedFetcher(answers);
    const loader = createEffectsLoader(fetchPage);
    loader.start();
    await vi.advanceTimersByTimeAsync(5000);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(loader.getState()).toEqual({ phase: 'failed', failure: { kind: 'kept_changing' } });
    // 1 updating answer, then 1 + EFFECTS_MAX_RESTARTS refused requests.
    expect(cursors).toHaveLength(2 + EFFECTS_MAX_RESTARTS);
  });
});
