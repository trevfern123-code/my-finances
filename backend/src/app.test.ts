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
  };
});
vi.mock('./services/loans', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./services/loans')>()),
  backfillMatchesForLoan: vi.fn(async () => undefined),
}));

import { createApp } from './app';
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
