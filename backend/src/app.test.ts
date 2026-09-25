import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Round 16 remediation: these drive the REAL app (createApp — helmet, CORS, JSON parsing, routing,
// the real manual-loan controllers, the real error handler) over real HTTP on an ephemeral port.
// Only configuration, authentication and the database layer are replaced: env/supabase would
// otherwise need live credentials at import time, and the database layer is covered against real
// PostgreSQL by supabase/tests/phase_a.

vi.mock('./config/env', () => ({
  env: {
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
  },
}));
vi.mock('./config/supabase', () => ({ supabaseAdmin: {} }));
vi.mock('./middleware/auth', () => ({
  requireAuth: (req: { header(name: string): string | undefined; user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: req.header('x-test-user') ?? 'user-a' };
    next();
  },
}));

// A stand-in for create_manual_loan_idempotent's contract: one loan per (user, key); a repeated key
// replays that loan. Records every key it receives, so the tests can see exactly what reached it.
const store = vi.hoisted(() => ({ loans: new Map<string, { id: string; name: string }>(), keysSeen: [] as string[] }));
vi.mock('./services/dataService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/dataService')>();
  const toRow = (loan: { id: string; name: string }) => ({
    id: loan.id,
    user_id: 'user-a',
    name: loan.name,
    loan_type: 'personal',
    current_balance: 100,
    origination_principal_amount: null,
    interest_rate_percentage: null,
    origination_date: null,
    term_months: null,
    minimum_payment_amount: null,
    next_payment_due_date: null,
    notes: null,
    match_text: null,
  });
  return {
    ...actual,
    createManualLoan: vi.fn(async (userId: string, params: { name: string }, key: string) => {
      if (params.name === 'Explode') throw new Error('database unavailable');
      store.keysSeen.push(key);
      const slot = `${userId}|${key}`;
      let loan = store.loans.get(slot);
      if (!loan) {
        loan = { id: `loan-${store.loans.size + 1}`, name: params.name };
        store.loans.set(slot, loan);
      }
      return toRow(loan);
    }),
    getManualLoan: vi.fn(async (id: string) => {
      const loan = [...store.loans.values()].find((l) => l.id === id);
      return loan ? toRow(loan) : null;
    }),
    getLifetimeTotalsByLoanId: vi.fn(async () => new Map()),
    listManualLoans: vi.fn(async () => [...store.loans.values()].map(toRow)),
  };
});
vi.mock('./services/loans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./services/loans')>()),
  backfillMatchesForLoan: vi.fn(async () => undefined),
}));

import { CLIENT_API_ROUTES, createApp } from './app';
import { LEGACY_SERVER_KEY_PREFIX } from './controllers/manualLoanController';

const FRONTEND = 'https://app.example.test';
let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp({ frontendUrl: FRONTEND, logRequests: false }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  store.loans.clear();
  store.keysSeen.length = 0;
});

interface CreateLoanResponse {
  loan: { id: string; name: string };
  error: string;
}

async function readJson(res: Response): Promise<CreateLoanResponse> {
  return (await res.json()) as CreateLoanResponse;
}

function allowedHeaders(res: Response): string[] {
  return (res.headers.get('access-control-allow-headers') ?? '').split(',').map((h) => h.trim().toLowerCase());
}

function preflight(path: string, origin: string) {
  return fetch(`${base}${path}`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type, idempotency-key',
    },
  });
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { Origin: FRONTEND, 'Content-Type': 'application/json', Authorization: 'Bearer test', ...headers },
    body: JSON.stringify(body),
  });
}

describe('CORS preflight — the real Express/CORS configuration (Round 16 blocker)', () => {
  it.each(['/api/manual-loans/idempotent', '/api/manual-loans'])(
    'permits the frontend origin, POST, and all three request headers on %s',
    async (path) => {
      const res = await preflight(path, FRONTEND);

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND);
      expect((res.headers.get('access-control-allow-methods') ?? '').split(',')).toContain('POST');
      expect(allowedHeaders(res)).toEqual(expect.arrayContaining(['authorization', 'content-type', 'idempotency-key']));
    }
  );

  it('does not grant an unapproved origin: the response never names it, so a browser refuses the request', async () => {
    const res = await preflight('/api/manual-loans/idempotent', 'https://evil.example.test');

    const allowOrigin = res.headers.get('access-control-allow-origin');
    expect(allowOrigin).not.toBe('https://evil.example.test');
    expect(allowOrigin).not.toBe('*');
    // The configured policy is a single fixed origin; the cors package reports that origin (and
    // only that origin) regardless of who asks.
    expect(allowOrigin).toBe(FRONTEND);
  });

  it('actual responses carry the allow-origin header for the frontend (not just the preflight)', async () => {
    const res = await post('/api/manual-loans/idempotent', { name: 'Car', current_balance: 100 }, { 'Idempotency-Key': 'k-cors' });
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND);
  });
});

describe('Manual-loan create compatibility across old and new clients (Round 16 high)', () => {
  it('an OLD frontend request (no key, legacy route) still works against the new backend', async () => {
    const res = await post('/api/manual-loans', { name: 'Old Client Loan', current_balance: 100 });

    expect(res.status).toBe(201);
    expect((await readJson(res)).loan).toMatchObject({ name: 'Old Client Loan' });
    expect(store.keysSeen).toHaveLength(1);
    expect(store.keysSeen[0].startsWith(LEGACY_SERVER_KEY_PREFIX)).toBe(true);
  });

  it('the legacy route is explicitly NOT retry-idempotent: every request gets a fresh server key (the old behaviour)', async () => {
    const a = await readJson(await post('/api/manual-loans', { name: 'Dup', current_balance: 100 }));
    const b = await readJson(await post('/api/manual-loans', { name: 'Dup', current_balance: 100 }));

    expect(new Set(store.keysSeen).size).toBe(2);
    expect(a.loan.id).not.toBe(b.loan.id);
  });

  it('the legacy route ignores any client Idempotency-Key — a legacy request never enters the new pending-key protocol', async () => {
    await post('/api/manual-loans', { name: 'Keyed Legacy', current_balance: 100 }, { 'Idempotency-Key': 'client-key-1' });
    await post('/api/manual-loans/idempotent', { name: 'Keyed Legacy', current_balance: 100 }, { 'Idempotency-Key': 'client-key-1' });

    // Two different keys reached the database: the legacy request did not claim, or replay, the
    // client's key — so the idempotent request created its own loan rather than replaying one.
    expect(store.keysSeen[0].startsWith(LEGACY_SERVER_KEY_PREFIX)).toBe(true);
    expect(store.keysSeen[1]).toBe('client-key-1');
    expect(store.loans.size).toBe(2);
  });

  it('a NEW frontend request with a key works on the idempotent route, and the key reaches the database unchanged', async () => {
    const res = await post('/api/manual-loans/idempotent', { name: 'New Client Loan', current_balance: 100 }, { 'Idempotency-Key': 'uuid-1' });

    expect(res.status).toBe(201);
    expect(store.keysSeen).toEqual(['uuid-1']);
  });

  it.each([
    ['missing', {}],
    ['blank', { 'Idempotency-Key': '   ' }],
  ])('the idempotent route REJECTS a %s key (400) and never downgrades to a non-idempotent create', async (_label, headers) => {
    const res = await post('/api/manual-loans/idempotent', { name: 'No Key', current_balance: 100 }, headers as Record<string, string>);

    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('Idempotency-Key header is required');
    expect(store.keysSeen).toHaveLength(0);
  });

  it('the idempotent route rejects a key in the legacy server namespace, so the two key spaces can never meet', async () => {
    const res = await post('/api/manual-loans/idempotent', { name: 'Spoof', current_balance: 100 }, {
      'Idempotency-Key': `${LEGACY_SERVER_KEY_PREFIX}anything`,
    });

    expect(res.status).toBe(400);
    expect(store.keysSeen).toHaveLength(0);
  });

  it('retries with the same key on the idempotent route replay the SAME loan', async () => {
    const first = await readJson(await post('/api/manual-loans/idempotent', { name: 'Retry Loan', current_balance: 100 }, { 'Idempotency-Key': 'uuid-retry' }));
    const second = await readJson(await post('/api/manual-loans/idempotent', { name: 'Retry Loan', current_balance: 100 }, { 'Idempotency-Key': 'uuid-retry' }));

    expect(second.loan.id).toBe(first.loan.id);
    expect(store.loans.size).toBe(1);
  });

  it('one backend serves old and new clients at the same time — the rollout does not need every client to update at once', async () => {
    const responses = await Promise.all([
      post('/api/manual-loans', { name: 'Cached Old Bundle', current_balance: 100 }),
      post('/api/manual-loans/idempotent', { name: 'New Bundle', current_balance: 100 }, { 'Idempotency-Key': 'uuid-new' }),
      post('/api/manual-loans', { name: 'Another Old Tab', current_balance: 100 }),
    ]);

    expect(responses.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(store.keysSeen.filter((k) => k.startsWith(LEGACY_SERVER_KEY_PREFIX))).toHaveLength(2);
    expect(store.keysSeen).toContain('uuid-new');
  });
});

// ---- Client API level contract (service-worker / version compatibility, phase 1) ----------------

function expectCompatHeaders(res: Response, apiLevel: string, minLevel: string) {
  expect(res.headers.get('x-api-level')).toBe(apiLevel);
  expect(res.headers.get('x-min-client-api-level')).toBe(minLevel);
}

function get(root: string, path: string, headers: Record<string, string> = {}) {
  return fetch(`${root}${path}`, { headers: { Origin: FRONTEND, Authorization: 'Bearer test', ...headers } });
}

function postTo(root: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${root}${path}`, {
    method: 'POST',
    headers: { Origin: FRONTEND, 'Content-Type': 'application/json', Authorization: 'Bearer test', ...headers },
    body: JSON.stringify(body),
  });
}

describe('Client API level contract — production policy (level 1, minimum 0)', () => {
  it('a legacy request with no X-Client-Api-Level is still served, and carries the compatibility headers', async () => {
    const res = await post('/api/manual-loans/idempotent', { name: 'Legacy', current_balance: 100 }, { 'Idempotency-Key': 'k-legacy' });

    expect(res.status).toBe(201);
    expectCompatHeaders(res, '1', '0');
    expect((await readJson(res)).loan).toMatchObject({ name: 'Legacy' });
  });

  it('a level-1 request is served with exactly the same response shape as a legacy one', async () => {
    const legacy = await readJson(await post('/api/manual-loans/idempotent', { name: 'Shape A', current_balance: 100 }, { 'Idempotency-Key': 'k-a' }));
    const levelled = await post('/api/manual-loans/idempotent', { name: 'Shape B', current_balance: 100 }, {
      'Idempotency-Key': 'k-b',
      'X-Client-Api-Level': '1',
    });

    expect(levelled.status).toBe(201);
    expectCompatHeaders(levelled, '1', '0');
    const body = await readJson(levelled);
    expect(Object.keys(body).sort()).toEqual(Object.keys(legacy).sort());
    expect(Object.keys(body.loan).sort()).toEqual(Object.keys(legacy.loan).sort());
  });

  it('a read keeps its response shape with or without the header', async () => {
    await post('/api/manual-loans/idempotent', { name: 'Listed', current_balance: 100 }, { 'Idempotency-Key': 'k-list' });

    const without = await get(base, '/api/manual-loans');
    const withLevel = await get(base, '/api/manual-loans', { 'X-Client-Api-Level': '1' });

    expect([without.status, withLevel.status]).toEqual([200, 200]);
    expectCompatHeaders(without, '1', '0');
    expectCompatHeaders(withLevel, '1', '0');
    expect(await withLevel.json()).toEqual(await without.json());
  });

  it.each(['', 'abc', '01', '-1', '1.5', '1, 1'])(
    'a malformed level (%j) is refused with 400 invalid_client_api_level before any write',
    async (raw) => {
      const res = await post('/api/manual-loans/idempotent', { name: 'Malformed', current_balance: 100 }, {
        'Idempotency-Key': 'k-malformed',
        'X-Client-Api-Level': raw,
      });

      expect(res.status).toBe(400);
      expectCompatHeaders(res, '1', '0');
      expect(await res.json()).toEqual({ error: 'Invalid X-Client-Api-Level header', code: 'invalid_client_api_level' });
      expect(store.keysSeen).toHaveLength(0);
    }
  );

  it('error responses from later in the pipeline (the global 500 handler) still carry the headers', async () => {
    const res = await post('/api/manual-loans/idempotent', { name: 'Explode', current_balance: 100 }, {
      'Idempotency-Key': 'k-explode',
      'X-Client-Api-Level': '1',
    });

    expect(res.status).toBe(500);
    expectCompatHeaders(res, '1', '0');
  });

  it('an unknown path under a covered prefix still carries the headers', async () => {
    const res = await get(base, '/api/manual-loans/nope/also-nope', { 'X-Client-Api-Level': '1' });
    expect(res.status).toBe(404);
    expectCompatHeaders(res, '1', '0');
  });

  it('CORS preflight allows X-Client-Api-Level with the existing headers, and needs no client header itself', async () => {
    const res = await fetch(`${base}/api/manual-loans/idempotent`, {
      method: 'OPTIONS',
      headers: {
        Origin: FRONTEND,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, idempotency-key, x-client-api-level',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND);
    expect(allowedHeaders(res)).toEqual(
      expect.arrayContaining(['authorization', 'content-type', 'idempotency-key', 'x-client-api-level'])
    );
  });

  it('CORS exposes both compatibility headers on actual responses, so a browser script can read them', async () => {
    const res = await get(base, '/api/manual-loans', { 'X-Client-Api-Level': '1' });
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').split(',').map((h) => h.trim().toLowerCase());

    expect(exposed).toEqual(expect.arrayContaining(['x-api-level', 'x-min-client-api-level']));
    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND);
  });

  it.each(['/health', '/'])('%s is not covered: unaffected, even by a malformed client header', async (path) => {
    const res = await fetch(`${base}${path}`, { headers: { 'X-Client-Api-Level': 'garbage' } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('x-api-level')).toBeNull();
  });

  it('Plaid webhooks are not covered: a malformed client header changes nothing, and signature checking still applies', async () => {
    const res = await fetch(`${base}/api/webhooks/plaid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Api-Level': 'garbage' },
      body: JSON.stringify({ webhook_type: 'TRANSACTIONS' }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Missing signature or body' });
    expect(res.headers.get('x-api-level')).toBeNull();
  });
});

describe('Client API level contract — a stricter minimum (isolated test policy: level 3, minimum 2)', () => {
  let strictServer: Server;
  let strictBase: string;

  beforeAll(async () => {
    strictServer = createApp({
      frontendUrl: FRONTEND,
      logRequests: false,
      clientApiLevelPolicy: { apiLevel: 3, minClientApiLevel: 2 },
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => strictServer.once('listening', () => resolve()));
    strictBase = `http://127.0.0.1:${(strictServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => strictServer.close(() => resolve()));
  });

  it.each([
    ['a legacy client (no header)', {}],
    ['a level-1 client', { 'X-Client-Api-Level': '1' }],
  ])('%s is refused with 409 client_update_required before the mutation runs', async (_label, levelHeader) => {
    const res = await postTo(strictBase, '/api/manual-loans/idempotent', { name: 'Too Old', current_balance: 100 }, {
      'Idempotency-Key': 'k-old',
      ...(levelHeader as Record<string, string>),
    });

    expect(res.status).toBe(409);
    expectCompatHeaders(res, '3', '2');
    expect(await res.json()).toEqual({
      error: 'This version of the app is out of date. Reload the page to update.',
      code: 'client_update_required',
    });
    expect(store.keysSeen).toHaveLength(0);
    expect(store.loans.size).toBe(0);
  });

  it('reads are refused too: a GET response is not assumed compatible just because the request is read-only', async () => {
    const res = await get(strictBase, '/api/manual-loans', { 'X-Client-Api-Level': '1' });

    expect(res.status).toBe(409);
    expectCompatHeaders(res, '3', '2');
  });

  it('a Plaid route is refused before its handler runs (the handler would otherwise fail against the stub database)', async () => {
    const res = await postTo(strictBase, '/api/plaid/link-token', {}, { 'X-Client-Api-Level': '1' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: unknown }).code).toBe('client_update_required');
  });

  it('the refusal is readable cross-origin: CORS headers and exposed compatibility headers are on the 409', async () => {
    const res = await get(strictBase, '/api/manual-loans', { 'X-Client-Api-Level': '1' });
    const exposed = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase();

    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND);
    expect(exposed).toContain('x-min-client-api-level');
  });

  it.each(['2', '3', '4'])('a client at or above the minimum (level %s) is served', async (level) => {
    const res = await postTo(strictBase, '/api/manual-loans/idempotent', { name: `Level ${level}`, current_balance: 100 }, {
      'Idempotency-Key': `k-level-${level}`,
      'X-Client-Api-Level': level,
    });

    expect(res.status).toBe(201);
    expectCompatHeaders(res, '3', '2');
  });

  it('OPTIONS preflight is still answered without any client header', async () => {
    const res = await fetch(`${strictBase}/api/manual-loans/idempotent`, {
      method: 'OPTIONS',
      headers: { Origin: FRONTEND, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' },
    });

    expect(res.status).toBe(204);
  });

  it('health and Plaid webhooks are unaffected by the stricter minimum', async () => {
    const health = await fetch(`${strictBase}/health`);
    const webhook = await fetch(`${strictBase}/api/webhooks/plaid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(health.status).toBe(200);
    expect(webhook.status).toBe(400);
    expect(await webhook.json()).toEqual({ error: 'Missing signature or body' });
  });
});

// ---- Ordering: the compatibility check runs BEFORE the JSON body is parsed (Codex review) ---------

const MALFORMED_JSON = '{"name": "Broken", "current_balance": 100,';
// express.json()'s default limit is 100kb.
const OVERSIZED_JSON = JSON.stringify({ name: 'Huge', current_balance: 100, notes: 'x'.repeat(150 * 1024) });

function postRaw(root: string, path: string, rawBody: string, headers: Record<string, string> = {}) {
  return fetch(`${root}${path}`, {
    method: 'POST',
    headers: { Origin: FRONTEND, 'Content-Type': 'application/json', Authorization: 'Bearer test', ...headers },
    body: rawBody,
  });
}

describe('Client API level runs before body parsing, and body-parser failures are client errors', () => {
  let strictServer: Server;
  let strictBase: string;

  beforeAll(async () => {
    strictServer = createApp({
      frontendUrl: FRONTEND,
      logRequests: false,
      clientApiLevelPolicy: { apiLevel: 3, minClientApiLevel: 2 },
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => strictServer.once('listening', () => resolve()));
    strictBase = `http://127.0.0.1:${(strictServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => strictServer.close(() => resolve()));
  });

  it('a below-minimum client with a malformed body gets 409 client_update_required: the body is never parsed', async () => {
    const res = await postRaw(strictBase, '/api/manual-loans/idempotent', MALFORMED_JSON, {
      'Idempotency-Key': 'k-order-1',
      'X-Client-Api-Level': '1',
    });

    expect(res.status).toBe(409);
    expectCompatHeaders(res, '3', '2');
    expect(((await res.json()) as { code: unknown }).code).toBe('client_update_required');
    expect(store.keysSeen).toHaveLength(0);
  });

  it('a below-minimum client with an oversized body also gets 409, not a parser error', async () => {
    const res = await postRaw(strictBase, '/api/manual-loans/idempotent', OVERSIZED_JSON, {
      'Idempotency-Key': 'k-order-2',
      'X-Client-Api-Level': '1',
    });

    expect(res.status).toBe(409);
    expectCompatHeaders(res, '3', '2');
  });

  it('an invalid client-level header with a malformed body gets 400 invalid_client_api_level: level validation wins', async () => {
    const res = await postRaw(base, '/api/manual-loans/idempotent', MALFORMED_JSON, {
      'Idempotency-Key': 'k-order-3',
      'X-Client-Api-Level': 'abc',
    });

    expect(res.status).toBe(400);
    expectCompatHeaders(res, '1', '0');
    expect(((await res.json()) as { code: unknown }).code).toBe('invalid_client_api_level');
  });

  it.each([
    ['a level-1 client', { 'X-Client-Api-Level': '1' }],
    ['a legacy client (no header)', {}],
  ])('%s with a malformed body reaches parsing and gets 400 malformed_json with the compatibility headers', async (_label, levelHeader) => {
    const res = await postRaw(base, '/api/manual-loans/idempotent', MALFORMED_JSON, {
      'Idempotency-Key': 'k-order-4',
      ...(levelHeader as Record<string, string>),
    });

    expect(res.status).toBe(400);
    expectCompatHeaders(res, '1', '0');
    const body = (await res.json()) as { error: string; code: string };
    expect(body).toEqual({ error: 'The request body is not valid JSON', code: 'malformed_json' });
    expect(store.keysSeen).toHaveLength(0);
  });

  it('a supported client with an oversized body gets 413 payload_too_large with the compatibility headers', async () => {
    const res = await postRaw(base, '/api/manual-loans/idempotent', OVERSIZED_JSON, {
      'Idempotency-Key': 'k-order-5',
      'X-Client-Api-Level': '1',
    });

    expect(res.status).toBe(413);
    expectCompatHeaders(res, '1', '0');
    expect(await res.json()).toEqual({ error: 'The request body is too large', code: 'payload_too_large' });
    expect(store.keysSeen).toHaveLength(0);
  });

  it('a parser failure never exposes parser internals or a stack trace', async () => {
    const res = await postRaw(base, '/api/manual-loans/idempotent', MALFORMED_JSON, { 'X-Client-Api-Level': '1' });
    const text = await res.text();

    expect(text).not.toMatch(/Unexpected|position|SyntaxError|at .*\.js/);
  });

  it('the malformed-body response is still readable cross-origin (CORS headers and exposed headers present)', async () => {
    const res = await postRaw(base, '/api/manual-loans/idempotent', MALFORMED_JSON, { 'X-Client-Api-Level': '1' });

    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND);
    expect((res.headers.get('access-control-expose-headers') ?? '').toLowerCase()).toContain('x-api-level');
  });

  it('webhooks (not covered) also get a clean 400 for a malformed body, and no compatibility headers', async () => {
    const res = await postRaw(base, '/api/webhooks/plaid', MALFORMED_JSON);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: unknown }).code).toBe('malformed_json');
    expect(res.headers.get('x-api-level')).toBeNull();
  });

  it('unrelated application errors keep their existing 500 behaviour', async () => {
    const res = await post('/api/manual-loans/idempotent', { name: 'Explode', current_balance: 100 }, {
      'Idempotency-Key': 'k-order-6',
      'X-Client-Api-Level': '1',
    });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'database unavailable' });
  });
});

describe('Every covered prefix is gated (a future omission from CLIENT_API_ROUTES is caught)', () => {
  const PROTECTED_PREFIXES = [
    '/api/plaid',
    '/api/budget-categories',
    '/api/category-mappings',
    '/api/manual-loans',
    '/api/user-preferences',
  ];
  let strictServer: Server;
  let strictBase: string;

  beforeAll(async () => {
    strictServer = createApp({
      frontendUrl: FRONTEND,
      logRequests: false,
      clientApiLevelPolicy: { apiLevel: 3, minClientApiLevel: 2 },
    }).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => strictServer.once('listening', () => resolve()));
    strictBase = `http://127.0.0.1:${(strictServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => strictServer.close(() => resolve()));
  });

  it('CLIENT_API_ROUTES is exactly the five protected prefixes (adding or dropping one must be a deliberate change here)', () => {
    expect([...CLIENT_API_ROUTES].sort()).toEqual([...PROTECTED_PREFIXES].sort());
  });

  it.each(PROTECTED_PREFIXES.flatMap((prefix) => [
    [prefix, 'GET'],
    [prefix, 'POST'],
  ]))('%s (%s) refuses a below-minimum client with 409 and the compatibility headers', async (prefix, method) => {
    const res = await fetch(`${strictBase}${prefix}/anything`, {
      method,
      headers: { Origin: FRONTEND, 'Content-Type': 'application/json', Authorization: 'Bearer test', 'X-Client-Api-Level': '1' },
      body: method === 'POST' ? '{}' : undefined,
    });

    expect(res.status).toBe(409);
    expectCompatHeaders(res, '3', '2');
  });

  it.each(['/', '/health'])('the excluded path %s is never gated, even for a below-minimum client', async (path) => {
    const res = await fetch(`${strictBase}${path}`, { headers: { 'X-Client-Api-Level': '1' } });
    expect(res.status).toBe(200);
  });
});
