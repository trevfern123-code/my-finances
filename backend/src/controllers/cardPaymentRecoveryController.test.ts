import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// The recovery endpoints through the REAL Express app (app.ts): the client-API-level gate, body parsing,
// requireAuth's place in the chain, the router, the controller and the service. Only the edges are replaced:
// the environment, the Supabase client (its `rpc`), and requireAuth's verification — which here sets the
// session's user from a test header, exactly where the real one sets it from a verified token.
const mockEnv = vi.hoisted(() => ({
  port: 0,
  frontendUrl: 'https://app.example.test',
  supabaseUrl: 'https://supabase.example.test',
  supabaseServiceRoleKey: 'test-service-role-key',
  plaidClientId: 'test-client',
  plaidSecret: 'test-secret',
  plaidEnv: 'sandbox',
  plaidProducts: ['transactions'],
  plaidCountryCodes: ['US'],
  backendPublicUrl: null,
  cardPaymentSyncEvaluationEnabled: false,
  cardPaymentRecoveryActionsEnabled: false,
  cardPaymentRecoveryWorkerEnabled: false,
}));
vi.mock('../config/env', () => ({ env: mockEnv }));
const mockRpc = vi.hoisted(() => vi.fn());
vi.mock('../config/supabase', () => ({ supabaseAdmin: { rpc: mockRpc } }));
vi.mock('../middleware/auth', () => ({
  requireAuth: (req: { header(name: string): string | undefined; user?: { id: string } }, res: { status(code: number): { json(body: unknown): void } }, next: () => void) => {
    const user = req.header('x-test-session-user');
    if (!user) {
      res.status(401).json({ error: 'Missing bearer token' });
      return;
    }
    req.user = { id: user };
    next();
  },
}));

import { createApp } from '../app';

const FRONTEND = 'https://app.example.test';
const USER = '00000000-0000-0000-0000-0000000000aa';
const OTHER = '00000000-0000-0000-0000-0000000000bb';
const OP = '11111111-1111-4111-8111-111111111111';
const K = '22222222-2222-4222-8222-222222222222';
const W = '33333333-3333-4333-8333-333333333333';
const D = '44444444-4444-4444-8444-444444444444';
const OBLIGATION = '55555555-5555-4555-8555-555555555555';

const freshness = (over: Record<string, unknown> = {}) => ({
  fresh: true,
  inputVersion: 7,
  evaluatedVersion: 7,
  lastErrorCode: null,
  reviewRevision: 3,
  refresh: { queued: false, needsAttention: false, attempts: 0 },
  ...over,
});
const staleFreshness = freshness({ fresh: false, evaluatedVersion: 6, lastErrorCode: '55P03', refresh: { queued: true, needsAttention: true, attempts: 8 } });
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
const refreshReceipt = receipt({ action: 'refresh_retry', intent: { action: 'refresh_retry' }, outcome: 'queued', decisionId: null, subjectTransactionIds: [], retainedObligationIds: [], expectedInputVersion: null, expectedReviewRevision: null });
const actionBody = { operationId: OP, expectedInputVersion: 6, expectedReviewRevision: 3, action: { type: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: 0 } };

function rpcAnswers(data: unknown) {
  mockRpc.mockReturnValue({ abortSignal: vi.fn(async () => ({ data, error: null, status: 200 })) });
}
function rpcFails(error: Record<string, unknown>) {
  mockRpc.mockReturnValue({ abortSignal: vi.fn(async () => ({ data: null, error, status: 400 })) });
}

let server: Server;
let base: string;
let warn: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  server = createApp({ frontendUrl: FRONTEND, logRequests: false }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.cardPaymentRecoveryActionsEnabled = false;
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

function send(method: 'GET' | 'POST', path: string, options: { user?: string | null; body?: unknown; level?: string } = {}) {
  const headers: Record<string, string> = { Origin: FRONTEND, 'X-Client-Api-Level': options.level ?? '2' };
  if (options.user !== null) headers['x-test-session-user'] = options.user ?? USER;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${base}/api/card-payment-recovery${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
}

describe('every recovery route is behind the session and the client-API-level contract', () => {
  it.each([
    ['GET', '/reviews'],
    ['POST', '/actions'],
    ['GET', `/actions/${OP}`],
    ['POST', '/refresh-retries'],
  ] as const)('%s %s without a session is 401, and no database call is made', async (method, path) => {
    const res = await send(method, path, { user: null, body: method === 'POST' ? actionBody : undefined });
    expect(res.status).toBe(401);
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('carries the compatibility headers, like every app route', async () => {
    rpcAnswers({ fresh: true, freshness: freshness(), reviews: [], nextCursor: null, affectedPaymentCount: 0 });
    const res = await send('GET', '/reviews');
    expect(res.headers.get('x-api-level')).toBe('2');
    expect(res.headers.get('x-min-client-api-level')).toBe('0');
  });

  it('the claim and refresh functions of the worker have no route', async () => {
    for (const path of ['/claims', '/claim', '/refresh', '/refresh-owner', '/worker']) {
      expect((await send('POST', path, { body: {} })).status).toBe(404);
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('GET /reviews', () => {
  it('reads for the session user and returns the page in the wire shape', async () => {
    rpcAnswers({ fresh: true, freshness: freshness(), reviews: [], nextCursor: null, affectedPaymentCount: 0 });
    const res = await send('GET', '/reviews?limit=5');
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledWith('get_card_payment_recovery_reviews', { p_user_id: USER, p_cursor: null, p_limit: 5 });
    expect(await res.json()).toEqual({
      fresh: true,
      freshness: { fresh: true, input_version: 7, evaluated_version: 7, review_revision: 3, last_error_code: null, refresh: { queued: false, needs_attention: false, attempts: 0 } },
      affected_payment_count: 0,
      next_cursor: null,
      actions_enabled: false,
      reviews: [],
    });
  });

  it('an owner in the query string is not an owner', async () => {
    rpcAnswers({ fresh: true, freshness: freshness(), reviews: [], nextCursor: null, affectedPaymentCount: 0 });
    await send('GET', `/reviews?userId=${OTHER}&p_user_id=${OTHER}&user_id=${OTHER}`);
    expect(mockRpc).toHaveBeenCalledWith('get_card_payment_recovery_reviews', { p_user_id: USER, p_cursor: null, p_limit: 20 });
  });

  it('says so when the figures are not current, with no review and no figure', async () => {
    rpcAnswers({ fresh: false, freshness: staleFreshness, reviews: [], nextCursor: null, affectedPaymentCount: 2 });
    const body = (await (await send('GET', '/reviews')).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ fresh: false, affected_payment_count: 2, reviews: [], freshness: { fresh: false, last_error_code: '55P03', refresh: { queued: true, needs_attention: true, attempts: 8 } } });
  });

  it('a malformed cursor or limit is 400 and reaches no database call', async () => {
    for (const query of ['?limit=0', '?limit=500', '?cursor=x', "?cursor=2026-09-10|x'--"]) {
      const res = await send('GET', `/reviews${query}`);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    }
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('the recovery functions are missing: 503 recovery_unavailable — not an empty list', async () => {
    rpcFails({ code: 'PGRST202', message: 'Could not find the function' });
    const res = await send('GET', '/reviews');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'recovery_unavailable', reason: 'objects_missing' });
  });

  it('an answer outside the documented shape is 503, never passed on', async () => {
    rpcAnswers({ fresh: true, freshness: freshness(), reviews: [{ transactionId: K, effectCents: 0 }], nextCursor: null, affectedPaymentCount: 1 });
    const res = await send('GET', '/reviews');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: 'recovery_unavailable', reason: 'unexpected_response' });
  });
});

describe('POST /actions — switched off (the configured default)', () => {
  it('is refused with 403 recovery_actions_disabled and makes no database call', async () => {
    const res = await send('POST', '/actions', { body: actionBody });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'recovery_actions_disabled' });
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('the review, a receipt and the refresh-only retry stay available', async () => {
    rpcAnswers({ fresh: false, freshness: staleFreshness, reviews: [], nextCursor: null, affectedPaymentCount: 1 });
    const reviews = await send('GET', '/reviews');
    expect(reviews.status).toBe(200);
    expect(await reviews.json()).toMatchObject({ actions_enabled: false });

    rpcAnswers({ found: false, receipt: null, freshness: staleFreshness });
    expect((await send('GET', `/actions/${OP}`)).status).toBe(200);

    rpcAnswers({ status: 'queued', receipt: refreshReceipt, freshness: staleFreshness });
    const retry = await send('POST', '/refresh-retries', { body: { operationId: OP } });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ status: 'queued', receipt: { action: 'refresh_retry', outcome: 'queued' }, freshness: { fresh: false } });
    expect(mockRpc).toHaveBeenLastCalledWith('request_card_payment_recovery_refresh', { p_user_id: USER, p_operation_id: OP });
  });
});

describe('POST /actions — switched on', () => {
  beforeEach(() => {
    mockEnv.cardPaymentRecoveryActionsEnabled = true;
  });

  it('ONE database call for one action, for the session user', async () => {
    rpcAnswers({ status: 'committed_fresh', receipt: receipt(), freshness: freshness() });
    const res = await send('POST', '/actions', { body: actionBody });
    expect(res.status).toBe(200);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('apply_card_payment_recovery_action', {
      p_user_id: USER,
      p_operation_id: OP,
      p_expected_input_version: 6,
      p_expected_review_revision: 3,
      p_action: { action: 'pair_current', transactionId: K, counterpartTransactionId: W, acceptedDifferenceCents: 0 },
    });
    const body = (await res.json()) as { status: string; receipt: Record<string, unknown> };
    expect(body).toMatchObject({ status: 'committed_fresh', receipt: { operation_id: OP, outcome: 'saved', decision_id: D, retained_obligation_ids: [OBLIGATION], permanent_retirement: false } });
    expect(JSON.stringify(body)).not.toMatch(/effect_cents|low_cents|high_cents|"legs"/);
  });

  it('a forged owner anywhere in the body changes nothing: the session user is the owner', async () => {
    rpcAnswers({ status: 'committed_fresh', receipt: receipt(), freshness: freshness() });
    await send('POST', '/actions', { body: { ...actionBody, userId: OTHER, user_id: OTHER, p_user_id: OTHER, action: { ...actionBody.action, userId: OTHER } } });
    const [, args] = mockRpc.mock.calls[0];
    expect(args.p_user_id).toBe(USER);
    expect(JSON.stringify(args)).not.toContain(OTHER);
    // …and another session really is another owner.
    await send('POST', '/actions', { user: OTHER, body: actionBody });
    expect(mockRpc.mock.calls[1][1].p_user_id).toBe(OTHER);
  });

  it('committed_pending is a 200: the action committed; the figures are being refreshed', async () => {
    rpcAnswers({ status: 'committed_pending', receipt: receipt(), freshness: freshness({ fresh: false, evaluatedVersion: 6, refresh: { queued: true, needsAttention: false, attempts: 0 } }) });
    const res = await send('POST', '/actions', { body: actionBody });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'committed_pending', freshness: { fresh: false, refresh: { queued: true } } });
  });

  it.each([
    ['card_payment_stale_version: x: reload', 409, 'stale_version'],
    ['card_payment_recovery_stale_review: x: reload', 409, 'stale_review'],
    ['card_payment_recovery_operation_conflict: x: used', 409, 'operation_conflict'],
    ['card_payment_recovery_not_reviewable: x: not under review', 404, 'not_reviewable'],
    ['card_payment_not_found: link_card_payment: transaction not found', 404, 'not_found'],
    ['card_payment_invalid: link_card_payment: difference_not_accepted (…)', 422, 'invalid_action'],
    ['card_payment_counterpart_reserved: link_card_payment: undo that decision first', 409, 'counterpart_reserved'],
  ])('a refusal: %s', async (message, status, code) => {
    rpcFails({ code: 'P0001', message });
    const res = await send('POST', '/actions', { body: actionBody });
    expect(res.status).toBe(status);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe(code);
    // The response is a fixed sentence: nothing of the database's message.
    expect(JSON.stringify(body)).not.toMatch(/link_card_payment|undo that decision first|reload/);
  });

  it('an unknown outcome is 504 outcome_unknown and names the operation id to ask about', async () => {
    rpcFails({ code: '57014', message: 'canceling statement due to statement timeout' });
    const res = await send('POST', '/actions', { body: actionBody });
    expect(res.status).toBe(504);
    expect(await res.json()).toMatchObject({ code: 'outcome_unknown', operation_id: OP });
  });

  it.each([
    ['an unknown action', { ...actionBody, action: { type: 'retire_hold', transactionId: K } }],
    ['a "reviewed" switch', { ...actionBody, action: { type: 'mark_reviewed', transactionId: K } }],
    ['no versions', { operationId: OP, action: actionBody.action }],
    ['not an object', [actionBody]],
  ])('a malformed request (%s) is 400 and reaches no database call', async (_name, body) => {
    const res = await send('POST', '/actions', { body });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'invalid_request' });
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('GET /actions/:operationId', () => {
  it('found: the receipt and the CURRENT freshness, read separately', async () => {
    rpcAnswers({ found: true, receipt: receipt(), freshness: staleFreshness });
    const res = await send('GET', `/actions/${OP}`);
    expect(mockRpc).toHaveBeenCalledWith('get_card_payment_recovery_action', { p_user_id: USER, p_operation_id: OP });
    expect(await res.json()).toMatchObject({ found: true, receipt: { operation_id: OP, committed_input_version: 7 }, freshness: { fresh: false } });
  });

  it('absent is a 200 with found: false — an answer, not an error', async () => {
    rpcAnswers({ found: false, receipt: null, freshness: freshness() });
    const res = await send('GET', `/actions/${OP}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ found: false, receipt: null });
  });

  it('a malformed id is 400', async () => {
    expect((await send('GET', '/actions/not-a-uuid')).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});

describe('POST /refresh-retries', () => {
  it('sends the session user and the operation id — no owner and no target version from the body', async () => {
    rpcAnswers({ status: 'queued', receipt: refreshReceipt, freshness: staleFreshness });
    await send('POST', '/refresh-retries', { body: { operationId: OP, userId: OTHER, targetVersion: 999, inputVersion: 999 } });
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith('request_card_payment_recovery_refresh', { p_user_id: USER, p_operation_id: OP });
  });

  it('is accepted while the figures need attention, and returns freshness, not figures', async () => {
    rpcAnswers({ status: 'queued', receipt: refreshReceipt, freshness: staleFreshness });
    const res = await send('POST', '/refresh-retries', { body: { operationId: OP } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: 'queued', freshness: { fresh: false, refresh: { needs_attention: true } } });
    expect(JSON.stringify(body)).not.toMatch(/lease|effect_cents|low_cents/);
  });

  it('an operation id already used for a payment action is refused', async () => {
    rpcFails({ code: 'P0001', message: 'card_payment_recovery_operation_conflict: request_card_payment_recovery_refresh: this operation id was already used for another request' });
    const res = await send('POST', '/refresh-retries', { body: { operationId: OP } });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'operation_conflict' });
  });

  it('without an operation id it is 400', async () => {
    expect((await send('POST', '/refresh-retries', { body: {} })).status).toBe(400);
    expect(mockRpc).not.toHaveBeenCalled();
  });
});
