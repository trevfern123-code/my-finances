// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getTransactionEffects: vi.fn(),
  EFFECTS_RESTART_REQUIRED: 'effects_restart_required',
  getRecoveryReviews: vi.fn(),
  applyRecoveryAction: vi.fn(),
  getRecoveryAction: vi.fn(),
  requestRecoveryRefresh: vi.fn(),
  getCurrentSessionOwner: vi.fn(),
}));
vi.mock('../lib/api', () => api);

import { EffectsDrilldown } from './EffectsDrilldown';
import type { EffectsQuery } from '../lib/api';
import { readEffectsResponse, readRecoveryReviews } from '../lib/semanticModel';
import { effectRowWire, effectsPageWire } from '../testUtils/semanticFixtures';

// The entry into the payment review from the Effects Drilldown (I3A-R packet 2-A): on every list of card
// payments — also while that list cannot be shown because card-payment matching is not up to date — and on no
// other list.

const K = '22222222-2222-4222-8222-222222222222';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const PERIOD = { start: '2026-09-01', end: '2026-10-01' };
const UNRESOLVED: EffectsQuery = { ...PERIOD, measure: 'card_payments_unresolved_payments' };
const SPENDING: EffectsQuery = { ...PERIOD, measure: 'spending' };

const freshness = (over: Record<string, unknown> = {}) => ({ fresh: true, input_version: 7, evaluated_version: 7, review_revision: 3, last_error_code: null, refresh: { queued: false, needs_attention: false, attempts: 0 }, ...over });
const review = () => ({
  transaction_id: K,
  account_id: ACCOUNT,
  date: '2026-09-10',
  amount_cents: 37000,
  pending: false,
  side: 'cash',
  direction: 'payment',
  account_included: true,
  state: 'unresolved',
  reason: 'relink_review_required',
  detail: null,
  effect_cents: null,
  low_cents: -37000,
  high_cents: 0,
  partner_transaction_id: null,
  guard_withheld: false,
  withheld_partner_transaction_id: null,
  coverage_gap: false,
  deferred: false,
  controlling_decision: null,
  obligations: [],
  candidates: [],
});
const reviews = (over: Record<string, unknown> = {}) =>
  readRecoveryReviews({ fresh: true, freshness: freshness(), actions_enabled: true, affected_payment_count: 1, next_cursor: null, reviews: [review()], ...over });
const rows = (ids: string[]) => readEffectsResponse(effectsPageWire(ids.map((id) => effectRowWire({ effect_amount: 370 }, { id, name: 'Card payment' })), { total_amount: 370 * ids.length, total_count: ids.length }));

beforeEach(() => {
  for (const mock of Object.values(api)) if (typeof mock !== 'string') mock.mockReset();
  api.getCurrentSessionOwner.mockResolvedValue({ userId: 'user-a', sessionId: 'login-1' });
});
afterEach(cleanup);

/**
 * A stand-in for the browser's Web Locks API, which jsdom does not have: one holder per lock name, the others
 * wait in turn, and a waiting request ends when its signal aborts. It lets these tests run the coordinated code.
 * It is NOT evidence of what a browser guarantees.
 */
function installWebLocks() {
  const held = new Set<string>();
  const queues = new Map<string, Array<() => void>>();
  const request = vi.fn(
    (name: string, options: { mode?: string; signal?: AbortSignal }, callback: (lock: { name: string; mode: string }) => unknown) =>
      new Promise<unknown>((resolve, reject) => {
        const run = () => {
          Promise.resolve()
            .then(() => callback({ name, mode: options.mode ?? 'exclusive' }))
            .then(resolve, reject)
            .finally(() => {
              const next = queues.get(name)?.shift();
              if (next) next();
              else held.delete(name);
            });
        };
        if (!held.has(name)) {
          held.add(name);
          run();
          return;
        }
        const queue = queues.get(name) ?? [];
        queues.set(name, queue);
        queue.push(run);
        options.signal?.addEventListener('abort', () => {
          const at = queue.indexOf(run);
          if (at < 0) return;
          queue.splice(at, 1);
          reject(new DOMException('The request was aborted.', 'AbortError'));
        });
      })
  );
  Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: { request } });
  return request;
}
beforeEach(() => {
  installWebLocks();
});
afterEach(() => {
  Reflect.deleteProperty(globalThis.navigator, 'locks');
});

describe('the review entry in the Effects Drilldown', () => {
  it('a card-payment list marks the rows under review and opens the review at that payment', async () => {
    api.getTransactionEffects.mockResolvedValue(rows([K, '99999999-9999-4999-8999-999999999999']));
    api.getRecoveryReviews.mockResolvedValue(reviews());
    render(<EffectsDrilldown query={UNRESOLVED} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Review' })).toHaveLength(1));
    expect(screen.getByText(/1 payment to review\./)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(screen.getByTestId(`reading-${K}`).textContent).toContain('between −$370.00 and $0.00'));
    expect(screen.getByTestId('payment-review').textContent).toContain('Card payment — Card payment of $370.00 on Sep 10, 2026');
  });

  it('a payment under review that is not in this list is reachable from the footer', async () => {
    api.getTransactionEffects.mockResolvedValue(rows(['99999999-9999-4999-8999-999999999999']));
    api.getRecoveryReviews.mockResolvedValue(reviews());
    render(<EffectsDrilldown query={UNRESOLVED} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open the review' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open the review' }));
    await waitFor(() => expect(screen.getByTestId(`review-${K}`)).toBeTruthy());
  });

  it('while the list is withheld because matching is not up to date, the entry — and the refresh — are still there', async () => {
    api.getTransactionEffects.mockResolvedValue(readEffectsResponse({ status: 'updating', reason: 'matching_failed', retry_after_ms: 60000 }));
    api.getRecoveryReviews.mockResolvedValue(
      reviews({ fresh: false, freshness: freshness({ fresh: false, evaluated_version: 6, refresh: { queued: true, needs_attention: true, attempts: 8 } }), reviews: [], actions_enabled: false })
    );
    render(<EffectsDrilldown query={UNRESOLVED} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open the review' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Open the review' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh the figures' })).toBeTruthy());
  });

  it('after something is saved in the review, the list and the figure above are reloaded', async () => {
    api.getTransactionEffects.mockResolvedValue(rows([K]));
    api.getRecoveryReviews.mockResolvedValue(reviews());
    api.applyRecoveryAction.mockResolvedValue({ kind: 'ok', status: 'committed_fresh', receipt: {}, freshness: freshness() });
    const onRefreshParent = vi.fn();
    render(<EffectsDrilldown query={UNRESOLVED} parentAmount={370} onRefreshParent={onRefreshParent} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Decide later' }).hasAttribute('disabled')).toBe(false));
    const effectsCalls = api.getTransactionEffects.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Decide later' }));
    await waitFor(() => expect(onRefreshParent).toHaveBeenCalledTimes(1));
    expect(api.getTransactionEffects.mock.calls.length).toBeGreaterThan(effectsCalls);
  });

  it('a list that is not about card payments never asks for the review', async () => {
    api.getTransactionEffects.mockResolvedValue(rows([K]));
    api.getRecoveryReviews.mockResolvedValue(reviews());
    render(<EffectsDrilldown query={SPENDING} />);
    await waitFor(() => expect(screen.getByText('Card payment')).toBeTruthy());
    expect(api.getRecoveryReviews).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Review|review/ })).toBeNull();
  });

  it('the review cannot be read: the list is exactly as it was', async () => {
    api.getTransactionEffects.mockResolvedValue(rows([K]));
    api.getRecoveryReviews.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    render(<EffectsDrilldown query={UNRESOLVED} />);
    await waitFor(() => expect(api.getRecoveryReviews).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Card payment')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Review|review/ })).toBeNull();
  });
});
