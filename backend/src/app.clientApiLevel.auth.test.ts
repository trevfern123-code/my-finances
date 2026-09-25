import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// The client API level is compatibility metadata only (middleware/clientApiLevel.ts). Unlike
// app.test.ts, this file runs the REAL requireAuth, with only Supabase's token check and the
// database layer stubbed, to prove a supported client level never stands in for authentication
// or ownership.

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

// Only "token-a" is a valid session (user-a); every other token is rejected, as Supabase would.
vi.mock('./config/supabase', () => ({
  supabaseAdmin: {
    auth: {
      getUser: vi.fn(async (token: string) =>
        token === 'token-a'
          ? { data: { user: { id: 'user-a', email: 'a@example.test' } }, error: null }
          : { data: { user: null }, error: { message: 'invalid JWT' } }
      ),
    },
  },
}));

// loan-a belongs to user-a, loan-b to user-b. updateManualLoan is scoped by user, like the real
// query (`.eq('id', id).eq('user_id', userId)`), so another user's loan is simply not found.
const updates = vi.hoisted(() => ({ calls: [] as { id: string; userId: string }[] }));
vi.mock('./services/dataService', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/dataService')>();
  const owners: Record<string, string> = { 'loan-a': 'user-a', 'loan-b': 'user-b' };
  return {
    ...actual,
    updateManualLoan: vi.fn(async (id: string, userId: string, fields: { name?: string }) => {
      updates.calls.push({ id, userId });
      if (owners[id] !== userId) return null;
      return {
        id,
        user_id: userId,
        name: fields.name ?? 'Loan',
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
      };
    }),
    getLifetimeTotalsByLoanId: vi.fn(async () => new Map()),
  };
});

import { createApp } from './app';
import { supabaseAdmin } from './config/supabase';

const getUser = supabaseAdmin.auth.getUser as unknown as ReturnType<typeof vi.fn>;

const FRONTEND = 'https://app.example.test';
let server: Server;
let base: string;
let strictServer: Server;
let strictBase: string;

async function listen(policy?: { apiLevel: number; minClientApiLevel: number }): Promise<[Server, string]> {
  const s = createApp({ frontendUrl: FRONTEND, logRequests: false, clientApiLevelPolicy: policy }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => s.once('listening', () => resolve()));
  return [s, `http://127.0.0.1:${(s.address() as AddressInfo).port}`];
}

beforeAll(async () => {
  [server, base] = await listen();
  [strictServer, strictBase] = await listen({ apiLevel: 3, minClientApiLevel: 2 });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => strictServer.close(() => resolve()));
});

function patchLoan(root: string, loanId: string, headers: Record<string, string>) {
  return fetch(`${root}/api/manual-loans/${loanId}`, {
    method: 'PATCH',
    headers: { Origin: FRONTEND, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ name: 'Renamed' }),
  });
}

describe('a supported client level never replaces authentication or ownership', () => {
  it('a level-1 request with no bearer token is still refused by requireAuth (401), with the compatibility headers', async () => {
    const res = await patchLoan(base, 'loan-a', { 'X-Client-Api-Level': '1' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Missing bearer token' });
    expect(res.headers.get('x-api-level')).toBe('1');
    expect(res.headers.get('x-min-client-api-level')).toBe('0');
  });

  it('a level-1 request with an invalid session is refused (401)', async () => {
    const res = await patchLoan(base, 'loan-a', { 'X-Client-Api-Level': '1', Authorization: 'Bearer forged' });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid or expired session' });
  });

  it("a level-1 request cannot change another user's loan: the ownership-scoped update finds nothing (404)", async () => {
    updates.calls.length = 0;
    const res = await patchLoan(base, 'loan-b', { 'X-Client-Api-Level': '1', Authorization: 'Bearer token-a' });

    expect(res.status).toBe(404);
    expect(updates.calls).toEqual([{ id: 'loan-b', userId: 'user-a' }]);
  });

  it("a level-1 request can change the caller's own loan", async () => {
    const res = await patchLoan(base, 'loan-a', { 'X-Client-Api-Level': '1', Authorization: 'Bearer token-a' });

    expect(res.status).toBe(200);
    expect(((await res.json()) as { loan: unknown }).loan).toMatchObject({ id: 'loan-a', name: 'Renamed' });
  });

  it('an unsupported client is refused (409) before authentication even runs, so no session check or write happens for it', async () => {
    updates.calls.length = 0;
    const res = await patchLoan(strictBase, 'loan-a', { 'X-Client-Api-Level': '1', Authorization: 'Bearer token-a' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: unknown }).code).toBe('client_update_required');
    expect(updates.calls).toHaveLength(0);
  });

  it('a supported client under the stricter policy still goes through authentication (401 without a token)', async () => {
    const res = await patchLoan(strictBase, 'loan-a', { 'X-Client-Api-Level': '2' });
    expect(res.status).toBe(401);
  });
});

function patchRaw(root: string, loanId: string, rawBody: string, headers: Record<string, string>) {
  return fetch(`${root}/api/manual-loans/${loanId}`, {
    method: 'PATCH',
    headers: { Origin: FRONTEND, 'Content-Type': 'application/json', Authorization: 'Bearer token-a', ...headers },
    body: rawBody,
  });
}

describe('a compatibility-rejected request never reaches Supabase authentication', () => {
  it('below-minimum client (strict policy), even with a valid session and a malformed body: 409, getUser never called', async () => {
    getUser.mockClear();
    updates.calls.length = 0;
    const res = await patchRaw(strictBase, 'loan-a', '{"name":', { 'X-Client-Api-Level': '1' });

    expect(res.status).toBe(409);
    expect(getUser).not.toHaveBeenCalled();
    expect(updates.calls).toHaveLength(0);
  });

  it('invalid client-level header: 400, getUser never called', async () => {
    getUser.mockClear();
    const res = await patchRaw(base, 'loan-a', JSON.stringify({ name: 'X' }), { 'X-Client-Api-Level': 'abc' });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: unknown }).code).toBe('invalid_client_api_level');
    expect(getUser).not.toHaveBeenCalled();
  });

  it('a supported client with a malformed body is refused by the parser (400) before authentication runs', async () => {
    getUser.mockClear();
    const res = await patchRaw(base, 'loan-a', '{"name":', { 'X-Client-Api-Level': '1' });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: unknown }).code).toBe('malformed_json');
    expect(getUser).not.toHaveBeenCalled();
  });

  it('control: a supported client with a valid body does reach authentication', async () => {
    getUser.mockClear();
    const res = await patchRaw(base, 'loan-a', JSON.stringify({ name: 'X' }), { 'X-Client-Api-Level': '1' });

    expect(res.status).toBe(200);
    expect(getUser).toHaveBeenCalledTimes(1);
  });
});
