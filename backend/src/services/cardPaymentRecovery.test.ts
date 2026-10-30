import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockRpc = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { rpc: mockRpc } }));

import {
  applyRecoveryAction,
  claimRecoveryRefresh,
  parseRecoveryActionRequest,
  parseRecoveryReviews,
  parseRefreshRetryRequest,
  parseReviewsQuery,
  readRecoveryAction,
  readRecoveryReviews,
  RECOVERY_ACTION_TIMEOUT_MS,
  RECOVERY_REFRESH_TIMEOUT_MS,
  refreshRecoveryOwner,
  requestRecoveryRefresh,
  type RecoveryActionRequest,
} from './cardPaymentRecovery';

/** A postgrest-js-shaped builder: `.rpc(...).abortSignal(signal)` resolves to `result(signal)`. */
function respond(result: (signal: AbortSignal) => Promise<unknown>) {
  const abortSignal = vi.fn((signal: AbortSignal) => result(signal));
  mockRpc.mockReturnValue({ abortSignal });
  return abortSignal;
}
const answer = (data: unknown) => respond(async () => ({ data, error: null, status: 200 }));
const fail = (error: Record<string, unknown>, status = 400) => respond(async () => ({ data: null, error, status }));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER = '00000000-0000-0000-0000-0000000000bb';
const OP = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';
const W = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const OBLIGATION = '55555555-5555-4555-8555-555555555555';
const ACCOUNT = '66666666-6666-4666-8666-666666666666';

const freshness = (over: Record<string, unknown> = {}) => ({
  fresh: true,
  inputVersion: 7,
  evaluatedVersion: 7,
  lastErrorCode: null,
  reviewRevision: 3,
  refresh: { queued: false, needsAttention: false, attempts: 0 },
  ...over,
});
const receipt = (over: Record<string, unknown> = {}) => ({
  operationId: OP,
  action: 'pair_current',
  intent: { action: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: 0 },
  outcome: 'saved',
  reason: null,
  decisionId: D,
  supersededDecisionIds: [],
  subjectTransactionIds: [K, W],
  retainedObligationIds: [OBLIGATION],
  permanentRetirement: false,
  expectedInputVersion: 6,
  expectedReviewRevision: 3,
  committedInputVersion: 7,
  committedReviewRevision: 3,
  committedAt: '2026-10-09T12:00:00+00:00',
  ...over,
});
const review = (over: Record<string, unknown> = {}) => ({
  transactionId: K,
  accountId: ACCOUNT,
  date: '2026-09-10',
  amountCents: 37000,
  pending: false,
  side: 'cash',
  direction: 'payment',
  accountIncluded: true,
  state: 'unresolved',
  reason: 'relink_review_required',
  detail: null,
  effectCents: null,
  lowCents: -37000,
  highCents: 0,
  partnerTransactionId: null,
  guardWithheld: true,
  withheldPartnerTransactionId: W,
  coverageGap: false,
  controllingDecision: null,
  deferred: false,
  obligations: [
    {
      obligationId: OBLIGATION,
      origin: 'captured',
      completeness: 'complete',
      gapReason: null,
      removalId: D,
      institutionName: 'Card Bank',
      removedOn: '2026-10-01',
      knownSurvivingEdgeCount: 1,
      sources: [
        { evidenceKind: 'removed_destination', decisionId: D, decisionKind: 'destination_removed_card', decisionStatus: 'active', sourceRelation: 'automatic_partner', sourceDate: '2026-09-11', sourceCents: -37000, sourceKnown: true },
      ],
    },
  ],
  candidates: [
    { transactionId: W, accountId: ACCOUNT, date: '2026-09-11', amountCents: -37000, pending: false, accountIncluded: true, kind: 'tier1_competitor', distanceDays: 1, differenceCents: 0, withheldByGuard: true, suggestionOnly: true, rejected: false },
  ],
  ...over,
});
const page = (over: Record<string, unknown> = {}) => ({ fresh: true, freshness: freshness(), reviews: [review()], nextCursor: null, affectedPaymentCount: 1, ...over });

const request: RecoveryActionRequest = {
  operationId: OP,
  expectedInputVersion: 6,
  expectedReviewRevision: 3,
  intent: { action: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: 0 },
};
const loggedText = () => JSON.stringify(warn.mock.calls);

describe('parseRecoveryActionRequest — the six actions, and nothing else', () => {
  const base = { operationId: OP, expectedInputVersion: 6, expectedReviewRevision: 3 };

  it('copies exactly the fields each action has', () => {
    expect(parseRecoveryActionRequest({ ...base, action: { type: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: -200 } })?.intent).toEqual({
      action: 'pair_current',
      transactionId: K,
      counterpartTransactionId: W,
      acceptedDifferenceCents: -200,
    });
    expect(parseRecoveryActionRequest({ ...base, action: { type: 'confirm_unlinked', transactionId: K } })?.intent).toEqual({ action: 'confirm_unlinked', transactionId: K });
    expect(parseRecoveryActionRequest({ ...base, action: { type: 'dismiss_candidate', transactionId: K, candidateTransactionId: W } })?.intent).toEqual({
      action: 'dismiss_candidate',
      transactionId: K,
      candidateTransactionId: W,
    });
    expect(parseRecoveryActionRequest({ ...base, action: { type: 'undo_decision', decisionId: D } })?.intent).toEqual({ action: 'undo_decision', decisionId: D });
    expect(parseRecoveryActionRequest({ ...base, action: { type: 'reject_suggestion', transactionId: K, candidateTransactionId: W } })?.intent).toEqual({
      action: 'reject_suggestion',
      transactionId: K,
      candidateTransactionId: W,
    });
    expect(parseRecoveryActionRequest({ ...base, action: { type: 'defer', transactionId: K } })?.intent).toEqual({ action: 'defer', transactionId: K });
  });

  it('never carries an owner or any other field a browser adds', () => {
    const parsed = parseRecoveryActionRequest({
      ...base,
      userId: OTHER,
      p_user_id: OTHER,
      owner: OTHER,
      action: { type: 'defer', transactionId: K, userId: OTHER, user_id: OTHER, targetVersion: 99, retire: true },
    });
    expect(parsed).toEqual({ operationId: OP, expectedInputVersion: 6, expectedReviewRevision: 3, intent: { action: 'defer', transactionId: K } });
    expect(JSON.stringify(parsed)).not.toContain(OTHER);
  });

  it.each([
    ['a retirement', { type: 'retire_hold', transactionId: K }],
    ['a generic "reviewed" switch', { type: 'mark_reviewed', transactionId: K }],
    ['a guard release', { type: 'release_guard', transactionId: K }],
    ['a refresh retry sent as an action', { type: 'refresh_retry' }],
    ['no type', { transactionId: K }],
    ['a missing counterpart', { type: 'pair_current', transactionId: K, acceptedDifferenceCents: 0 }],
    ['a missing accepted difference', { type: 'pair_current', transactionId: K, counterpartTransactionId: W }],
    ['a fractional accepted difference', { type: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: 0.5 }],
    ['an id that is not a uuid', { type: 'defer', transactionId: "k'; drop table accounts; --" }],
    ['an upper-case uuid (the database prints lower case)', { type: 'defer', transactionId: K.toUpperCase().replace(/2/g, 'A') }],
  ])('refuses %s', (_name, action) => {
    expect(parseRecoveryActionRequest({ ...base, action })).toBeNull();
  });

  it.each([
    ['no operation id', { expectedInputVersion: 6, expectedReviewRevision: 3 }],
    ['a negative version', { operationId: OP, expectedInputVersion: -1, expectedReviewRevision: 3 }],
    ['a version sent as text', { operationId: OP, expectedInputVersion: '6', expectedReviewRevision: 3 }],
    ['no review revision', { operationId: OP, expectedInputVersion: 6 }],
  ])('refuses a request with %s', (_name, head) => {
    expect(parseRecoveryActionRequest({ ...head, action: { type: 'defer', transactionId: K } })).toBeNull();
  });

  it('refuses anything that is not an object', () => {
    for (const body of [null, undefined, 'defer', 7, [], [{ type: 'defer' }]]) expect(parseRecoveryActionRequest(body)).toBeNull();
  });
});

describe('parseRefreshRetryRequest and parseReviewsQuery', () => {
  it('a retry is an operation id; an owner or a target version in the body is not read', () => {
    expect(parseRefreshRetryRequest({ operationId: OP, userId: OTHER, targetVersion: 99 })).toEqual({ operationId: OP });
    expect(parseRefreshRetryRequest({})).toBeNull();
    expect(parseRefreshRetryRequest({ operationId: 'x' })).toBeNull();
  });

  it('defaults to 20 rows and accepts 1 to 50', () => {
    expect(parseReviewsQuery({})).toEqual({ cursor: null, limit: 20 });
    expect(parseReviewsQuery({ limit: '50', cursor: `2026-09-10|${K}` })).toEqual({ cursor: `2026-09-10|${K}`, limit: 50 });
    for (const limit of ['0', '51', '-1', '1e1', ' 5', '05', 'all']) expect(parseReviewsQuery({ limit })).toBeNull();
    for (const cursor of ['', 'x', `2026-09-10|${K} or 1=1`, ['a', 'b']]) expect(parseReviewsQuery({ cursor })).toBeNull();
  });
});

describe('parseRecoveryReviews — only the documented shape', () => {
  it('accepts a fresh page and keeps every field', () => {
    const parsed = parseRecoveryReviews(page());
    expect(parsed?.reviews[0]).toMatchObject({ transactionId: K, reason: 'relink_review_required', effectCents: null, lowCents: -37000, highCents: 0, guardWithheld: true, withheldPartnerTransactionId: W });
    expect(parsed?.reviews[0].candidates[0]).toMatchObject({ suggestionOnly: true, withheldByGuard: true });
    expect(parsed?.reviews[0].obligations[0].sources[0]).toMatchObject({ evidenceKind: 'removed_destination', sourceCents: -37000 });
  });

  // A removed candidate the removal read from the eligible graph and wrote NO decision for (the capture's
  // graph_source): it names no decision, and nothing else may come without one.
  const graphSource = { evidenceKind: 'graph_source', decisionId: null, decisionKind: null, decisionStatus: null, sourceRelation: 'removed_candidate', sourceDate: '2026-09-11', sourceCents: -37000, sourceKnown: true };
  const withSources = (sources: unknown[]) => page({ reviews: [review({ obligations: [{ ...review().obligations[0], sources }] })] });

  it('a graph-observed source names no decision: it is kept, beside a decision-backed one, as two sources', () => {
    const parsed = parseRecoveryReviews(withSources([review().obligations[0].sources[0], graphSource, { ...graphSource, sourceDate: '2026-09-12' }]));
    expect(parsed?.reviews[0].obligations[0].sources).toHaveLength(3);
    expect(parsed?.reviews[0].obligations[0].sources[1]).toEqual({ evidenceKind: 'graph_source', decisionId: null, decisionKind: null, decisionStatus: null, sourceRelation: 'removed_candidate', sourceDate: '2026-09-11', sourceCents: -37000, sourceKnown: true });
    expect(parsed?.reviews[0].obligations[0].sources[0].decisionId).toBe(D);
  });

  it.each([
    ['a graph-observed source that names a decision', { ...graphSource, decisionId: D, decisionKind: 'destination_removed_card' }],
    ['a graph-observed source with a decision kind and no decision', { ...graphSource, decisionKind: 'destination_removed_card' }],
    ['a decision-backed source without its decision', { ...graphSource, evidenceKind: 'removed_destination' }],
    ['a decision-backed source without its decision kind', { ...graphSource, evidenceKind: 'ambiguity_hold', decisionId: D }],
  ])('refuses %s (no decision is invented, and none is dropped)', (_name, source) => {
    expect(parseRecoveryReviews(withSources([source]))).toBeNull();
  });

  it('accepts a page that is not fresh only when it carries no review', () => {
    const stale = freshness({ fresh: false, evaluatedVersion: 6 });
    expect(parseRecoveryReviews({ fresh: false, freshness: stale, reviews: [], nextCursor: null, affectedPaymentCount: 1 })?.reviews).toEqual([]);
    expect(parseRecoveryReviews({ fresh: false, freshness: stale, reviews: [review()], nextCursor: null, affectedPaymentCount: 1 })).toBeNull();
  });

  it.each([
    ['"fresh" with unequal versions', page({ freshness: freshness({ evaluatedVersion: 6 }) })],
    ['the two freshness statements disagree', page({ fresh: false })],
    ['a candidate not marked as a suggestion', page({ reviews: [review({ candidates: [{ ...review().candidates[0], suggestionOnly: false }] })] })],
    ['a withheld leg that names a partner', page({ reviews: [review({ partnerTransactionId: W })] })],
    ['a withheld leg with no withheld partner', page({ reviews: [review({ withheldPartnerTransactionId: null })] })],
    ['an effect outside its own bounds', page({ reviews: [review({ effectCents: 0 })] })],
    ['bounds the wrong way round', page({ reviews: [review({ lowCents: 0, highCents: -37000 })] })],
    ['a gap obligation without its reason', page({ reviews: [review({ obligations: [{ ...review().obligations[0], origin: 'gap' }] })] })],
    ['an unknown origin', page({ reviews: [review({ obligations: [{ ...review().obligations[0], origin: 'reconstructed' }] })] })],
    ['an unknown evidence kind', page({ reviews: [review({ obligations: [{ ...review().obligations[0], sources: [{ ...review().obligations[0].sources[0], evidenceKind: 'verified_return' }] }] })] })],
    ['a malformed cursor', page({ nextCursor: 'next' })],
    ['a figure where a count belongs', page({ affectedPaymentCount: -1 })],
  ])('refuses %s', (_name, payload) => {
    expect(parseRecoveryReviews(payload)).toBeNull();
  });
});

describe('applyRecoveryAction — one database call, mapped outcomes', () => {
  it('calls the ONE wrapper once, with the owner it was given and the intent — and nothing else', async () => {
    const abortSignal = answer({ status: 'committed_fresh', receipt: receipt(), freshness: freshness() });
    const result = await applyRecoveryAction(USER, request);
    expect(result).toMatchObject({ kind: 'ok', value: { status: 'committed_fresh' } });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('apply_card_payment_recovery_action', {
      p_user_id: USER,
      p_operation_id: OP,
      p_expected_input_version: 6,
      p_expected_review_revision: 3,
      p_action: { action: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: 0 },
    });
    expect(abortSignal.mock.calls[0][0]).toBeInstanceOf(AbortSignal);
    expect(Number.isFinite(RECOVERY_ACTION_TIMEOUT_MS)).toBe(true);
  });

  it('committed_pending: the action committed and the figures are not current — an ok answer, with no figure', async () => {
    answer({ status: 'committed_pending', receipt: receipt(), freshness: freshness({ fresh: false, evaluatedVersion: 6, refresh: { queued: true, needsAttention: false, attempts: 0 } }) });
    const result = await applyRecoveryAction(USER, request);
    expect(result).toMatchObject({ kind: 'ok', value: { status: 'committed_pending', freshness: { fresh: false, refresh: { queued: true } } } });
    expect(JSON.stringify(result)).not.toMatch(/effectCents|lowCents|highCents|"legs"/);
  });

  it('replayed: the receipt of the earlier commit', async () => {
    answer({ status: 'replayed', receipt: receipt(), freshness: freshness() });
    expect(await applyRecoveryAction(USER, request)).toMatchObject({ kind: 'ok', value: { status: 'replayed', receipt: { operationId: OP, retainedObligationIds: [OBLIGATION], permanentRetirement: false } } });
  });

  it.each([
    ['"committed_fresh" while the database says the figures are not current', { status: 'committed_fresh', receipt: receipt(), freshness: freshness({ fresh: false, evaluatedVersion: 6 }) }],
    ['a receipt for another operation', { status: 'committed_fresh', receipt: receipt({ operationId: D }), freshness: freshness() }],
    ['a receipt that claims a retirement', { status: 'committed_fresh', receipt: receipt({ permanentRetirement: true }), freshness: freshness() }],
    ['a refresh answer to an action', { status: 'queued', receipt: receipt({ action: 'refresh_retry', intent: { action: 'refresh_retry' }, outcome: 'queued' }), freshness: freshness() }],
    ['an unknown status', { status: 'done', receipt: receipt(), freshness: freshness() }],
    ['no receipt', { status: 'committed_fresh', freshness: freshness() }],
    ['true', true],
  ])('an answer outside the documented shape is unavailable, never a success: %s', async (_name, data) => {
    answer(data);
    expect(await applyRecoveryAction(USER, request)).toEqual({ kind: 'unavailable', reason: 'unexpected_response' });
  });

  it.each([
    ['card_payment_stale_version: apply_card_payment_recovery_action: the matching state changed', 'stale_version', null],
    ['card_payment_recovery_stale_review: apply_card_payment_recovery_action: the review changed', 'stale_review', null],
    ['card_payment_recovery_operation_conflict: apply_card_payment_recovery_action: this operation id was already used', 'operation_conflict', null],
    ['card_payment_recovery_not_reviewable: apply_card_payment_recovery_action: this is not under review', 'not_reviewable', null],
    ['card_payment_not_found: link_card_payment: transaction not found', 'not_found', null],
    ['card_payment_counterpart_reserved: link_card_payment: the chosen transaction belongs to another confirmed match', 'counterpart_reserved', null],
    ['card_payment_pair_confirmed: dismiss_card_payment_candidate: these transactions are a saved match', 'pair_confirmed', null],
    ['card_payment_decision_replaced: undo_card_payment_decision: the decision was replaced', 'decision_replaced', null],
    ['card_payment_invalid: link_card_payment: difference_not_accepted (the accepted difference must equal |cash| - |credit| exactly)', 'invalid_action', 'difference_not_accepted'],
    ['card_payment_invalid: undo_card_payment_decision: system_decision (written by an institution removal, not by the user)', 'invalid_action', 'system_decision'],
    ['card_payment_ineligible: link_card_payment: not_card_payment', 'invalid_action', 'not_card_payment'],
    ['card_payment_recovery_invalid: apply_card_payment_recovery_action: not_a_suggestion', 'invalid_action', 'not_a_suggestion'],
  ])('a refusal becomes a code and a fixed word, never the message: %s', async (message, code, detail) => {
    fail({ code: 'P0001', message });
    const result = await applyRecoveryAction(USER, request);
    expect(result).toEqual({ kind: 'refused', code, detail });
    expect(JSON.stringify(result)).not.toContain('apply_card_payment_recovery_action');
    expect(mockRpc).toHaveBeenCalledTimes(1);
  });

  it.each([['40001'], ['40P01'], ['55P03']])('SQLSTATE %s (serialization, deadlock, lock not available): nothing was written; retry', async (code) => {
    fail({ code, message: 'deadlock detected' });
    expect(await applyRecoveryAction(USER, request)).toEqual({ kind: 'refused', code: 'retry', detail: null });
  });

  it('a timeout is an UNKNOWN outcome — not a failure, not a rollback', async () => {
    vi.useFakeTimers();
    try {
      respond((signal) => new Promise((resolve) => signal.addEventListener('abort', () => resolve({ data: null, error: { message: 'aborted' }, status: 0 }))));
      const pending = applyRecoveryAction(USER, request, { timeoutMs: 50 });
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toEqual({ kind: 'outcome_unknown' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a statement cancelled on the server (57014) is an unknown outcome too', async () => {
    fail({ code: '57014', message: 'canceling statement due to statement timeout' });
    expect(await applyRecoveryAction(USER, request)).toEqual({ kind: 'outcome_unknown' });
  });

  it('a thrown request with no timeout: no answer was obtained', async () => {
    respond(async () => {
      throw new TypeError('fetch failed');
    });
    expect(await applyRecoveryAction(USER, request)).toEqual({ kind: 'unavailable', reason: 'request_failed' });
  });

  it('the functions are missing: unavailable, said once in the log by code', async () => {
    fail({ code: 'PGRST202', message: 'Could not find the function public.apply_card_payment_recovery_action' }, 404);
    expect(await applyRecoveryAction(USER, request)).toEqual({ kind: 'unavailable', reason: 'objects_missing' });
    expect(loggedText()).toContain('PGRST202');
  });

  it('an error it does not know is unavailable, and its message is neither returned nor logged', async () => {
    fail({ code: 'XX000', message: `internal error near user ${USER} token sk_live_secret` });
    const result = await applyRecoveryAction(USER, request);
    expect(result).toEqual({ kind: 'unavailable', reason: 'request_error' });
    expect(loggedText()).not.toContain('sk_live_secret');
    expect(loggedText()).not.toContain(USER);
  });
});

describe('the other calls', () => {
  it('readRecoveryReviews: one call, the owner, the cursor and the limit', async () => {
    answer(page());
    expect(await readRecoveryReviews(USER, { cursor: null, limit: 20 })).toMatchObject({ kind: 'ok', value: { fresh: true, affectedPaymentCount: 1 } });
    expect(mockRpc).toHaveBeenCalledWith('get_card_payment_recovery_reviews', { p_user_id: USER, p_cursor: null, p_limit: 20 });
  });

  it('readRecoveryAction: found, absent, and a mismatched receipt', async () => {
    answer({ found: true, receipt: receipt(), freshness: freshness() });
    expect(await readRecoveryAction(USER, OP)).toMatchObject({ kind: 'ok', value: { found: true, receipt: { operationId: OP } } });
    answer({ found: false, receipt: null, freshness: freshness() });
    expect(await readRecoveryAction(USER, OP)).toMatchObject({ kind: 'ok', value: { found: false, receipt: null } });
    answer({ found: true, receipt: receipt({ operationId: D }), freshness: freshness() });
    expect(await readRecoveryAction(USER, OP)).toEqual({ kind: 'unavailable', reason: 'unexpected_response' });
  });

  it('requestRecoveryRefresh: the owner and the operation id only; a queued refresh receipt', async () => {
    const refreshReceipt = receipt({ action: 'refresh_retry', intent: { action: 'refresh_retry' }, outcome: 'queued', decisionId: null, subjectTransactionIds: [], retainedObligationIds: [], expectedInputVersion: null, expectedReviewRevision: null });
    answer({ status: 'queued', receipt: refreshReceipt, freshness: freshness({ fresh: false, evaluatedVersion: 6, refresh: { queued: true, needsAttention: false, attempts: 0 } }) });
    expect(await requestRecoveryRefresh(USER, OP)).toMatchObject({ kind: 'ok', value: { status: 'queued', receipt: { action: 'refresh_retry' } } });
    expect(mockRpc).toHaveBeenCalledWith('request_card_payment_recovery_refresh', { p_user_id: USER, p_operation_id: OP });
    // A payment action's receipt is never accepted as the answer to a refresh request.
    answer({ status: 'replayed', receipt: receipt(), freshness: freshness() });
    expect(await requestRecoveryRefresh(USER, OP)).toEqual({ kind: 'unavailable', reason: 'unexpected_response' });
  });

  it('claimRecoveryRefresh and refreshRecoveryOwner: the worker\'s two calls', async () => {
    answer({ claims: [{ userId: USER, leaseToken: OP, targetVersion: 7, attempts: 0 }], leaseSeconds: 120 });
    expect(await claimRecoveryRefresh(D, 10)).toEqual({ kind: 'ok', value: [{ userId: USER, leaseToken: OP, targetVersion: 7, attempts: 0 }] });
    expect(mockRpc).toHaveBeenCalledWith('claim_card_payment_recovery_refresh', { p_worker_token: D, p_limit: 10 });
    answer({ status: 'pending', attempts: 3, needsAttention: false });
    expect(await refreshRecoveryOwner(USER, OP)).toEqual({ kind: 'ok', value: { status: 'pending' } });
    expect(mockRpc).toHaveBeenLastCalledWith('refresh_card_payment_recovery_owner', { p_user_id: USER, p_lease_token: OP });
    answer({ status: 'evaluated' });
    expect(await refreshRecoveryOwner(USER, OP)).toEqual({ kind: 'unavailable', reason: 'unexpected_response' });
    // The refresh timeout is shorter than the 120 s lease the database hands out.
    expect(RECOVERY_REFRESH_TIMEOUT_MS).toBeLessThan(120_000);
  });
});
