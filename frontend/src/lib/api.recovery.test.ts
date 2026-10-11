import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('./supabaseClient', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

import { applyRecoveryAction, getCurrentSessionOwner, getRecoveryAction, getRecoveryReviews, requestRecoveryRefresh, RECOVERY_OUTCOME_UNKNOWN, SESSION_OWNER_MISMATCH, SESSION_OWNER_REQUIRED } from './api';
import { appUpdate, CLIENT_API_LEVEL } from './appUpdate';

// The recovery requests this client sends (I3A-R packet 2-A): one request per action, no owner in any of them,
// a change never sent without (or under the wrong) signed-in owner, and how a refusal or an unknown outcome
// reaches the caller.

const SESSION = { user: { id: 'user-a' }, access_token: 'a-token' };
const OP = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';
const W = '33333333-3333-4333-8333-333333333333';

const freshness = { fresh: true, input_version: 7, evaluated_version: 7, review_revision: 3, last_error_code: null, refresh: { queued: false, needs_attention: false, attempts: 0 } };
const receipt = { operation_id: OP, action: 'pair_current', outcome: 'saved', reason: null, decision_id: K, superseded_decision_ids: [], retained_obligation_ids: [], permanent_retirement: false, committed_at: '2026-10-09T12:00:00+00:00' };
const answerBody = { status: 'committed_fresh', receipt, freshness };
const reviewsBody = { fresh: true, freshness, actions_enabled: false, affected_payment_count: 0, next_cursor: null, reviews: [] };

function response(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, headers: new Headers(), json: () => Promise.resolve(body) };
}
function lastRequest(): { url: URL; init: RequestInit } {
  const call = vi.mocked(fetch).mock.calls.at(-1);
  if (!call) throw new Error('no request was sent');
  return { url: new URL(String(call[0]).replace(/^undefined/, ''), 'http://api.test'), init: call[1] as RequestInit };
}
const owner = () => true;
const request = { operationId: OP, expectedInputVersion: 7, expectedReviewRevision: 3, action: { type: 'pair_current' as const, transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: 0 } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  mockGetSession.mockResolvedValue({ data: { session: SESSION } });
  appUpdate.reportServerLevels(CLIENT_API_LEVEL, 0);
});

describe('reads', () => {
  it('getRecoveryReviews: a GET with a limit and, for a later page, the cursor', async () => {
    vi.mocked(fetch).mockResolvedValue(response(reviewsBody) as never);
    expect(await getRecoveryReviews()).toMatchObject({ kind: 'ok', actions_enabled: false });
    expect(lastRequest().url.pathname).toBe('/api/card-payment-recovery/reviews');
    expect(lastRequest().url.searchParams.get('limit')).toBe('50');
    expect(lastRequest().url.searchParams.has('cursor')).toBe(false);
    expect(lastRequest().init.method).toBeUndefined();
    await getRecoveryReviews({ cursor: `2026-09-10|${K}`, limit: 5 });
    expect(Object.fromEntries(lastRequest().url.searchParams)).toEqual({ limit: '5', cursor: `2026-09-10|${K}` });
  });

  it('a body this build cannot read is `invalid` — not an error, and never a review', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ ...reviewsBody, reviews: [{ transaction_id: K }] }) as never);
    expect(await getRecoveryReviews()).toEqual({ kind: 'invalid' });
  });

  it('getRecoveryAction: a GET for that operation id', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ found: false, receipt: null, freshness }) as never);
    expect(await getRecoveryAction(OP)).toMatchObject({ kind: 'ok', found: false });
    expect(lastRequest().url.pathname).toBe(`/api/card-payment-recovery/actions/${OP}`);
  });

  it('getRecoveryAction with the sender\'s ownership check: asked under that login; under another, NOTHING is asked', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ found: false, receipt: null, freshness }) as never);
    expect(await getRecoveryAction(OP, () => true)).toMatchObject({ kind: 'ok', found: false });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    vi.mocked(fetch).mockClear();
    await expect(getRecoveryAction(OP, () => false)).rejects.toMatchObject({ code: SESSION_OWNER_MISMATCH });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('getCurrentSessionOwner: the user and the login lifecycle of the current session, or null', async () => {
    // header {"alg":"none"} . payload {"session_id":"login-1"} . signature
    const token = `${btoa('{"alg":"none"}')}.${btoa('{"session_id":"login-1"}')}.x`;
    mockGetSession.mockResolvedValueOnce({ data: { session: { user: { id: 'user-a' }, access_token: token } } });
    expect(await getCurrentSessionOwner()).toEqual({ userId: 'user-a', sessionId: 'login-1' });
    mockGetSession.mockResolvedValueOnce({ data: { session: null } });
    expect(await getCurrentSessionOwner()).toBeNull();
  });
});

describe('changes', () => {
  it('applyRecoveryAction: ONE POST whose body is exactly the request — no owner anywhere', async () => {
    vi.mocked(fetch).mockResolvedValue(response(answerBody) as never);
    expect(await applyRecoveryAction(request, owner)).toMatchObject({ kind: 'ok', status: 'committed_fresh' });
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    const { url, init } = lastRequest();
    expect(url.pathname).toBe('/api/card-payment-recovery/actions');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(request);
    expect(String(init.body)).not.toMatch(/user|owner/i);
  });

  it('requestRecoveryRefresh: ONE POST with the operation id and nothing else', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ status: 'queued', receipt: { ...receipt, action: 'refresh_retry', outcome: 'queued', decision_id: null }, freshness }) as never);
    expect(await requestRecoveryRefresh(OP, owner)).toMatchObject({ kind: 'ok', status: 'queued' });
    const { url, init } = lastRequest();
    expect(url.pathname).toBe('/api/card-payment-recovery/refresh-retries');
    expect(JSON.parse(String(init.body))).toEqual({ operationId: OP });
  });

  it('a change is never sent without an owner check, and never under another login', async () => {
    await expect(applyRecoveryAction(request, undefined as never)).rejects.toMatchObject({ code: SESSION_OWNER_REQUIRED });
    await expect(requestRecoveryRefresh(OP, () => false)).rejects.toMatchObject({ code: SESSION_OWNER_MISMATCH });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a refusal carries the server\'s code, its fixed detail word and the status', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ error: 'This action cannot be applied to these transactions.', code: 'invalid_action', detail: 'difference_not_accepted' }, { ok: false, status: 422 }) as never);
    await expect(applyRecoveryAction(request, owner)).rejects.toMatchObject({ code: 'invalid_action', detail: 'difference_not_accepted', status: 422 });
  });

  it('an unknown outcome carries its code and the operation id to ask about; nothing is retried', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ error: 'The outcome of this request is not known.', code: 'outcome_unknown', operation_id: OP }, { ok: false, status: 504 }) as never);
    await expect(applyRecoveryAction(request, owner)).rejects.toMatchObject({ code: RECOVERY_OUTCOME_UNKNOWN, operation_id: OP, status: 504 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a lost connection rejects as it is — with no status — and is not retried', async () => {
    vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(applyRecoveryAction(request, owner)).rejects.toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
