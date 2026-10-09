// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mockGetTransactionEffects = vi.hoisted(() => vi.fn());
vi.mock('../lib/api', () => ({
  getTransactionEffects: mockGetTransactionEffects,
  EFFECTS_RESTART_REQUIRED: 'effects_restart_required',
}));

import { EffectsDrilldown } from './EffectsDrilldown';
import { useEffectsDrilldown } from '../hooks/useEffectsDrilldown';
import type { EffectsQuery } from '../lib/api';
import { EFFECTS_MAX_RESTARTS, EFFECTS_PAGE_LIMIT } from '../lib/effectsDrilldown';
import { readEffectsResponse, type EffectsResponse } from '../lib/semanticModel';
import { effectRowWire, effectsPageWire } from '../testUtils/semanticFixtures';

// Financial Semantics Phase B, integration slice I2 — the drill-down as the user sees it (design
// §7.3, §9.4): server rows and signed amounts, the server's complete total while pages remain, a
// restart that never shows old rows beside a new total, and words for every state.

const QUERY: EffectsQuery = { start: '2026-09-01', end: '2026-10-01', measure: 'spending', bucket: { kind: 'budget_category', id: 'cat-1' } };

function row(name: string, amount: number, extra: Record<string, unknown> = {}, transaction: Record<string, unknown> = {}) {
  return effectRowWire({ effect_amount: amount, ...extra }, { name, ...transaction });
}

const ok = (rows: Record<string, unknown>[], totals: { total_amount: number; total_count: number }, next: string | null = null): EffectsResponse =>
  readEffectsResponse(effectsPageWire(rows, totals, next));

const restartRequired = () => Object.assign(new Error('changed'), { code: 'effects_restart_required', reason: 'snapshot_changed', status: 409 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const rowNames = () => Array.from(document.querySelectorAll('.drilldown-name')).map((el) => el.textContent);
const rowAmounts = () => Array.from(document.querySelectorAll('.drilldown-amount')).map((el) => el.textContent);
const footer = () => document.querySelector('.drilldown-footer')?.textContent ?? null;

beforeEach(() => {
  mockGetTransactionEffects.mockReset();
});
afterEach(cleanup);

describe('loading and listing', () => {
  it('requests page 1 for exactly the query it was given, and announces loading', async () => {
    const first = deferred<EffectsResponse>();
    mockGetTransactionEffects.mockReturnValueOnce(first.promise);
    render(<EffectsDrilldown query={QUERY} />);

    expect(screen.getByRole('status').textContent).toBe('Loading…');
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(1);
    const [query, page, signal] = mockGetTransactionEffects.mock.calls[0];
    expect(query).toEqual(QUERY);
    expect(page).toEqual({ cursor: null, limit: EFFECTS_PAGE_LIMIT });
    expect(signal).toBeInstanceOf(AbortSignal);

    await act(async () => first.resolve(ok([row('Corner Market', 75), row('Corner Market refund', -60)], { total_amount: 15, total_count: 2 })));
    expect(rowNames()).toEqual(['Corner Market', 'Corner Market refund']);
  });

  it('lists a negative-amount row and shows the server sign: no client-side sign filtering', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('Shoes', 60), row('Shoes returned', -60)], { total_amount: 0, total_count: 2 }));
    render(<EffectsDrilldown query={QUERY} />);
    await waitFor(() => expect(rowAmounts()).toEqual(['$60.00', '−$60.00']));
    // Design §9.4: "Shopping: 2 items · $0.00".
    expect(footer()).toBe('2 items · $0.00');
  });

  it('names the interest part of a loan payment and marks split and pending rows in words', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(
      ok(
        [
          row('SoFi payment', 50, { allocation: 'interest' }),
          row('Costco', 40, { allocation: 'split', split_id: 's1' }),
          row('Venmo', 75, {}, { pending: true }),
        ],
        { total_amount: 165, total_count: 3 }
      )
    );
    render(<EffectsDrilldown query={QUERY} />);
    await waitFor(() => expect(rowNames()).toEqual(['SoFi payment — interest', 'Costcosplit', 'Venmopending']));
    expect(rowAmounts()).toEqual(['$50.00', '$40.00', '$75.00']);
  });

  it('says so when the result is empty', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(ok([], { total_amount: 0, total_count: 0 }));
    render(<EffectsDrilldown query={QUERY} emptyText="No transactions this month." />);
    await waitFor(() => expect(screen.getByText('No transactions this month.')).toBeTruthy());
    expect(footer()).toBe('0 items · $0.00');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
});

describe('paging', () => {
  it('shows the server total while pages remain, then appends without duplicates and collapses the footer', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('A', 30), row('B', 20)], { total_amount: 120, total_count: 5 }, 'cursor-2'));
    render(<EffectsDrilldown query={QUERY} />);
    await waitFor(() => expect(footer()).toBe('Showing 2 of 5 items · $50.00 of $120.00'));
    // The loaded subtotal is never presented as the total.
    expect(footer()).not.toBe('2 items · $50.00');

    const second = deferred<EffectsResponse>();
    mockGetTransactionEffects.mockReturnValueOnce(second.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(mockGetTransactionEffects.mock.calls[1][1]).toEqual({ cursor: 'cursor-2', limit: EFFECTS_PAGE_LIMIT });
    // While the next page loads the button cannot be pressed again, and the rows stay.
    expect((screen.getByRole('button', { name: 'Loading…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(rowNames()).toEqual(['A', 'B']);

    await act(async () => second.resolve(ok([row('C', 40), row('D', 20), row('E', 10)], { total_amount: 120, total_count: 5 }, null)));
    expect(rowNames()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(footer()).toBe('5 items · $120.00');
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(2);
  });

  it('a completed list that does not add up to its total is an alert, and nothing is listed', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('A', 30), row('B', 20)], { total_amount: 120, total_count: 2 }, null));
    render(<EffectsDrilldown query={QUERY} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/didn't add up to its total/));
    expect(rowNames()).toEqual([]);
    expect(footer()).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('a malformed response is an alert, not a list', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(readEffectsResponse({ status: 'ok', rows: [{ amount: 5 }] }));
    render(<EffectsDrilldown query={QUERY} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/expected form/));
    expect(rowNames()).toEqual([]);
  });
});

describe('409 effects_restart_required', () => {
  it('clears the loaded pages, says it is reloading, and shows only the new result', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('Old A', 30), row('Old B', 20)], { total_amount: 120, total_count: 5 }, 'cursor-2'));
    render(<EffectsDrilldown query={QUERY} />);
    await waitFor(() => expect(rowNames()).toEqual(['Old A', 'Old B']));

    const restarted = deferred<EffectsResponse>();
    mockGetTransactionEffects.mockRejectedValueOnce(restartRequired()).mockReturnValueOnce(restarted.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/changed while the list was loading\. Reloading…/));
    // The old rows and the old total are gone before the new result exists.
    expect(rowNames()).toEqual([]);
    expect(footer()).toBeNull();
    expect(screen.queryByText(/\$120\.00/)).toBeNull();
    // The restart asks for page 1.
    expect(mockGetTransactionEffects.mock.calls[2][1]).toEqual({ cursor: null, limit: EFFECTS_PAGE_LIMIT });

    await act(async () => restarted.resolve(ok([row('New A', 45)], { total_amount: 45, total_count: 1 }, null)));
    expect(rowNames()).toEqual(['New A']);
    expect(footer()).toBe('1 item · $45.00');
  });

  it('stops after the bound with a retryable message, and makes no further request', async () => {
    mockGetTransactionEffects.mockRejectedValue(restartRequired());
    render(<EffectsDrilldown query={QUERY} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/kept changing while the list loaded/));
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(EFFECTS_MAX_RESTARTS + 1);
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(EFFECTS_MAX_RESTARTS + 1);

    mockGetTransactionEffects.mockReset();
    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('Settled', 10)], { total_amount: 10, total_count: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rowNames()).toEqual(['Settled']));
  });
});

describe('states with no rows', () => {
  it('updating says so in words, keeps no rows, and offers an ordinary retry', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce({ kind: 'updating', reason: 'matching_pending', retryAfterMs: 5000 });
    render(<EffectsDrilldown query={{ start: '2026-09-01', end: '2026-10-01', measure: 'transfers_external' }} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Updating…/));
    expect(document.body.textContent).not.toMatch(/\d/);

    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('Zelle', -75)], { total_amount: -75, total_count: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(rowAmounts()).toEqual(['−$75.00']));
    // The press superseded the pending automatic refetch: one request for it, and none after the
    // list is shown (the automatic refetch itself is covered with fake timers below).
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(2);
  });

  it('unavailable is worded differently from updating', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce({ kind: 'unavailable', reason: 'request_failed', retryAfterMs: 5000 });
    render(<EffectsDrilldown query={QUERY} />);
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/^Unavailable\./));
    expect(screen.getByRole('status').textContent).not.toMatch(/Updating/);
  });

  it('a failed request shows fixed wording: no server message, no transaction id', async () => {
    mockGetTransactionEffects.mockRejectedValueOnce(
      Object.assign(new Error('SoFi payment 7b1f… has principal 400.00 larger than amount 350.00'), {
        code: 'semantic_integrity_error',
        status: 500,
        transaction_id: '7b1f0000-0000-4000-8000-000000000000',
      })
    );
    render(<EffectsDrilldown query={QUERY} />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const text = screen.getByRole('alert').textContent ?? '';
    expect(text).toMatch(/One transaction has inconsistent data, so this list is paused\./);
    expect(text).not.toMatch(/SoFi|7b1f|400\.00|350\.00/);
  });

  it('a backend without the endpoint (404) reads as an update in progress', async () => {
    mockGetTransactionEffects.mockRejectedValueOnce(Object.assign(new Error('Not found'), { status: 404 }));
    render(<EffectsDrilldown query={QUERY} />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/isn't available yet/));
  });
});

describe('the figure the list explains', () => {
  it('says nothing when the list total equals the figure above, compared in cents', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('A', 0.1), row('B', 0.2)], { total_amount: 0.3, total_count: 2 }));
    render(<EffectsDrilldown query={QUERY} parentAmount={0.1 + 0.2} />);
    await waitFor(() => expect(footer()).toBe('2 items · $0.30'));
    expect(screen.queryByText(/loaded at different times/)).toBeNull();
  });

  it('says so when the list and the figure above differ, and offers to reload either one', async () => {
    const onRefresh = vi.fn();
    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('A', 45)], { total_amount: 45, total_count: 1 }));
    render(<EffectsDrilldown query={QUERY} parentAmount={50} onRefreshParent={onRefresh} />);
    await waitFor(() =>
      expect(screen.getByText(/This list totals \$45\.00 and the figure above is \$50\.00: they were loaded at different times/)).toBeTruthy()
    );
    fireEvent.click(screen.getByRole('button', { name: 'Refresh figure' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    // Whichever of the two is the older one, reloading the list re-reads the current result.
    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('A', 50)], { total_amount: 50, total_count: 1 }));
    fireEvent.click(screen.getByRole('button', { name: 'Reload list' }));
    await waitFor(() => expect(footer()).toBe('1 item · $50.00'));
    expect(screen.queryByText(/loaded at different times/)).toBeNull();
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(2);
  });
});

describe('switching and leaving', () => {
  it('another query aborts the request in flight and never shows the first query rows', async () => {
    const first = deferred<EffectsResponse>();
    const second = deferred<EffectsResponse>();
    mockGetTransactionEffects.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const view = render(<EffectsDrilldown query={QUERY} />);
    const other: EffectsQuery = { start: '2026-09-01', end: '2026-10-01', measure: 'spending', bucket: { kind: 'budget_category', id: 'cat-2' } };
    view.rerender(<EffectsDrilldown query={other} />);

    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(2);
    expect((mockGetTransactionEffects.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    expect(mockGetTransactionEffects.mock.calls[1][0]).toEqual(other);

    // The first query answers late: it is ignored.
    await act(async () => first.resolve(ok([row('From cat-1', 99)], { total_amount: 99, total_count: 1 })));
    expect(rowNames()).toEqual([]);
    await act(async () => second.resolve(ok([row('From cat-2', 12)], { total_amount: 12, total_count: 1 })));
    expect(rowNames()).toEqual(['From cat-2']);
  });

  it('rows of one measure are not shown under another measure, not even for one render', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('Income row', 500)], { total_amount: 500, total_count: 1 }));
    const view = render(<EffectsDrilldown query={{ start: '2026-09-01', end: '2026-10-01', measure: 'income' }} />);
    await waitFor(() => expect(rowNames()).toEqual(['Income row']));

    const next = deferred<EffectsResponse>();
    mockGetTransactionEffects.mockReturnValueOnce(next.promise);
    view.rerender(<EffectsDrilldown query={{ start: '2026-09-01', end: '2026-10-01', measure: 'debt_payments' }} />);
    // Synchronously after the switch: nothing of the income list is on screen.
    expect(rowNames()).toEqual([]);
    expect(footer()).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Loading…');
    await act(async () => next.resolve(ok([row('Loan row', 650)], { total_amount: 650, total_count: 1 })));
    expect(rowNames()).toEqual(['Loan row']);
  });

  it('the hook never returns the state of a previous query, in any render (recorded render by render)', async () => {
    // The DOM alone cannot show this: React re-renders within the same update. So every render of a
    // probe records which query it was given and what the hook returned for it.
    const renders: string[] = [];
    function Probe({ query }: { query: EffectsQuery }) {
      const { state } = useEffectsDrilldown(query);
      renders.push(`${query.measure} -> ${state.phase === 'ready' ? state.rows.map((r) => r.transaction.name).join(',') : state.phase}`);
      return null;
    }
    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('Income row', 500)], { total_amount: 500, total_count: 1 }));
    const view = render(<Probe query={{ start: '2026-09-01', end: '2026-10-01', measure: 'income' }} />);
    await waitFor(() => expect(renders).toContain('income -> Income row'));

    const next = deferred<EffectsResponse>();
    mockGetTransactionEffects.mockReturnValueOnce(next.promise);
    view.rerender(<Probe query={{ start: '2026-09-01', end: '2026-10-01', measure: 'debt_payments' }} />);
    await act(async () => next.resolve(ok([row('Loan row', 650)], { total_amount: 650, total_count: 1 })));

    expect(renders).toContain('debt_payments -> Loan row');
    expect(renders.filter((entry) => entry.startsWith('debt_payments')).every((entry) => !entry.includes('Income row'))).toBe(true);
    expect(renders).not.toContain('debt_payments -> Income row');
  });

  it('the same query on a re-render does not request again', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('A', 5)], { total_amount: 5, total_count: 1 }));
    const view = render(<EffectsDrilldown query={QUERY} />);
    await waitFor(() => expect(rowNames()).toEqual(['A']));
    view.rerender(<EffectsDrilldown query={{ ...QUERY }} parentAmount={5} />);
    view.rerender(<EffectsDrilldown query={{ ...QUERY }} parentAmount={5} />);
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(1);
  });

  it('unmounting aborts the request in flight', async () => {
    const pending = deferred<EffectsResponse>();
    mockGetTransactionEffects.mockReturnValueOnce(pending.promise);
    const view = render(<EffectsDrilldown query={QUERY} />);
    view.unmount();
    expect((mockGetTransactionEffects.mock.calls[0][2] as AbortSignal).aborted).toBe(true);
    await act(async () => pending.resolve(ok([row('Late', 1)], { total_amount: 1, total_count: 1 })));
  });
});

// I2 correction (review finding F3): an `updating` list is asked again by the client after the
// server's hint, a bounded number of times, and says what it is doing. Time is faked.
describe('automatic refetch after an updating answer', () => {
  const UPDATING: EffectsResponse = { kind: 'updating', reason: 'matching_pending', retryAfterMs: 5000 };
  const TRANSFERS: EffectsQuery = { start: '2026-09-01', end: '2026-10-01', measure: 'transfers_external' };
  const flush = async () => {
    await act(async () => {
      for (let i = 0; i < 10; i += 1) await Promise.resolve();
    });
  };
  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };
  const status = () => screen.getByRole('status').textContent ?? '';

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says it is checking again, asks once after the hint, and shows the list when it is ok', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(UPDATING).mockResolvedValueOnce(ok([row('Zelle', -75)], { total_amount: -75, total_count: 1 }));
    render(<EffectsDrilldown query={TRANSFERS} />);
    await flush();
    expect(status()).toBe('Updating… This list depends on card-payment matching, which is not up to date. Checking again automatically. Try again');
    expect(rowNames()).toEqual([]);
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(1);

    await advance(4999);
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(1);
    await advance(1);
    await flush();
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(2);
    expect(mockGetTransactionEffects.mock.calls[1][1]).toEqual({ cursor: null, limit: EFFECTS_PAGE_LIMIT });
    expect(rowAmounts()).toEqual(['−$75.00']);
    await advance(600_000);
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(2);
  });

  it('stops after the bound, stops saying it is checking, and leaves the manual retry', async () => {
    mockGetTransactionEffects.mockImplementation(() => Promise.resolve({ ...UPDATING }));
    render(<EffectsDrilldown query={TRANSFERS} />);
    await flush();
    for (let step = 0; step < 24; step += 1) await advance(5000);
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(4);
    expect(status()).toBe('Updating… This list depends on card-payment matching, which is not up to date. Try again');
    expect(rowNames()).toEqual([]);
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy();
  });

  it('another query while a wait is pending cancels it: the old query is never asked again', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(UPDATING);
    const view = render(<EffectsDrilldown query={TRANSFERS} />);
    await flush();
    await advance(3000);

    mockGetTransactionEffects.mockResolvedValueOnce(ok([row('Paycheck', 3002.1)], { total_amount: 3002.1, total_count: 1 }));
    const income: EffectsQuery = { start: '2026-09-01', end: '2026-10-01', measure: 'income' };
    view.rerender(<EffectsDrilldown query={income} />);
    await flush();
    expect(rowNames()).toEqual(['Paycheck']);
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(2);
    for (let step = 0; step < 24; step += 1) await advance(5000);
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(2);
    expect(mockGetTransactionEffects.mock.calls.map((call) => (call[0] as EffectsQuery).measure)).toEqual(['transfers_external', 'income']);
    expect(rowNames()).toEqual(['Paycheck']);
  });

  it('closing the list while a wait is pending leaves no timer and makes no request', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce(UPDATING);
    const view = render(<EffectsDrilldown query={TRANSFERS} />);
    await flush();
    expect(vi.getTimerCount()).toBe(1);
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(600_000);
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(1);
  });

  it('unavailable is not asked again by itself', async () => {
    mockGetTransactionEffects.mockResolvedValueOnce({ kind: 'unavailable', reason: 'request_failed', retryAfterMs: 5000 });
    render(<EffectsDrilldown query={TRANSFERS} />);
    await flush();
    expect(status()).toMatch(/^Unavailable\./);
    expect(status()).not.toMatch(/Checking again/);
    expect(vi.getTimerCount()).toBe(0);
    await advance(600_000);
    expect(mockGetTransactionEffects).toHaveBeenCalledTimes(1);
  });
});
