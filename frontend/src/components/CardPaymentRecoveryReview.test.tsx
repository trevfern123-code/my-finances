// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  getRecoveryReviews: vi.fn(),
  applyRecoveryAction: vi.fn(),
  getRecoveryAction: vi.fn(),
  requestRecoveryRefresh: vi.fn(),
  getCurrentSessionOwner: vi.fn(),
}));
vi.mock('../lib/api', () => api);
vi.mock('../lib/jwt', () => ({ decodeSessionId: (token: string) => token.replace('token-of-', '') }));

import { CardPaymentRecoveryReview, useRecoveryReviews } from './CardPaymentRecoveryReview';
import { readRecoveryAnswer, readRecoveryLookup, readRecoveryReviews, type RecoveryReviewsResponse } from '../lib/semanticModel';

// The payment review as the user meets it (I3A-R packet 2-A; PHASE_B_I3A_R_PACKET_2A_REVIEW.md §9): what is
// said, what can be done, what is sent — and what is never shown or assumed.

const K = '22222222-2222-4222-8222-222222222222';
const W = '33333333-3333-4333-8333-333333333333';
const Y = '77777777-7777-4777-8777-777777777777';
const D = '44444444-4444-4444-8444-444444444444';
const OBLIGATION = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';
const OWNER = { userId: 'user-a', sessionId: 'login-1' };
const sessionOf = (userId: string, login: string) => ({ user: { id: userId }, access_token: `token-of-${login}` });

const freshness = (over: Record<string, unknown> = {}) => ({
  fresh: true,
  input_version: 7,
  evaluated_version: 7,
  review_revision: 3,
  last_error_code: null,
  refresh: { queued: false, needs_attention: false, attempts: 0 },
  ...over,
});
const candidate = (id: string, over: Record<string, unknown> = {}) => ({
  transaction_id: id,
  account_id: ACCOUNT,
  date: '2026-09-11',
  amount_cents: -37000,
  pending: false,
  account_included: true,
  kind: 'tier1_competitor',
  distance_days: 1,
  difference_cents: 0,
  withheld_by_guard: false,
  suggestion_only: true,
  rejected: false,
  ...over,
});
const review = (over: Record<string, unknown> = {}) => ({
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
  guard_withheld: true,
  withheld_partner_transaction_id: W,
  coverage_gap: false,
  deferred: false,
  controlling_decision: null,
  obligations: [
    {
      obligation_id: OBLIGATION,
      origin: 'captured',
      completeness: 'complete',
      gap_reason: null,
      removal_id: D,
      institution_name: 'Card Bank',
      removed_on: '2026-10-01',
      known_surviving_edge_count: 1,
      sources: [
        { evidence_kind: 'removed_destination', decision_id: D, decision_kind: 'destination_removed_card', decision_status: 'active', source_relation: 'automatic_partner', source_date: '2026-09-11', source_cents: -37000, source_known: true },
      ],
    },
  ],
  candidates: [candidate(W, { withheld_by_guard: true }), candidate(Y, { date: '2026-09-12', distance_days: 2 })],
  ...over,
});
const page = (over: Record<string, unknown> = {}): RecoveryReviewsResponse =>
  readRecoveryReviews({ fresh: true, freshness: freshness(), actions_enabled: true, affected_payment_count: 1, next_cursor: null, reviews: [review()], ...over });
const stalePage = (refresh: Record<string, unknown>, over: Record<string, unknown> = {}) =>
  page({ fresh: false, freshness: freshness({ fresh: false, evaluated_version: 6, refresh }), reviews: [], ...over });
const receipt = (over: Record<string, unknown> = {}) => ({
  operation_id: 'op',
  action: 'pair_current',
  outcome: 'saved',
  reason: null,
  decision_id: D,
  superseded_decision_ids: [],
  retained_obligation_ids: [OBLIGATION],
  permanent_retirement: false,
  committed_at: '2026-10-09T12:00:00+00:00',
  ...over,
});
const answer = (status: string, over: Record<string, unknown> = {}, fresh = freshness()) => readRecoveryAnswer({ status, receipt: receipt({ operation_id: '11111111-1111-4111-8111-111111111111', ...over }), freshness: fresh });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const text = () => document.body.textContent ?? '';
/** Everything this app keeps in the browser's storage, as one string (the tests do not depend on its keys). */
const stored = () =>
  Object.keys(localStorage)
    .sort()
    .map((key) => localStorage.getItem(key) ?? '')
    .join('\n');
/**
 * What a queue row does NOT establish: that a refresh is running, that none was ever tried, or that it will
 * finish. None of these may be said of a refresh that is only known to be queued.
 */
const UNSUPPORTED_REFRESH_CLAIMS = /has not run|not run yet|never (been )?(run|tried|attempted)|being brought up to date|being updated|in progress|is running|shortly|in a moment|take a moment|will be (ready|updated|refreshed)|until it has run/i;
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const buttons = (name: string | RegExp) => screen.queryAllByRole('button', { name });

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
  // The record of an unresolved operation lives in the browser's storage: every test starts without one.
  localStorage.clear();
  installWebLocks();
  for (const mock of Object.values(api)) mock.mockReset();
  api.getCurrentSessionOwner.mockResolvedValue(OWNER);
  api.getRecoveryReviews.mockResolvedValue(page());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis.navigator, 'locks');
});

async function open(props: Parameters<typeof CardPaymentRecoveryReview>[0] = { focusTransactionId: K }) {
  const view = render(<CardPaymentRecoveryReview {...props} />);
  await waitFor(() => expect(text()).not.toContain('Loading the review'));
  // The login the review was opened under is read asynchronously; actions are offered once it is known.
  await waitFor(() => expect(api.getCurrentSessionOwner).toHaveBeenCalled());
  await act(async () => {
    await api.getCurrentSessionOwner.mock.results[0]?.value;
  });
  return view;
}

describe('what a review says', () => {
  it('the guarded payment: a RANGE in words, never a single figure; the history; the suggestions as suggestions', async () => {
    await open();
    expect(screen.getByTestId(`reading-${K}`).textContent).toBe(
      "A transaction that arrived after a bank connection was removed looks like the other side of this payment, but nothing confirms it. Until you decide, cash flow counts this payment as a range: between −$370.00 and $0.00."
    );
    expect(text()).toContain('Card payment of $370.00 on Sep 10, 2026');
    expect(text()).toContain('Needs your review');
    expect(screen.getByTestId(`obligation-${OBLIGATION}`).textContent).toBe(
      'Card Bank was removed on Oct 1, 2026.It had been matched automatically to a transaction of $370.00 on Sep 11, 2026 at the removed bank.'
    );
    expect(text()).toContain('This record of the removal stays as it is, whatever you decide here.');
    expect(text()).toContain('suggestions from your bank data. None is confirmed, and none is applied unless you choose it.');
    expect(screen.getByTestId(`candidate-${W}`).textContent).toContain('Sep 11, 2026 · $370.00 · 1 day apart · the closest fit — held back for your review, not matched');
    expect(screen.getByTestId(`candidate-${Y}`).textContent).toContain('Sep 12, 2026 · $370.00 · 2 days apart');
  });

  it('offers no retirement, no "reviewed" switch and no release of anything', async () => {
    await open();
    const labels = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    for (const label of labels) expect(label).not.toMatch(/retire|settle|release|resolve|mark as reviewed|reviewed|clear|trust|allow/i);
    expect(labels.filter((l) => l !== '' && !l.startsWith('Card payment'))).toEqual([
      'Match with this',
      'Not this one — it can change the figure',
      'Hide this suggestion — nothing else changes',
      'Match with this',
      'Not this one — it can change the figure',
      'Hide this suggestion — nothing else changes',
      "It went to a card I haven't linked",
      'Decide later',
    ]);
  });

  it('a removed candidate the removal wrote no decision for is shown as its own source, in plain words', async () => {
    const graph = { evidence_kind: 'graph_source', decision_id: null, decision_kind: null, decision_status: null, source_relation: 'removed_candidate', source_cents: -37000, source_known: true };
    api.getRecoveryReviews.mockResolvedValue(
      page({ reviews: [review({ obligations: [{ ...review().obligations[0], sources: [{ ...graph, source_date: '2026-09-11' }, { ...graph, source_date: '2026-09-12' }] }] })] })
    );
    await open();
    expect(screen.getByTestId(`obligation-${OBLIGATION}`).textContent).toBe(
      'Card Bank was removed on Oct 1, 2026.A transaction of $370.00 on Sep 11, 2026 at the removed bank could have been its other side.A transaction of $370.00 on Sep 12, 2026 at the removed bank could have been its other side.'
    );
  });

  it('a coverage gap is said plainly, as its own reason', async () => {
    api.getRecoveryReviews.mockResolvedValue(
      page({
        reviews: [
          review({
            coverage_gap: true,
            obligations: [
              ...review().obligations,
              { obligation_id: '88888888-8888-4888-8888-888888888888', origin: 'gap', completeness: 'unknown', gap_reason: 'unattributed_decision', removal_id: null, institution_name: null, removed_on: null, known_surviving_edge_count: 0, sources: [] },
            ],
          }),
        ],
      })
    );
    await open();
    expect(text()).toContain('Which removed transaction it was is not known, so nothing new is matched to this payment automatically.');
  });

  it('a payment that reads its removed-card record, with no candidate: the definite figure and no invented suggestion', async () => {
    api.getRecoveryReviews.mockResolvedValue(
      page({ reviews: [review({ state: 'untracked', reason: 'removed_card', effect_cents: -37000, low_cents: -37000, high_cents: -37000, guard_withheld: false, withheld_partner_transaction_id: null, candidates: [] })] })
    );
    await open();
    expect(screen.getByTestId(`reading-${K}`).textContent).toBe('It counts as money that went to a card whose bank connection was removed: −$370.00.');
    expect(text()).toContain('No transaction in your accounts looks like the other side of this payment.');
  });

  it('uses the caller\'s name for a transaction when it has one', async () => {
    await open({ focusTransactionId: K, describeTransaction: (id) => (id === K ? 'Card payment to Big Bank (Checking)' : id === W ? 'Payment received (Other Card)' : null) });
    expect(text()).toContain('Card payment to Big Bank (Checking) — Card payment of $370.00 on Sep 10, 2026');
    expect(screen.getByTestId(`candidate-${W}`).textContent).toContain('Payment received (Other Card) · Sep 11, 2026');
  });
});

describe('what cannot be shown is not shown', () => {
  it('while loading: a status, no figure', () => {
    api.getRecoveryReviews.mockReturnValue(new Promise(() => {}));
    render(<CardPaymentRecoveryReview />);
    expect(screen.getByRole('status').textContent).toBe('Loading the review…');
    expect(text()).not.toMatch(/\$\d/);
  });

  it('a response this build cannot read: "update", never a figure or a zero', async () => {
    api.getRecoveryReviews.mockResolvedValue(readRecoveryReviews({ fresh: true, freshness: freshness(), actions_enabled: true, affected_payment_count: 1, next_cursor: null, reviews: [review({ reason: 'provider_verified_return' })] }));
    await open();
    expect(text()).toContain("This version of the app can't show this review. Reload the page to update.");
    expect(text()).not.toMatch(/\$\d/);
  });

  it('the request failed: unavailable, with a way to try again', async () => {
    api.getRecoveryReviews.mockRejectedValueOnce(Object.assign(new Error('x'), { status: 503, code: 'recovery_unavailable' })).mockResolvedValueOnce(page());
    await open();
    expect(text()).toContain("Payment review isn't available right now.");
    fireEvent.click(button('Try again'));
    await waitFor(() => expect(text()).toContain('Needs your review'));
  });

  it('a late answer to an earlier request never replaces the newer one', async () => {
    const first = deferred<RecoveryReviewsResponse>();
    api.getRecoveryReviews.mockReturnValueOnce(first.promise).mockResolvedValueOnce(page({ affected_payment_count: 2 }));
    function Probe() {
      const { state, reload } = useRecoveryReviews();
      return (
        <div>
          <span data-testid="probe">{state.phase === 'ready' ? `ready:${state.data.affected_payment_count}` : state.phase}</span>
          <button type="button" onClick={reload}>
            reload
          </button>
        </div>
      );
    }
    render(<Probe />);
    await waitFor(() => expect(api.getRecoveryReviews).toHaveBeenCalledTimes(1));
    fireEvent.click(button('reload'));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('ready:2'));
    // the first request answers only now, with other content: it is dropped
    await act(async () => first.resolve(page({ affected_payment_count: 9 })));
    expect(screen.getByTestId('probe').textContent).toBe('ready:2');
  });
});

describe('the figures are not current', () => {
  it('shows no review and no figure, says so, and offers the refresh — also when changes are switched off', async () => {
    // attempts: 1 — a refresh HAS been tried and failed once. "It has not run yet" would be false; so would "it is
    // running". The queue row supports one statement: a refresh is queued.
    api.getRecoveryReviews.mockResolvedValue(stalePage({ queued: true, needs_attention: false, attempts: 1 }, { actions_enabled: false, affected_payment_count: 2 }));
    await open();
    expect(text()).toContain('2 payments are under review. A refresh is queued. The figures are not up to date. No figure is shown.');
    expect(text()).not.toMatch(UNSUPPORTED_REFRESH_CLAIMS);
    expect(text()).not.toMatch(/\$\d/);
    expect(buttons(/Match with this|Decide later/)).toHaveLength(0);
    expect(button('Refresh the figures')).toBeTruthy();
  });

  it('after repeated failures it is an alert, and the refresh-only retry sends ONE request with an operation id and nothing else', async () => {
    api.getRecoveryReviews.mockResolvedValue(stalePage({ queued: true, needs_attention: true, attempts: 8 }));
    api.requestRecoveryRefresh.mockResolvedValue(answer('queued', { action: 'refresh_retry', outcome: 'queued', decision_id: null, retained_obligation_ids: [] }, freshness({ fresh: false, evaluated_version: 6, refresh: { queued: true, needs_attention: false, attempts: 0 } })));
    await open();
    expect(screen.getByRole('alert').textContent).toContain("couldn't be brought up to date after several tries, so nothing is shown.");
    fireEvent.click(button('Refresh the figures'));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('A refresh is queued. The figures are not up to date.'));
    expect(text()).not.toMatch(UNSUPPORTED_REFRESH_CLAIMS);
    expect(api.requestRecoveryRefresh).toHaveBeenCalledTimes(1);
    const [operationId, verify] = api.requestRecoveryRefresh.mock.calls[0];
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(verify(sessionOf('user-a', 'login-1'))).toBe(true);
    expect(api.applyRecoveryAction).not.toHaveBeenCalled();
  });
});

describe('acting on a payment', () => {
  it('"Match with this" sends ONE request: the versions seen, the two transactions, the difference — and no owner', async () => {
    api.applyRecoveryAction.mockResolvedValue(answer('committed_fresh'));
    const onChanged = vi.fn();
    await open({ focusTransactionId: K, onChanged });
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(text()).toContain('Saved.'));
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
    const [request, verify] = api.applyRecoveryAction.mock.calls[0];
    expect(request).toEqual({
      operationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      expectedInputVersion: 7,
      expectedReviewRevision: 3,
      action: { type: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: 0 },
    });
    expect(JSON.stringify(request)).not.toMatch(/user|owner/i);
    // the change is sent only under the login the review was opened under
    expect(verify(sessionOf('user-a', 'login-1'))).toBe(true);
    expect(verify(sessionOf('user-b', 'login-1'))).toBe(false);
    expect(verify(sessionOf('user-a', 'login-2'))).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.getRecoveryReviews).toHaveBeenCalledTimes(2); // reloaded after the save
  });

  it('a different amount must be accepted explicitly, and the accepted difference is what is sent', async () => {
    api.getRecoveryReviews.mockResolvedValue(page({ reviews: [review({ candidates: [candidate(W, { amount_cents: -36800, kind: 'near_amount', difference_cents: 200 })] })] }));
    api.applyRecoveryAction.mockResolvedValue(answer('committed_fresh'));
    await open();
    expect(screen.getByTestId(`candidate-${W}`).textContent).toContain('differs by $2.00');
    fireEvent.click(button('Match with this…'));
    expect(api.applyRecoveryAction).not.toHaveBeenCalled();
    expect(text()).toContain('The payment is $2.00 more than this transaction. Matching them accepts that difference: it stays counted as money that left your accounts.');
    fireEvent.click(button('Accept the difference and match'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    expect(api.applyRecoveryAction.mock.calls[0][0].action).toEqual({ type: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: 200 });
  });

  it('for a CARD leg under review the accepted difference keeps its meaning: |cash| − |card|', async () => {
    api.getRecoveryReviews.mockResolvedValue(
      page({ reviews: [review({ side: 'credit', amount_cents: -36800, effect_cents: 0, low_cents: 0, high_cents: 0, candidates: [candidate(W, { amount_cents: 37000, kind: 'near_amount', difference_cents: -200 })] })] })
    );
    api.applyRecoveryAction.mockResolvedValue(answer('committed_fresh'));
    await open();
    fireEvent.click(button('Match with this…'));
    fireEvent.click(button('Accept the difference and match'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    expect(api.applyRecoveryAction.mock.calls[0][0].action.acceptedDifferenceCents).toBe(200);
    expect(buttons("It went to a card I haven't linked")).toHaveLength(0); // a cash-side decision only
  });

  it('rejecting a suggestion and dismissing a candidate are different requests, and say what each does', async () => {
    api.applyRecoveryAction.mockResolvedValue(answer('committed_fresh', { action: 'reject_suggestion', decision_id: null }));
    await open();
    expect(within(W, 'Not this one — it can change the figure').getAttribute('title')).toBe(
      'Says this transaction is not the other side of this payment. This can change the figure: the payment is then read without it.'
    );
    expect(within(W, 'Hide this suggestion — nothing else changes').getAttribute('title')).toBe('Hides this suggestion. Nothing else changes: the figure stays as it is.');
    fireEvent.click(within(W, 'Hide this suggestion — nothing else changes'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    expect(api.applyRecoveryAction.mock.calls[0][0].action).toEqual({ type: 'reject_suggestion', transactionId: K, candidateTransactionId: W });
    await waitFor(() => expect(text()).toContain('Saved.'));
    fireEvent.click(within(W, 'Not this one — it can change the figure'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(2));
    expect(api.applyRecoveryAction.mock.calls[1][0].action).toEqual({ type: 'dismiss_candidate', transactionId: K, candidateTransactionId: W });
  });

  it('a hidden suggestion says so and can still be matched', async () => {
    api.getRecoveryReviews.mockResolvedValue(page({ reviews: [review({ candidates: [candidate(W, { withheld_by_guard: true, rejected: true })] })] }));
    await open();
    expect(screen.getByTestId(`candidate-${W}`).textContent).toContain('you hid this suggestion');
    expect(buttons('Hide this suggestion — nothing else changes')).toHaveLength(0);
    expect(button('Match with this')).toBeTruthy();
  });

  it('"a card I haven\'t linked", "decide later" and "undo" send their own actions', async () => {
    api.applyRecoveryAction.mockResolvedValue(answer('committed_fresh'));
    await open();
    fireEvent.click(button("It went to a card I haven't linked"));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    expect(api.applyRecoveryAction.mock.calls[0][0].action).toEqual({ type: 'confirm_unlinked', transactionId: K });
    await waitFor(() => expect(text()).toContain('Saved.'));
    fireEvent.click(button('Decide later'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(2));
    expect(api.applyRecoveryAction.mock.calls[1][0].action).toEqual({ type: 'defer', transactionId: K });
  });

  it('a payment the user already decided: the decision, its undo, and the notice that a new choice replaces it', async () => {
    api.getRecoveryReviews.mockResolvedValue(
      page({
        reviews: [
          review({
            state: 'untracked',
            reason: 'user_confirmed_unlinked',
            effect_cents: -37000,
            low_cents: -37000,
            high_cents: -37000,
            guard_withheld: false,
            withheld_partner_transaction_id: null,
            controlling_decision: { decision_id: D, kind: 'destination_unlinked', status: 'active', detail: null, user_decision: true },
            candidates: [candidate(W)],
          }),
        ],
      })
    );
    api.applyRecoveryAction.mockResolvedValue(answer('committed_fresh', { action: 'undo_decision', outcome: 'undone' }));
    await open();
    expect(screen.getByTestId(`decision-${K}`).textContent).toContain('You said it went to a card you have not linked.');
    expect(screen.getByTestId(`candidate-${W}`).textContent).toContain('(replaces your earlier decision)');
    expect(button('Undo').getAttribute('title')).toContain('A decision it had replaced does not come back.');
    fireEvent.click(button('Undo'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    expect(api.applyRecoveryAction.mock.calls[0][0].action).toEqual({ type: 'undo_decision', decisionId: D });
  });

  it('saved while the figures are not yet current: said as saved and QUEUED — not as running — and never as a figure', async () => {
    api.applyRecoveryAction.mockResolvedValue(answer('committed_pending', {}, freshness({ fresh: false, evaluated_version: 6, refresh: { queued: true, needs_attention: false, attempts: 0 } })));
    api.getRecoveryReviews.mockResolvedValueOnce(page()).mockResolvedValueOnce(stalePage({ queued: true, needs_attention: false, attempts: 0 }));
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(text()).toContain('Saved. A refresh is queued. The figures are not up to date.'));
    await waitFor(() => expect(text()).toContain('1 payment is under review. A refresh is queued. The figures are not up to date. No figure is shown.'));
    expect(text()).not.toMatch(UNSUPPORTED_REFRESH_CLAIMS);
    // The ACTION is known: it was saved. Only the figures are not current. Nothing is left "unknown", and
    // nothing of it is kept as unresolved.
    expect(screen.queryByTestId('unknown-outcome')).toBeNull();
    expect(stored()).toBe('');
    expect(text()).not.toMatch(/\$\d/);
  });

  it('a refusal says nothing was saved, in fixed words, and reloads', async () => {
    api.applyRecoveryAction.mockRejectedValue(Object.assign(new Error('card_payment_stale_version: internal text'), { status: 409, code: 'stale_version' }));
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Something changed since this was loaded, so nothing was saved. The review has been reloaded — check it and try again.'));
    expect(text()).not.toContain('internal text');
    expect(api.getRecoveryReviews).toHaveBeenCalledTimes(2);
  });

  it('changes switched off: every review is readable, no action is offered', async () => {
    api.getRecoveryReviews.mockResolvedValue(page({ actions_enabled: false }));
    await open();
    expect(text()).toContain('Changes from this screen are switched off right now. You can still read each review.');
    expect(screen.getByTestId(`reading-${K}`).textContent).toContain('between −$370.00 and $0.00');
    expect(buttons(/Match with this|Not this one|Hide this suggestion|Decide later|haven't linked|Undo/)).toHaveLength(0);
  });

  it('a second action cannot start while one is in flight', async () => {
    const pending = deferred<ReturnType<typeof answer>>();
    api.applyRecoveryAction.mockReturnValue(pending.promise);
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(text()).toContain('Saving: Match these two…'));
    expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(Y, 'Match with this'));
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(answer('committed_fresh')));
  });

  it('signed in again as someone else since the review was opened: the server is told nothing; the user is told why', async () => {
    api.applyRecoveryAction.mockRejectedValue(Object.assign(new Error('Session no longer matches'), { code: 'session_owner_mismatch' }));
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('You signed in again since this was opened. Nothing was sent — reload the review.'));
  });
});

describe('an unknown outcome is never assumed', () => {
  const unknown = () => Object.assign(new Error('The outcome of this request is not known.'), { status: 504, code: 'outcome_unknown' });

  it('a timeout: it says the outcome is not known, blocks other actions, and asks about the SAME operation id', async () => {
    api.applyRecoveryAction.mockRejectedValue(unknown());
    api.getRecoveryAction.mockResolvedValue(readRecoveryLookup({ found: true, receipt: receipt({ operation_id: '11111111-1111-4111-8111-111111111111' }), freshness: freshness() }));
    const onChanged = vi.fn();
    await open({ focusTransactionId: K, onChanged });
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("We don't know whether “Match these two” was saved: no answer came back. It may have been."));
    expect(text()).not.toContain('Nothing was saved');
    expect(onChanged).not.toHaveBeenCalled();
    expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(true);
    const sentId = api.applyRecoveryAction.mock.calls[0][0].operationId;
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(text()).toContain('It was saved.'));
    expect(api.getRecoveryAction.mock.calls[0][0]).toBe(sentId);
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
  });

  it('a lost connection (no status at all) is unknown too — not a failure', async () => {
    api.applyRecoveryAction.mockRejectedValue(new TypeError('Failed to fetch'));
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("We don't know whether"));
  });

  const notFound = () => readRecoveryLookup({ found: false, receipt: null, freshness: freshness() });
  const found = () => readRecoveryLookup({ found: true, receipt: receipt({ operation_id: '11111111-1111-4111-8111-111111111111' }), freshness: freshness() });

  // The lookup can see no receipt while the original request's transaction is still open (the database shows
  // this in r05 and c08). So "no receipt" is not "not saved".
  it('NO RECEIPT IS NOT A "NO": the outcome stays unknown, the operation is kept, nothing else can start — and when the original commits, the same id finds it', async () => {
    api.applyRecoveryAction.mockRejectedValue(unknown());
    api.getRecoveryAction.mockResolvedValueOnce(notFound()).mockResolvedValueOnce(found());
    const onChanged = vi.fn();
    await open({ focusTransactionId: K, onChanged });
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(button('Check whether it was saved')).toBeTruthy());
    const sentId = api.applyRecoveryAction.mock.calls[0][0].operationId;
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(text()).toContain('No record of it is visible yet.'));
    // Still unknown, in so many words; nothing claims it failed; nothing lets the user drop it and act again.
    expect(screen.getByRole('alert').textContent).toContain("We don't know whether “Match these two” was saved");
    expect(text()).not.toMatch(/was not saved|Nothing was saved|did not go through|could not be saved/i);
    expect(buttons(/Leave it|Send it again|Discard|Dismiss/)).toHaveLength(0);
    expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(Y, 'Match with this'));
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
    expect(onChanged).not.toHaveBeenCalled();
    // The original transaction commits. The same operation id is asked about again, and finds it.
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(text()).toContain('It was saved.'));
    expect(api.getRecoveryAction.mock.calls.map((c) => c[0])).toEqual([sentId, sentId]);
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('with no receipt visible, the SAME request can be sent again under the SAME operation id; the replay is the one saved action', async () => {
    api.applyRecoveryAction.mockRejectedValueOnce(unknown()).mockResolvedValueOnce(answer('replayed'));
    api.getRecoveryAction.mockResolvedValue(notFound());
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(button('Check whether it was saved')).toBeTruthy());
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(text()).toContain('No record of it is visible yet.'));
    fireEvent.click(button('Send the same request again'));
    await waitFor(() => expect(text()).toContain('That was already saved.'));
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(2);
    // Byte for byte the same intent: the id, the versions the user saw, the action.
    expect(api.applyRecoveryAction.mock.calls[1][0]).toEqual(api.applyRecoveryAction.mock.calls[0][0]);
    expect(buttons('Check whether it was saved')).toHaveLength(0);
  });

  it('sending it again: "try again later" leaves it unknown; only a refusal of THIS operation by the server makes "nothing was saved" known', async () => {
    api.applyRecoveryAction
      .mockRejectedValueOnce(unknown())
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { status: 409, code: 'retry' }))
      .mockRejectedValueOnce(Object.assign(new Error('stale'), { status: 409, code: 'stale_version' }));
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(button('Send the same request again')).toBeTruthy());
    fireEvent.click(button('Send the same request again'));
    await waitFor(() => expect(text()).toContain('The server could not answer that just now.'));
    expect(screen.getByRole('alert').textContent).toContain("We don't know whether “Match these two” was saved");
    expect(text()).not.toMatch(/Nothing was saved|was not saved/i);
    expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(true);
    fireEvent.click(button('Send the same request again'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Something changed since this was loaded, so nothing was saved. The review has been reloaded — check it and try again.'));
    expect(api.applyRecoveryAction.mock.calls[2][0]).toEqual(api.applyRecoveryAction.mock.calls[0][0]);
  });

  it('a different login since the request was sent: nothing is asked or sent under it, and no outcome is claimed', async () => {
    api.applyRecoveryAction.mockRejectedValue(unknown());
    api.getRecoveryAction.mockRejectedValue(Object.assign(new Error('Session no longer matches'), { code: 'session_owner_mismatch' }));
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(button('Check whether it was saved')).toBeTruthy());
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe("You signed in again since this was sent, so its outcome can't be checked from here. Reload the review to see what is saved."));
    expect(text()).not.toMatch(/It was saved|Nothing was saved|was not saved/i);
    // The lookup is sent only under the login that sent the request.
    const verify = api.getRecoveryAction.mock.calls[0][1];
    expect(verify(sessionOf('user-a', 'login-1'))).toBe(true);
    expect(verify(sessionOf('user-b', 'login-2'))).toBe(false);
    expect(verify(sessionOf('user-a', 'login-2'))).toBe(false);
  });

  it('when the check itself fails, the outcome stays unknown', async () => {
    api.applyRecoveryAction.mockRejectedValue(unknown());
    api.getRecoveryAction.mockRejectedValue(new TypeError('Failed to fetch'));
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(button('Check whether it was saved')).toBeTruthy());
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(button('Check whether it was saved').hasAttribute('disabled')).toBe(false));
    expect(screen.getByRole('alert').textContent).toContain("We don't know whether");
    expect(text()).not.toContain('It was saved.');
  });

  it('an answer this build cannot read after a change was sent is unknown as well', async () => {
    api.applyRecoveryAction.mockResolvedValue(readRecoveryAnswer({ status: 'committed_fresh', receipt: receipt({ permanent_retirement: true }), freshness: freshness() }));
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("We don't know whether"));
  });
});

/** A button inside one candidate's block. */
function within(candidateId: string, name: string): HTMLElement {
  const block = screen.getByTestId(`candidate-${candidateId}`);
  const found = Array.from(block.querySelectorAll('button')).find((b) => b.textContent === name);
  if (!found) throw new Error(`no button "${name}" for candidate ${candidateId}`);
  return found;
}

// =====================================================================================================
// v3. An unresolved operation outlives the review that sent it (C2), and a queued refresh is only "queued" (C3).
// =====================================================================================================

describe('a queued refresh: only what the queue row establishes', () => {
  // The wire says: queued, attempts, needs_attention. A lease is not on the wire at all, so a refresh that a
  // worker holds right now, one that is waiting for its first try, one between two failed tries, and one that
  // no worker will ever take (all workers off) are the SAME to this screen: queued.
  it.each([
    ['just queued, never tried', { queued: true, needs_attention: false, attempts: 0 }],
    ['held by a worker right now (a lease is not visible here)', { queued: true, needs_attention: false, attempts: 0 }],
    ['tried and failed, below the attention threshold', { queued: true, needs_attention: false, attempts: 3 }],
    ['every worker switched off (nothing will take it)', { queued: true, needs_attention: false, attempts: 0 }],
  ])('%s: "A refresh is queued. The figures are not up to date." — no claim that it runs, never ran, or will finish', async (_name, refresh) => {
    api.getRecoveryReviews.mockResolvedValue(stalePage(refresh));
    await open();
    expect(screen.getByRole('status').textContent).toContain('1 payment is under review. A refresh is queued. The figures are not up to date. No figure is shown.');
    expect(text()).not.toMatch(UNSUPPORTED_REFRESH_CLAIMS);
    expect(text()).not.toMatch(/\$\d/);
    expect(button('Refresh the figures')).toBeTruthy();
  });

  it('needs attention is said as what it is — several tries failed — and the retry stays available', async () => {
    api.getRecoveryReviews.mockResolvedValue(stalePage({ queued: true, needs_attention: true, attempts: 8 }));
    await open();
    expect(screen.getByRole('alert').textContent).toContain("1 payment is under review. Its figures couldn't be brought up to date after several tries, so nothing is shown.");
    expect(text()).not.toMatch(UNSUPPORTED_REFRESH_CLAIMS);
    expect(button('Refresh the figures').hasAttribute('disabled')).toBe(false);
  });

  it('not queued and not current: no queue is claimed', async () => {
    api.getRecoveryReviews.mockResolvedValue(stalePage({ queued: false, needs_attention: false, attempts: 0 }));
    await open();
    expect(screen.getByRole('status').textContent).toContain('1 payment is under review. The figures are not up to date. No figure is shown.');
    expect(text()).not.toMatch(/queued/i);
  });

  it('asking for a refresh is acknowledged as queued — never as done, and never as a figure', async () => {
    api.getRecoveryReviews.mockResolvedValue(stalePage({ queued: true, needs_attention: false, attempts: 0 }));
    api.requestRecoveryRefresh.mockResolvedValue(answer('queued', { action: 'refresh_retry', outcome: 'queued', decision_id: null, retained_obligation_ids: [] }, freshness({ fresh: false, evaluated_version: 6, refresh: { queued: true, needs_attention: false, attempts: 0 } })));
    await open();
    fireEvent.click(button('Refresh the figures'));
    await waitFor(() => expect(api.requestRecoveryRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(text()).toContain('A refresh is queued. The figures are not up to date.'));
    expect(text()).not.toMatch(UNSUPPORTED_REFRESH_CLAIMS);
    expect(text()).not.toMatch(/\$\d|up to date now|refreshed|done/i);
  });
});

describe('an unresolved operation outlives the review that sent it', () => {
  const unknown = () => Object.assign(new Error('The outcome of this request is not known.'), { status: 504, code: 'outcome_unknown' });
  const notFound = () => readRecoveryLookup({ found: false, receipt: null, freshness: freshness() });
  const found = () => readRecoveryLookup({ found: true, receipt: receipt({ operation_id: '11111111-1111-4111-8111-111111111111' }), freshness: freshness() });
  const shownOperationId = () => screen.queryByTestId('unknown-outcome')?.getAttribute('data-operation-id') ?? null;

  /** Sends "Match with this" for W and leaves it with no answer. Returns the exact request that was sent. */
  async function sendAndLoseTheAnswer(props: Parameters<typeof CardPaymentRecoveryReview>[0] = { focusTransactionId: K }) {
    api.applyRecoveryAction.mockRejectedValueOnce(unknown());
    const view = await open(props);
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(shownOperationId()).not.toBeNull());
    const sent = api.applyRecoveryAction.mock.calls[0][0];
    expect(shownOperationId()).toBe(sent.operationId);
    return { view, sent };
  }

  it('unknown → no receipt → the review is CLOSED and opened again: the same operation id and the same request are still there, and nothing else can be started', async () => {
    api.getRecoveryAction.mockResolvedValue(notFound());
    const { view, sent } = await sendAndLoseTheAnswer();
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(text()).toContain('No record of it is visible yet.'));
    view.unmount();
    expect(screen.queryByTestId('payment-review')).toBeNull();

    await open();
    await waitFor(() => expect(shownOperationId()).toBe(sent.operationId));
    expect(screen.getByTestId('unknown-outcome').textContent).toContain("We don't know whether “Match these two” was saved");
    expect(text()).not.toMatch(/was not saved|Nothing was saved/i);
    // No other change can be started while it is unresolved.
    expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(true);
    expect(button('Decide later').hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(Y, 'Match with this'));
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
    // Sending it again sends the ORIGINAL: the same id, the versions seen then, the same action.
    api.applyRecoveryAction.mockResolvedValueOnce(answer('replayed'));
    fireEvent.click(button('Send the same request again'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(2));
    expect(api.applyRecoveryAction.mock.calls[1][0]).toEqual(sent);
    await waitFor(() => expect(text()).toContain('That was already saved.'));
    expect(shownOperationId()).toBeNull();
    expect(stored()).toBe('');
  });

  it('it is recorded BEFORE it is sent: closing the review while the request is in flight loses nothing', async () => {
    const inFlight = deferred<ReturnType<typeof answer>>();
    api.applyRecoveryAction.mockReturnValue(inFlight.promise);
    const view = await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    const sent = api.applyRecoveryAction.mock.calls[0][0];
    // Already recorded, with the exact request, although no answer exists yet.
    expect(stored()).toContain(sent.operationId);
    expect(stored()).toContain(JSON.stringify(sent.action.counterpartTransactionId));
    view.unmount();

    await open();
    // Reopened while the request is still on its way: nothing else can be started.
    await waitFor(() => expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(true));
    fireEvent.click(within(Y, 'Match with this'));
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
    // The answer arrives for the review that is gone: the operation is resolved for the one that is open.
    await act(async () => inFlight.resolve(answer('committed_fresh')));
    await waitFor(() => expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(false));
    expect(shownOperationId()).toBeNull();
    expect(stored()).toBe('');
  });

  it('a full reload or an app update: a FRESH copy of the app restores it from the browser, and replays the original request — not one rebuilt from what is on screen now', async () => {
    const { sent } = await sendAndLoseTheAnswer();
    cleanup();
    // A new page: every module is loaded again; only the browser's storage is left.
    vi.resetModules();
    const rtl = await import('@testing-library/react');
    const fresh = await import('./CardPaymentRecoveryReview');
    // The reloaded page sees NEWER versions than the ones the request was sent with.
    api.getRecoveryReviews.mockResolvedValue(page({ freshness: freshness({ input_version: 9, evaluated_version: 9, review_revision: 5 }) }));
    api.applyRecoveryAction.mockResolvedValueOnce(answer('replayed'));
    rtl.render(<fresh.CardPaymentRecoveryReview focusTransactionId={K} />);
    await rtl.waitFor(() => expect(rtl.screen.queryByTestId('unknown-outcome')?.getAttribute('data-operation-id')).toBe(sent.operationId));
    rtl.fireEvent.click(rtl.screen.getByRole('button', { name: 'Send the same request again' }));
    await rtl.waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(2));
    expect(api.applyRecoveryAction.mock.calls[1][0]).toEqual(sent);
    expect(api.applyRecoveryAction.mock.calls[1][0].expectedInputVersion).toBe(7);
    await rtl.waitFor(() => expect(rtl.screen.queryByTestId('unknown-outcome')).toBeNull());
    rtl.cleanup();
  });

  it('the same person signs in again (a new login): it is restored, and it is checked under the new login of that same person', async () => {
    api.getRecoveryAction.mockResolvedValue(notFound());
    const { view, sent } = await sendAndLoseTheAnswer();
    view.unmount();
    api.getCurrentSessionOwner.mockResolvedValue({ userId: 'user-a', sessionId: 'login-2' });
    await open();
    await waitFor(() => expect(shownOperationId()).toBe(sent.operationId));
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(api.getRecoveryAction).toHaveBeenCalledTimes(1));
    const [askedId, verify] = api.getRecoveryAction.mock.calls[0];
    expect(askedId).toBe(sent.operationId);
    expect(verify(sessionOf('user-a', 'login-2'))).toBe(true);
    expect(verify(sessionOf('user-a', 'login-1'))).toBe(false);
    expect(verify(sessionOf('user-b', 'login-2'))).toBe(false);
  });

  it('ANOTHER person signs in: they see nothing of it and nothing of it is asked or sent; it is kept; the first person gets it back', async () => {
    const { view, sent } = await sendAndLoseTheAnswer();
    view.unmount();
    api.getCurrentSessionOwner.mockResolvedValue({ userId: 'user-b', sessionId: 'login-9' });
    api.applyRecoveryAction.mockResolvedValueOnce(answer('committed_fresh'));
    const other = await open();
    await waitFor(() => expect(within(W, 'Match with this').hasAttribute('disabled')).toBe(false));
    expect(shownOperationId()).toBeNull();
    expect(text()).not.toContain(sent.operationId);
    expect(text()).not.toMatch(/We don't know whether/);
    expect(api.getRecoveryAction).not.toHaveBeenCalled();
    // The other person's own change is its own operation, and does not disturb the first person's record.
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(2));
    expect(api.applyRecoveryAction.mock.calls[1][0].operationId).not.toBe(sent.operationId);
    await waitFor(() => expect(text()).toContain('Saved.'));
    expect(stored()).toContain(sent.operationId);
    other.unmount();

    api.getCurrentSessionOwner.mockResolvedValue(OWNER);
    await open();
    await waitFor(() => expect(shownOperationId()).toBe(sent.operationId));
  });

  it('a LATE answer to the first person cannot clear or change the second person’s operation or screen', async () => {
    const first = deferred<ReturnType<typeof answer>>();
    api.applyRecoveryAction.mockReturnValueOnce(first.promise);
    const view = await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    const sentByA = api.applyRecoveryAction.mock.calls[0][0];
    view.unmount();

    api.getCurrentSessionOwner.mockResolvedValue({ userId: 'user-b', sessionId: 'login-9' });
    api.applyRecoveryAction.mockRejectedValueOnce(unknown());
    await open();
    await waitFor(() => expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(false));
    fireEvent.click(within(Y, 'Match with this'));
    await waitFor(() => expect(shownOperationId()).not.toBeNull());
    const sentByB = api.applyRecoveryAction.mock.calls[1][0];
    expect(sentByB.operationId).not.toBe(sentByA.operationId);
    expect(shownOperationId()).toBe(sentByB.operationId);

    // The first person's answer arrives now, while the second person is on screen.
    await act(async () => first.resolve(answer('committed_fresh')));
    await act(async () => {});
    expect(shownOperationId()).toBe(sentByB.operationId);
    expect(text()).not.toContain('Saved.');
    // It resolved the FIRST person's record, and only that one.
    expect(stored()).not.toContain(sentByA.operationId);
    expect(stored()).toContain(sentByB.operationId);
  });

  it('the browser cannot keep the record: the change is NOT sent, and the screen says why', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      await open();
      fireEvent.click(within(W, 'Match with this'));
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("This browser couldn't keep a record of that change, so it was not sent."));
      expect(api.applyRecoveryAction).not.toHaveBeenCalled();
      expect(shownOperationId()).toBeNull();
    } finally {
      setItem.mockRestore();
    }
  });

  it('a record that cannot be read is NOT thrown away: nothing new can be sent, it is not overwritten, and the screen says so', async () => {
    // Where this person's record is kept is found by leaving one there; the test does not name the key.
    const first = await sendAndLoseTheAnswer();
    first.view.unmount();
    expect(Object.keys(localStorage)).toHaveLength(1);
    const key = Object.keys(localStorage)[0];
    api.applyRecoveryAction.mockClear();
    for (const broken of ['{"format":1,"ownerUserId":"user-a","operationId":"not-an-id"', JSON.stringify({ format: 99, ownerUserId: 'user-a', operationId: '11111111-1111-4111-8111-111111111111' })]) {
      localStorage.setItem(key, broken);
      const view = await open();
      await waitFor(() => expect(screen.getByRole('alert').textContent).toContain("A change sent earlier from this browser is recorded in a form this version of the app can't read."));
      expect(within(W, 'Match with this').hasAttribute('disabled')).toBe(true);
      expect(button('Decide later').hasAttribute('disabled')).toBe(true);
      fireEvent.click(within(W, 'Match with this'));
      expect(api.applyRecoveryAction).not.toHaveBeenCalled();
      expect(localStorage.getItem(key)).toBe(broken);
      view.unmount();
    }
  });

  it('the ORIGINAL commits late: after the review was reopened the same id finds its receipt — one request was sent, and nothing was sent again', async () => {
    api.getRecoveryAction.mockResolvedValueOnce(notFound());
    const onChanged = vi.fn();
    const { view, sent } = await sendAndLoseTheAnswer({ focusTransactionId: K, onChanged });
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(text()).toContain('No record of it is visible yet.'));
    view.unmount();

    // The original request's transaction commits now. The reopened review asks about the same id.
    api.getRecoveryAction.mockResolvedValueOnce(found());
    await open({ focusTransactionId: K, onChanged });
    await waitFor(() => expect(shownOperationId()).toBe(sent.operationId));
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(text()).toContain('It was saved.'));
    expect(api.getRecoveryAction.mock.calls.map((c) => c[0])).toEqual([sent.operationId, sent.operationId]);
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
    expect(shownOperationId()).toBeNull();
    expect(stored()).toBe('');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('it is shown although the review itself cannot be read: the unresolved operation does not depend on the list', async () => {
    const { view, sent } = await sendAndLoseTheAnswer();
    view.unmount();
    api.getRecoveryReviews.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503, code: 'recovery_unavailable' }));
    api.getRecoveryAction.mockResolvedValueOnce(found());
    render(<CardPaymentRecoveryReview focusTransactionId={K} />);
    await waitFor(() => expect(shownOperationId()).toBe(sent.operationId));
    expect(text()).toContain("Payment review isn't available right now.");
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(text()).toContain('It was saved.'));
    expect(stored()).toBe('');
  });

  it('what is kept is the least that reconciliation needs: no token, no login, no amounts or names — and nothing at all once it is resolved', async () => {
    const { sent } = await sendAndLoseTheAnswer();
    const kept = stored();
    expect(kept).toContain(sent.operationId);
    expect(kept).toContain(OWNER.userId);
    expect(kept).not.toContain(OWNER.sessionId);
    expect(kept).not.toMatch(/token|bearer|password|secret|eyJ|amount_cents|Card Bank|institution/i);
    const record = JSON.parse(localStorage.getItem(Object.keys(localStorage)[0]) ?? '{}');
    expect(Object.keys(record).sort()).toEqual(['format', 'label', 'last', 'operationId', 'ownerUserId', 'recordedAt', 'request', 'status']);
    expect(record.request).toEqual(sent);
  });
});

// =====================================================================================================
// v4. Two tabs of the same user share one record. Every change of it is made under that user's journal lock,
// with the record read again inside; and an answer for one operation settles this screen only while this
// screen still shows THAT operation.
// =====================================================================================================

describe('two tabs of the same user: one record, changed by one tab at a time', () => {
  const unknown = () => Object.assign(new Error('The outcome of this request is not known.'), { status: 504, code: 'outcome_unknown' });
  const notFound = () => readRecoveryLookup({ found: false, receipt: null, freshness: freshness() });
  const found = () => readRecoveryLookup({ found: true, receipt: receipt({ operation_id: '11111111-1111-4111-8111-111111111111' }), freshness: freshness() });
  const shownOperationId = () => screen.queryByTestId('unknown-outcome')?.getAttribute('data-operation-id') ?? null;
  const KEY = `my-finances:card-payment-recovery:pending:v1:${OWNER.userId}`;
  const journal = () => localStorage.getItem(KEY);
  const OP_X = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const OP_Y = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const requestX = { operationId: OP_X, expectedInputVersion: 7, expectedReviewRevision: 3, action: { type: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: 0 } } as const;
  const requestY = { operationId: OP_Y, expectedInputVersion: 7, expectedReviewRevision: 3, action: { type: 'defer', transactionId: K } } as const;
  type Tab = typeof import('../lib/cardPaymentRecoveryPending');
  /** Another tab: its own copy of the app's code, the same browser storage and the same lock manager. */
  async function anotherTab(): Promise<Tab> {
    vi.resetModules();
    return import('../lib/cardPaymentRecoveryPending');
  }
  /** A change made in another tab reaches this one as the browser delivers it: a storage event. */
  const heardFromTheOtherTab = () =>
    act(async () => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    });
  const settled = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  /** Runs `step` ONCE: when this user's record has just been read, and before anything is done with what was read. */
  function rightAfterTheNextRead(step: () => void) {
    const original = Storage.prototype.getItem;
    let done = false;
    return vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      const value = original.call(this, key);
      if (!done && key === KEY) {
        done = true;
        step();
      }
      return value;
    });
  }
  /** In the other tab: X is resolved on the server's answer, and the user's next change Y is recorded and has no answer yet. */
  async function theOtherTabResolvesXAndRecordsY(operationIdOfX: string) {
    const tab = await anotherTab();
    expect(await tab.resolvePendingOperation(OWNER.userId, operationIdOfX)).toEqual({ ok: true });
    expect(await tab.recordPendingOperation({ ownerUserId: OWNER.userId, operationId: OP_Y, label: 'Decide later', request: requestY })).toEqual({ ok: true });
    expect(await tab.notePendingOperation(OWNER.userId, OP_Y, 'unknown', 'none')).toEqual({ ok: true });
    const recordedY = journal();
    await heardFromTheOtherTab();
    await waitFor(() => expect(shownOperationId()).toBe(OP_Y));
    return recordedY;
  }
  function expectYStillPendingHere(recordedY: string | null) {
    expect(shownOperationId(), 'Y must still be shown as the pending change on this screen').toBe(OP_Y);
    expect(journal(), 'Y must still be recorded, exactly as it was').toBe(recordedY);
    expect(screen.getByTestId('unknown-outcome').textContent).toContain("We don't know whether “Decide later” was saved");
    // Nothing of X's outcome is said as if it were Y's, and no other change can be started.
    // (The button "Check whether it was saved" is Y's own; an outcome is a sentence, with its full stop.)
    expect(text(), 'no outcome of X may be shown beside the pending Y').not.toMatch(/Saved\.|It was saved\.|already saved\.|[Nn]othing was saved/);
    expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(true);
    expect(button('Decide later').hasAttribute('disabled')).toBe(true);
  }

  it('ADMISSION — this tab shows nothing pending while another tab records X: the change clicked here is NOT sent, X is kept, and this tab shows X', async () => {
    await open();
    const tabA = await anotherTab();
    // What this tab saw before the click: nothing pending, every action offered.
    expect(button('Decide later').hasAttribute('disabled')).toBe(false);
    let clicked = false;
    // The click in this tab lands exactly between the other tab's read of the record and its write of X.
    const reads = rightAfterTheNextRead(() => {
      clicked = true;
      fireEvent.click(button('Decide later'));
    });
    const x = await tabA.recordPendingOperation({ ownerUserId: OWNER.userId, operationId: OP_X, label: 'Match these two', request: requestX });
    await act(settled);
    reads.mockRestore();
    expect(clicked).toBe(true);
    expect(api.applyRecoveryAction, 'the competing change (Y) must not be sent').not.toHaveBeenCalled();
    expect(x).toEqual({ ok: true });
    // X is the record, with its exact request: the click did not overwrite it.
    expect(JSON.parse(journal() ?? 'null')).toMatchObject({ ownerUserId: OWNER.userId, operationId: OP_X, request: requestX });
    await waitFor(() => expect(shownOperationId()).toBe(OP_X));
    expect(text()).toContain('An earlier change is still waiting to be checked, so this one was not sent. Nothing was saved.');
    expect(button('Decide later').hasAttribute('disabled')).toBe(true);
    expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(true);
  });

  it.each([
    ['is ANSWERED "saved"', (request: ReturnType<typeof deferred<ReturnType<typeof answer>>>) => request.resolve(answer('committed_fresh'))],
    ['ends with NO ANSWER (a timeout)', (request: ReturnType<typeof deferred<ReturnType<typeof answer>>>) => request.reject(unknown())],
    ['is REFUSED by the server', (request: ReturnType<typeof deferred<ReturnType<typeof answer>>>) => request.reject(Object.assign(new Error('stale'), { status: 409, code: 'stale_version' }))],
  ])('LATE RESULT FOR X — X was resolved in another tab and Y recorded there; then X\'s own request %s here: Y stays recorded and stays pending on this screen', async (_name, finish) => {
    const first = deferred<ReturnType<typeof answer>>();
    api.applyRecoveryAction.mockReturnValueOnce(first.promise);
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    const x = api.applyRecoveryAction.mock.calls[0][0];
    const recordedY = await theOtherTabResolvesXAndRecordsY(x.operationId);
    // X's own request ends now, in this tab.
    await act(async () => {
      finish(first);
      await settled();
    });
    expectYStillPendingHere(recordedY);
    fireEvent.click(within(Y, 'Match with this'));
    await act(settled);
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['FINDS the receipt of X', (lookup: ReturnType<typeof deferred<ReturnType<typeof found>>>) => lookup.resolve(found())],
    ['finds NO receipt of X', (lookup: ReturnType<typeof deferred<ReturnType<typeof found>>>) => lookup.resolve(notFound())],
    ['FAILS', (lookup: ReturnType<typeof deferred<ReturnType<typeof found>>>) => lookup.reject(new TypeError('Failed to fetch'))],
  ])('LATE CHECK OF X — while this tab asks about X, another tab resolves X and records Y; then the check %s: Y stays recorded and stays pending on this screen', async (_name, finish) => {
    api.applyRecoveryAction.mockRejectedValueOnce(unknown());
    const lookup = deferred<ReturnType<typeof found>>();
    api.getRecoveryAction.mockReturnValueOnce(lookup.promise);
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(shownOperationId()).not.toBeNull());
    const x = api.applyRecoveryAction.mock.calls[0][0];
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(api.getRecoveryAction).toHaveBeenCalledTimes(1));
    const recordedY = await theOtherTabResolvesXAndRecordsY(x.operationId);
    await act(async () => {
      finish(lookup);
      await settled();
    });
    expectYStillPendingHere(recordedY);
  });

  // The two tests below take the two protections one at a time. In the first this tab has not yet HEARD of Y when
  // X's answer arrives: only the record (read after the journal was asked) can tell it. In the second this tab
  // removed X's record itself, and Y appears on its screen before it has finished settling X: only what the
  // screen shows can tell it.
  it('LATE RESULT FOR X, before this tab has heard of Y — the record decides: Y is shown as pending, and X\'s "Saved." is not shown beside it', async () => {
    const first = deferred<ReturnType<typeof answer>>();
    api.applyRecoveryAction.mockReturnValueOnce(first.promise);
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    const x = api.applyRecoveryAction.mock.calls[0][0];
    const tab = await anotherTab();
    expect(await tab.resolvePendingOperation(OWNER.userId, x.operationId)).toEqual({ ok: true });
    expect(await tab.recordPendingOperation({ ownerUserId: OWNER.userId, operationId: OP_Y, label: 'Decide later', request: requestY })).toEqual({ ok: true });
    expect(await tab.notePendingOperation(OWNER.userId, OP_Y, 'unknown', 'none')).toEqual({ ok: true });
    const recordedY = journal();
    // No storage event has reached this tab: it still shows its own request for X as being sent.
    expect(text()).toContain('Saving: Match these two…');
    await act(async () => {
      first.resolve(answer('committed_fresh'));
      await settled();
    });
    expectYStillPendingHere(recordedY);
  });

  it('X IS RESOLVED HERE, and Y appears on this screen before X has finished settling — the screen decides: Y is not cleared, and X\'s "Saved." is not shown beside it', async () => {
    const first = deferred<ReturnType<typeof answer>>();
    api.applyRecoveryAction.mockReturnValueOnce(first.promise);
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    const x = api.applyRecoveryAction.mock.calls[0][0];
    // The moment X's record is removed by this tab, another tab's Y is in its place and this tab is told
    // (placed there by the test at the earliest possible moment; a browser delivers it some time after).
    const y = JSON.stringify({ format: 1, ownerUserId: OWNER.userId, operationId: OP_Y, label: 'Decide later', request: requestY, status: 'unknown', last: 'none', recordedAt: '2026-10-10T00:00:00.000Z' });
    const original = Storage.prototype.removeItem;
    const removals = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(function (this: Storage, key: string) {
      original.call(this, key);
      if (key !== KEY) return;
      removals.mockRestore();
      localStorage.setItem(KEY, y);
      window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    });
    await act(async () => {
      first.resolve(answer('committed_fresh'));
      await settled();
    });
    expect(x.operationId).not.toBe(OP_Y);
    expectYStillPendingHere(y);
  });

  it('RECORDED, THEN SENT — also when the journal lock has to be waited for: nothing is sent before the record exists, and the screen is busy meanwhile', async () => {
    let journalWhenSent: string | null = 'never sent';
    api.applyRecoveryAction.mockImplementation(async () => {
      journalWhenSent = journal();
      return answer('committed_fresh');
    });
    await open();
    // Another tab is changing the record right now: it holds the journal lock.
    let release!: () => void;
    const until = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding!: () => void;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    void navigator.locks.request(`my-finances:card-payment-recovery:pending-journal:v1:${OWNER.userId}`, { mode: 'exclusive' }, () => {
      holding();
      return until;
    });
    await held;
    fireEvent.click(within(W, 'Match with this'));
    await act(settled);
    // Waiting for its turn: not recorded, so not sent — and no second change can be started meanwhile.
    expect(api.applyRecoveryAction).not.toHaveBeenCalled();
    expect(journal()).toBeNull();
    expect(text()).toContain('Saving: Match these two…');
    expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(true);
    fireEvent.click(within(Y, 'Match with this'));
    await act(async () => {
      release();
      await settled();
    });
    await waitFor(() => expect(text()).toContain('Saved.'));
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
    const sent = api.applyRecoveryAction.mock.calls[0][0];
    expect(sent.action).toMatchObject({ type: 'pair_current', counterpartTransactionId: W });
    expect(JSON.parse(journalWhenSent ?? 'null')).toMatchObject({ operationId: sent.operationId, request: sent, status: 'sending' });
  });
});

describe('when the tabs cannot be coordinated, nothing unsafe is done', () => {
  const unknown = () => Object.assign(new Error('The outcome of this request is not known.'), { status: 504, code: 'outcome_unknown' });
  const found = () => readRecoveryLookup({ found: true, receipt: receipt({ operation_id: '11111111-1111-4111-8111-111111111111' }), freshness: freshness() });
  const shownOperationId = () => screen.queryByTestId('unknown-outcome')?.getAttribute('data-operation-id') ?? null;
  const journal = () => localStorage.getItem(`my-finances:card-payment-recovery:pending:v1:${OWNER.userId}`);
  const noWebLocks = () => Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: undefined });
  const alerts = () => screen.queryAllByRole('alert').map((element) => element.textContent ?? '').join(' | ');
  const settled = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it('no Web Locks in this browser: a change is NOT sent and nothing is recorded; the screen says why and stays usable', async () => {
    noWebLocks();
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(alerts()).toContain("This browser couldn't make sure that another open tab of the app isn't sending a change at the same moment, so this one was not sent. Nothing was saved."));
    expect(api.applyRecoveryAction).not.toHaveBeenCalled();
    expect(stored()).toBe('');
    expect(shownOperationId()).toBeNull();
    expect(text()).not.toContain('Saving:');
    // Nothing is stuck: with coordination available the same click is an ordinary change.
    installWebLocks();
    api.applyRecoveryAction.mockResolvedValueOnce(answer('committed_fresh'));
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(text()).toContain('Saved.'));
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
    expect(stored()).toBe('');
  });

  it('the answer arrives when the journal cannot be coordinated: the record is KEPT, the change stays pending here, the screen says so — and a later check clears it', async () => {
    const sent = deferred<ReturnType<typeof answer>>();
    api.applyRecoveryAction.mockReturnValueOnce(sent.promise);
    api.getRecoveryAction.mockResolvedValueOnce(found());
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    const x = api.applyRecoveryAction.mock.calls[0][0];
    const before = journal();
    expect(before).toContain(x.operationId);
    noWebLocks();
    await act(async () => {
      sent.resolve(answer('committed_fresh'));
      await settled();
    });
    expect(journal()).toBe(before);
    await waitFor(() => expect(shownOperationId()).toBe(x.operationId));
    expect(alerts()).toContain("This change was answered, but this browser couldn't update its own record of it just now, so it is still listed as waiting. Check it again in a moment.");
    expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(true);
    // Coordination is back: the same operation id is asked about, its receipt is found, and the record is removed.
    installWebLocks();
    fireEvent.click(button('Check whether it was saved'));
    await waitFor(() => expect(text()).toContain('It was saved.'));
    expect(api.getRecoveryAction.mock.calls[0][0]).toBe(x.operationId);
    expect(stored()).toBe('');
    expect(shownOperationId()).toBeNull();
    expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1);
  });

  it('no answer came AND the journal cannot be coordinated: the record is kept as it is, and the change is shown as unknown — never as failed', async () => {
    const sent = deferred<ReturnType<typeof answer>>();
    api.applyRecoveryAction.mockReturnValueOnce(sent.promise);
    await open();
    fireEvent.click(within(W, 'Match with this'));
    await waitFor(() => expect(api.applyRecoveryAction).toHaveBeenCalledTimes(1));
    const x = api.applyRecoveryAction.mock.calls[0][0];
    const before = journal();
    noWebLocks();
    await act(async () => {
      sent.reject(unknown());
      await settled();
    });
    expect(journal()).toBe(before);
    await waitFor(() => expect(shownOperationId()).toBe(x.operationId));
    expect(alerts()).toContain("We don't know whether “Match these two” was saved");
    expect(text()).not.toMatch(/Nothing was saved|was not saved/i);
    expect(within(Y, 'Match with this').hasAttribute('disabled')).toBe(true);
  });
});
