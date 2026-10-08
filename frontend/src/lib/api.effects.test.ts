import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('./supabaseClient', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

import { EFFECTS_RESTART_REQUIRED, getBudgetCategories, getMonthlyBreakdown, getSpendingSummary, getTransactionEffects } from './api';
import { appUpdate, CLIENT_API_LEVEL } from './appUpdate';
import { effectRowWire, effectsPageWire } from '../testUtils/semanticFixtures';

// Financial Semantics Phase B, integration slice I2 — the level-2 requests this client sends, and
// how the drill-down endpoint's answers reach the caller.

const SESSION = { user: { id: 'user-a' }, access_token: 'a-token' };

function response(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return { ok: init.ok ?? true, status: init.status ?? 200, headers: new Headers(), json: () => Promise.resolve(body) };
}

function lastRequest(): { url: URL; init: RequestInit } {
  const call = vi.mocked(fetch).mock.calls.at(-1);
  if (!call) throw new Error('no request was sent');
  // VITE_API_BASE_URL is not set under test, so the URL starts with the literal "undefined".
  return { url: new URL(String(call[0]).replace(/^undefined/, ''), 'http://api.test'), init: call[1] as RequestInit };
}

const PERIOD = { start: '2026-09-01', end: '2026-10-01' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  mockGetSession.mockResolvedValue({ data: { session: SESSION } });
  appUpdate.reportServerLevels(CLIENT_API_LEVEL, 0);
});

describe('every level-2 read declares API level 2', () => {
  it('summary, monthly breakdown, budget categories and effects all send X-Client-Api-Level: 2', async () => {
    vi.mocked(fetch).mockResolvedValue(response(effectsPageWire([], { total_amount: 0, total_count: 0 })) as never);
    await getSpendingSummary();
    await getMonthlyBreakdown();
    await getBudgetCategories();
    await getTransactionEffects({ ...PERIOD, measure: 'spending' }, { cursor: null, limit: 50 });
    expect(vi.mocked(fetch).mock.calls).toHaveLength(4);
    for (const call of vi.mocked(fetch).mock.calls) {
      expect(((call[1] as RequestInit).headers as Record<string, string>)['X-Client-Api-Level']).toBe('2');
    }
  });
});

describe('getTransactionEffects — the request', () => {
  beforeEach(() => {
    vi.mocked(fetch).mockResolvedValue(response(effectsPageWire([], { total_amount: 0, total_count: 0 })) as never);
  });

  it('asks the effects endpoint for the period and the measure, as a GET', async () => {
    await getTransactionEffects({ ...PERIOD, measure: 'debt_payments' }, { cursor: null, limit: 50 });
    const { url, init } = lastRequest();
    expect(url.pathname).toBe('/api/plaid/transactions/effects');
    expect(init.method).toBeUndefined();
    expect(Object.fromEntries(url.searchParams)).toEqual({ start: '2026-09-01', end: '2026-10-01', measure: 'debt_payments', limit: '50' });
  });

  it('sends a budget category bucket, and "unassigned" for spending with no category', async () => {
    await getTransactionEffects({ ...PERIOD, measure: 'spending', bucket: { kind: 'budget_category', id: 'cat-1' } }, { cursor: null, limit: 50 });
    expect(lastRequest().url.searchParams.get('budget_category_id')).toBe('cat-1');
    expect(lastRequest().url.searchParams.has('plaid_category')).toBe(false);

    await getTransactionEffects({ ...PERIOD, measure: 'spending', bucket: { kind: 'budget_category', id: null } }, { cursor: null, limit: 50 });
    expect(lastRequest().url.searchParams.get('budget_category_id')).toBe('unassigned');
  });

  it('sends a Plaid category bucket, encoded', async () => {
    await getTransactionEffects({ ...PERIOD, measure: 'spending', bucket: { kind: 'plaid_category', category: 'FOOD & DRINK' } }, { cursor: null, limit: 50 });
    const { url } = lastRequest();
    expect(url.searchParams.get('plaid_category')).toBe('FOOD & DRINK');
    expect(url.searchParams.has('budget_category_id')).toBe(false);
    expect(url.search).toContain('plaid_category=FOOD+%26+DRINK');
  });

  it('sends spending with no bucket as the whole period', async () => {
    await getTransactionEffects({ ...PERIOD, measure: 'spending' }, { cursor: null, limit: 50 });
    const params = lastRequest().url.searchParams;
    expect(params.get('measure')).toBe('spending');
    expect(params.has('budget_category_id')).toBe(false);
    expect(params.has('plaid_category')).toBe(false);
  });

  it('sends the server cursor only on a continuation, and never invents one', async () => {
    await getTransactionEffects({ ...PERIOD, measure: 'income' }, { cursor: null, limit: 50 });
    expect(lastRequest().url.searchParams.has('cursor')).toBe(false);
    await getTransactionEffects({ ...PERIOD, measure: 'income' }, { cursor: 'Mnxh-YmM_x', limit: 50 });
    expect(lastRequest().url.searchParams.get('cursor')).toBe('Mnxh-YmM_x');
  });

  it('passes the abort signal to the request', async () => {
    const controller = new AbortController();
    await getTransactionEffects({ ...PERIOD, measure: 'income' }, { cursor: null, limit: 50 }, controller.signal);
    expect(lastRequest().init.signal).toBe(controller.signal);
  });
});

describe('getTransactionEffects — the answer', () => {
  it('returns the rows, the complete total and the next cursor of an ok page', async () => {
    vi.mocked(fetch).mockResolvedValue(
      response(effectsPageWire([effectRowWire({ effect_amount: 75 }), effectRowWire({ effect_amount: -60 })], { total_amount: 2980.5, total_count: 120 }, 'next')) as never
    );
    const page = await getTransactionEffects({ ...PERIOD, measure: 'spending' }, { cursor: null, limit: 50 });
    expect(page).toMatchObject({ kind: 'ok', total_amount: 2980.5, total_count: 120, next_cursor: 'next' });
    expect(page.kind === 'ok' && page.rows.map((r) => r.effect_amount)).toEqual([75, -60]);
  });

  it('returns updating / unavailable as states with no rows', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ status: 'updating', retry_after_ms: 5000, reason: 'matching_pending' }) as never);
    expect(await getTransactionEffects({ ...PERIOD, measure: 'transfers_external' }, { cursor: null, limit: 50 })).toEqual({
      kind: 'updating',
      reason: 'matching_pending',
      retryAfterMs: 5000,
    });
  });

  it('a 200 body of another shape is "invalid", never rows', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ transactions: [{ id: 't', amount: 12 }] }) as never);
    expect(await getTransactionEffects({ ...PERIOD, measure: 'spending' }, { cursor: null, limit: 50 })).toEqual({ kind: 'invalid' });
  });

  it('409 effects_restart_required is thrown with its code, reason and status, and no rows', async () => {
    vi.mocked(fetch).mockResolvedValue(
      response({ error: 'The transactions behind this list changed.', code: 'effects_restart_required', reason: 'snapshot_changed' }, { ok: false, status: 409 }) as never
    );
    await expect(getTransactionEffects({ ...PERIOD, measure: 'spending' }, { cursor: 'c1', limit: 50 })).rejects.toMatchObject({
      code: EFFECTS_RESTART_REQUIRED,
      reason: 'snapshot_changed',
      status: 409,
    });
  });

  it('a backend without the effects endpoint (older than I1) answers 404: thrown with the status, so the list can say it is not available yet', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ error: 'Not found' }, { ok: false, status: 404 }) as never);
    await expect(getTransactionEffects({ ...PERIOD, measure: 'spending' }, { cursor: null, limit: 50 })).rejects.toMatchObject({ status: 404 });
  });

  it('an integrity failure is thrown with its code', async () => {
    vi.mocked(fetch).mockResolvedValue(
      response({ error: 'One transaction has inconsistent data, so these figures are paused.', code: 'semantic_integrity_error', transaction_id: 't-1' }, { ok: false, status: 500 }) as never
    );
    await expect(getTransactionEffects({ ...PERIOD, measure: 'spending' }, { cursor: null, limit: 50 })).rejects.toMatchObject({
      code: 'semantic_integrity_error',
      status: 500,
    });
  });
});
