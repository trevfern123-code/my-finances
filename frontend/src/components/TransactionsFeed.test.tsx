// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getRecoveryReviews: vi.fn(),
  applyRecoveryAction: vi.fn(),
  getRecoveryAction: vi.fn(),
  requestRecoveryRefresh: vi.fn(),
  getCurrentSessionOwner: vi.fn(),
}));
vi.mock('../lib/api', () => api);

import { TransactionsFeed } from './TransactionsFeed';
import type { TransactionItem } from '../lib/api';
import { readRecoveryReviews } from '../lib/semanticModel';

// The entry into the payment review from Transactions (I3A-R packet 2-A): there when a payment is under review —
// whether or not that payment is among the rows shown, and whether or not its figures are current — and absent,
// silently, when nothing is under review or the review cannot be read.

const K = '22222222-2222-4222-8222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';

function item(overrides: Partial<TransactionItem>): TransactionItem {
  return {
    id: K,
    amount: 370,
    iso_currency_code: 'USD',
    date: '2026-09-10',
    name: 'Card payment',
    merchant_name: null,
    category: 'LOAN_PAYMENTS',
    plaid_category: null,
    pending: false,
    budget_category_id: null,
    needs_review: false,
    splits: [],
    accounts: { name: 'Checking', nickname: null, plaid_items: { institution_name: 'Bank' } },
    ...overrides,
  } as TransactionItem;
}
const freshness = (over: Record<string, unknown> = {}) => ({ fresh: true, input_version: 7, evaluated_version: 7, review_revision: 3, last_error_code: null, refresh: { queued: false, needs_attention: false, attempts: 0 }, ...over });
const review = (transactionId: string) => ({
  transaction_id: transactionId,
  account_id: ACCOUNT,
  date: '2026-09-10',
  amount_cents: 37000,
  pending: false,
  side: 'cash',
  direction: 'payment',
  account_included: true,
  state: 'untracked',
  reason: 'removed_card',
  detail: null,
  effect_cents: -37000,
  low_cents: -37000,
  high_cents: -37000,
  partner_transaction_id: null,
  guard_withheld: false,
  withheld_partner_transaction_id: null,
  coverage_gap: false,
  deferred: false,
  controlling_decision: null,
  obligations: [],
  candidates: [],
});
const reviews = (ids: string[], over: Record<string, unknown> = {}) =>
  readRecoveryReviews({ fresh: true, freshness: freshness(), actions_enabled: true, affected_payment_count: ids.length, next_cursor: null, reviews: ids.map(review), ...over });

const props = {
  budgetCategories: [],
  syncing: false,
  onSync: () => {},
  onCategorize: () => {},
  onApprove: () => {},
  onSaveSplits: async () => {},
  onClearSplits: async () => {},
};

beforeEach(() => {
  localStorage.clear();
  for (const mock of Object.values(api)) mock.mockReset();
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

describe('the review entry in Transactions', () => {
  it('a payment under review gets "Review payment" on its row, and the header says how many there are', async () => {
    api.getRecoveryReviews.mockResolvedValue(reviews([K]));
    render(<TransactionsFeed {...props} transactions={[item({}), item({ id: OTHER, name: 'Groceries', amount: 20 })]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '1 payment to review' })).toBeTruthy());
    expect(screen.getAllByRole('button', { name: 'Review payment' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Review payment' }));
    await waitFor(() => expect(screen.getByTestId('payment-review').textContent).toContain('Card payment (Checking) — Card payment of $370.00 on Sep 10, 2026'));
    expect(screen.getByTestId(`reading-${K}`).textContent).toBe('It counts as money that went to a card whose bank connection was removed: −$370.00.');
  });

  it('a payment under review that is NOT among the rows shown is still reachable from the header', async () => {
    api.getRecoveryReviews.mockResolvedValue(reviews([K]));
    render(<TransactionsFeed {...props} transactions={[item({ id: OTHER, name: 'Groceries', amount: 20 })]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '1 payment to review' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Review payment' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '1 payment to review' }));
    await waitFor(() => expect(screen.getByTestId(`review-${K}`)).toBeTruthy());
  });

  it('while the figures are not current the entry is still there, and leads to the refresh — not to a figure', async () => {
    api.getRecoveryReviews.mockResolvedValue(
      reviews([], { fresh: false, freshness: freshness({ fresh: false, evaluated_version: 6, refresh: { queued: true, needs_attention: true, attempts: 8 } }), affected_payment_count: 2, actions_enabled: false })
    );
    render(<TransactionsFeed {...props} transactions={[item({})]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '2 payments to review' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: '2 payments to review' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh the figures' })).toBeTruthy());
    expect(screen.getByTestId('payment-review').textContent).not.toMatch(/\$\d/);
  });

  it('nothing under review: no entry at all', async () => {
    api.getRecoveryReviews.mockResolvedValue(reviews([]));
    render(<TransactionsFeed {...props} transactions={[item({})]} />);
    await waitFor(() => expect(api.getRecoveryReviews).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /to review/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review payment' })).toBeNull();
  });

  it('the review cannot be read (an older server, a failure, an unknown shape): the feed is as it always was', async () => {
    for (const outcome of [() => Promise.reject(Object.assign(new Error('Not found'), { status: 404 })), () => Promise.resolve({ kind: 'invalid' })]) {
      api.getRecoveryReviews.mockImplementation(outcome);
      const view = render(<TransactionsFeed {...props} transactions={[item({})]} />);
      await waitFor(() => expect(api.getRecoveryReviews).toHaveBeenCalled());
      expect(screen.queryByRole('button', { name: /to review|Review payment/ })).toBeNull();
      expect(screen.getByText('Card payment')).toBeTruthy();
      view.unmount();
      api.getRecoveryReviews.mockReset();
    }
  });

  it('asks for the review once per mount, and sends no change by itself', async () => {
    api.getRecoveryReviews.mockResolvedValue(reviews([K]));
    render(<TransactionsFeed {...props} transactions={[item({})]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '1 payment to review' })).toBeTruthy());
    expect(api.getRecoveryReviews).toHaveBeenCalledTimes(1);
    expect(api.applyRecoveryAction).not.toHaveBeenCalled();
    expect(api.requestRecoveryRefresh).not.toHaveBeenCalled();
  });
});

describe('an unresolved operation is reached again from Transactions', () => {
  const unknown = () => Object.assign(new Error('The outcome of this request is not known.'), { status: 504, code: 'outcome_unknown' });
  const shownOperationId = () => screen.queryByTestId('unknown-outcome')?.getAttribute('data-operation-id') ?? null;

  async function leaveOneUnresolved() {
    api.getRecoveryReviews.mockResolvedValue(reviews([K]));
    api.applyRecoveryAction.mockRejectedValueOnce(unknown());
    const view = render(<TransactionsFeed {...props} transactions={[item({})]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Review payment' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Review payment' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Decide later' }).hasAttribute('disabled')).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Decide later' }));
    await waitFor(() => expect(shownOperationId()).not.toBeNull());
    return { view, sent: api.applyRecoveryAction.mock.calls[0][0] };
  }

  it('closing the payment’s review and opening the review from the header shows the SAME operation; the header says a change needs checking', async () => {
    const { sent } = await leaveOneUnresolved();
    fireEvent.click(screen.getByRole('button', { name: 'Review payment' }));
    await waitFor(() => expect(screen.queryByTestId('payment-review')).toBeNull());
    const entry = screen.getByRole('button', { name: /1 payment to review · 1 change to check/ });
    fireEvent.click(entry);
    await waitFor(() => expect(shownOperationId()).toBe(sent.operationId));
    // Opened as a whole, each payment's block starts closed: open it, and its actions are there — and blocked.
    fireEvent.click(screen.getByRole('button', { name: /Card payment of \$370\.00/ }));
    expect(screen.getByRole('button', { name: 'Decide later' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Decide later' }));
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
  });

  it('after leaving Transactions and coming back — and although the review can no longer be read — the entry is there and leads to the same operation', async () => {
    const { view, sent } = await leaveOneUnresolved();
    view.unmount();
    api.getRecoveryReviews.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }));
    render(<TransactionsFeed {...props} transactions={[item({})]} />);
    const entry = await screen.findByRole('button', { name: '1 change to check' });
    fireEvent.click(entry);
    await waitFor(() => expect(shownOperationId()).toBe(sent.operationId));
  });

  it('nothing unresolved: the entry is exactly as before (no "change to check")', async () => {
    api.getRecoveryReviews.mockResolvedValue(reviews([K]));
    render(<TransactionsFeed {...props} transactions={[item({})]} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '1 payment to review' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /change to check/ })).toBeNull();
  });
});
