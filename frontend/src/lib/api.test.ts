import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('./supabaseClient', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

import {
  CLIENT_UPDATE_REQUIRED,
  createManualLoan,
  getInstitutionRemovalPreview,
  removeInstitution,
  getLinkedItems,
  isManualLoanCreationResolvedError,
  updateNavLayout,
  updateDashboardLayout,
  updateAppearance,
  updateFinancialPreferences,
  updateReportingRange,
} from './api';
import { appUpdate, CLIENT_API_LEVEL } from './appUpdate';

const SESSION_A = { user: { id: 'user-a' }, access_token: 'a-token' };
const SESSION_B = { user: { id: 'user-b' }, access_token: 'b-token' };

function okResponse(body: unknown) {
  return { ok: true, headers: new Headers(), status: 200, json: () => Promise.resolve(body) };
}

function clockSkewErrorResponse() {
  return { ok: false, headers: new Headers(), status: 401, json: () => Promise.resolve({ error: 'issued at future' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  // The shared update manager: a response reporting this level as supported clears "required".
  appUpdate.reportServerLevels(CLIENT_API_LEVEL, 0);
});

/**
 * These model the actual failure Codex found: authedFetch (reached here through the real,
 * unmocked updateNavLayout -> authedFetch call path) looks up "whoever is currently signed in"
 * itself, asynchronously, and that lookup — or its clock-skew retry, after a real delay — can
 * resolve to a *different* session than the one a save logically belongs to. `verifyOwnership` is
 * what must catch that, checked at the exact moment a request is about to be sent, not merely
 * once by the caller before starting.
 */
describe('updateNavLayout — request bound to the authenticated owner', () => {
  it('1. does not send the write if the session resolves to a different user before the lookup completes', async () => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_B } });
    const verifyOwnership = (session: { user: { id: string } }) => session.user.id === 'user-a';

    await expect(updateNavLayout({ tabs: [] }, verifyOwnership)).rejects.toThrow(/owner/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('2. re-verifies on the clock-skew retry and refuses if the session changed during the delay', async () => {
    vi.useFakeTimers();
    let lookups = 0;
    mockGetSession.mockImplementation(() => {
      lookups++;
      // First lookup (initial attempt): still A. Second lookup (during the retry): now B.
      return Promise.resolve({ data: { session: lookups === 1 ? SESSION_A : SESSION_B } });
    });
    vi.mocked(fetch).mockResolvedValueOnce(clockSkewErrorResponse() as never);
    const verifyOwnership = (session: { user: { id: string } }) => session.user.id === 'user-a';

    // Attach the rejection assertion immediately (before awaiting anything else) so it's a
    // synchronously-registered rejection handler, not one attached after the fact — avoids
    // Node's spurious "handled asynchronously" diagnostic for a promise chain this deep.
    const assertion = expect(updateNavLayout({ tabs: [] }, verifyOwnership)).rejects.toThrow(/owner/i);
    // advanceTimersByTimeAsync flushes pending microtasks (the first getSession/fetch/json calls)
    // as it goes, so the clock-skew setTimeout gets registered and then run within this one call.
    await vi.advanceTimersByTimeAsync(1500);

    await assertion;
    expect(fetch).toHaveBeenCalledTimes(1); // the retry's fetch() was never reached
    vi.useRealTimers();
  });

  it('3. a verifyOwnership that also encodes a stale auth generation rejects even a matching user id', async () => {
    // Simulates "A generation 1 -> logout -> A generation 3": the session is genuinely A again,
    // but the save belongs to a generation that is no longer current — a real verifyOwnership
    // (see hooks/useNavLayout.ts) checks this in addition to the user id.
    mockGetSession.mockResolvedValue({ data: { session: SESSION_A } });
    const verifyOwnership = () => false; // user id would match; generation does not

    await expect(updateNavLayout({ tabs: [] }, verifyOwnership)).rejects.toThrow(/owner/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('4. succeeds normally when ownership verifies', async () => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_A } });
    vi.mocked(fetch).mockResolvedValue(okResponse({ nav_layout: { tabs: [] } }) as never);
    const verifyOwnership = (session: { user: { id: string } }) => session.user.id === 'user-a';

    const result = await updateNavLayout({ tabs: [] }, verifyOwnership);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ nav_layout: { tabs: [] } });
  });

  it('5. an owner mismatch from the very first lookup fails cleanly without ever reaching the endpoint', async () => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_B } });
    const verifyOwnership = (session: { user: { id: string } }) => session.user.id === 'user-a';

    await expect(updateNavLayout({ tabs: [] }, verifyOwnership)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

/**
 * The authenticated-preference-isolation remediation made `verifyOwnership` required (not
 * optional) on every one of these four update* functions too, for the identical reason
 * updateNavLayout already required it — closing the narrow window where a save created under one
 * authenticated lifecycle could otherwise be sent under whichever lifecycle happens to be current
 * by the time authedFetch's own session lookup resolves. These are deliberately compact (one
 * owner-mismatch case, one success case) per function rather than the full 5-case matrix above —
 * the underlying mechanism (authedFetch's verifyOwnership check, including the clock-skew retry)
 * is already exhaustively covered there; what these confirm is only that each function actually
 * threads its own verifyOwnership argument through to it, catching a copy-paste mistake in any
 * one of the four.
 */
describe.each([
  {
    label: 'updateDashboardLayout',
    call: (verify: (session: { user: { id: string } }) => boolean) =>
      updateDashboardLayout({ cards: [] }, verify as never),
    successBody: { dashboard_layout: { cards: [] } },
  },
  {
    label: 'updateAppearance',
    call: (verify: (session: { user: { id: string } }) => boolean) =>
      updateAppearance({ theme: 'dark', accent_color: 'green' }, verify as never),
    successBody: { theme: 'dark', accent_color: 'green' },
  },
  {
    label: 'updateFinancialPreferences',
    call: (verify: (session: { user: { id: string } }) => boolean) =>
      updateFinancialPreferences(
        {
          minimum_cash_buffer: 0,
          upcoming_bills_days: 14,
          recent_avg_months: 2,
          savings_rate_target: 15,
          safe_to_spend_include_upcoming_bills: true,
          safe_to_spend_include_remaining_budget: true,
        },
        verify as never
      ),
    successBody: {
      minimum_cash_buffer: 0,
      upcoming_bills_days: 14,
      recent_avg_months: 2,
      savings_rate_target: 15,
      safe_to_spend_include_upcoming_bills: true,
      safe_to_spend_include_remaining_budget: true,
    },
  },
  {
    label: 'updateReportingRange',
    call: (verify: (session: { user: { id: string } }) => boolean) =>
      updateReportingRange({ reporting_range: '3m' as never }, verify as never),
    successBody: { reporting_range: '3m' },
  },
])('$label — request bound to the authenticated owner', ({ call, successBody }) => {
  it('does not send the write if the session resolves to a different user before the lookup completes', async () => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_B } });
    const verifyOwnership = (session: { user: { id: string } }) => session.user.id === 'user-a';

    await expect(call(verifyOwnership)).rejects.toThrow(/owner/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('succeeds normally when ownership verifies', async () => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_A } });
    vi.mocked(fetch).mockResolvedValue(okResponse(successBody) as never);
    const verifyOwnership = (session: { user: { id: string } }) => session.user.id === 'user-a';

    const result = await call(verifyOwnership);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual(successBody);
  });
});

describe('createManualLoan — server resolution codes (Round 12 remediation)', () => {
  const input = {
    name: 'Car', loan_type: 'personal' as const, current_balance: 100, origination_principal_amount: null,
    interest_rate_percentage: null, origination_date: null, term_months: null, minimum_payment_amount: null,
    next_payment_due_date: null, notes: null, match_text: null,
  };
  const ownedByA = (session: { user: { id: string } }) => session.user.id === 'user-a';

  it("carries the server's code onto the thrown error, so a since-deleted key is recognized as resolved", async () => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_A } });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, headers: new Headers(),
      status: 409,
      json: () => Promise.resolve({ error: 'already created and since deleted', code: 'idempotency_key_loan_deleted' }),
    } as never);

    const err = await createManualLoan(input, 'key-1', ownedByA).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('already created and since deleted');
    expect(isManualLoanCreationResolvedError(err)).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ headers: expect.objectContaining({ 'Idempotency-Key': 'key-1' }) });
  });

  it('an ordinary failure (no code) is NOT treated as resolved', async () => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_A } });
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false, headers: new Headers(),
      status: 500,
      json: () => Promise.resolve({ error: 'Failed to backfill loan matches' }),
    } as never);

    const err = await createManualLoan(input, 'key-1', ownedByA).catch((e: unknown) => e);

    expect(isManualLoanCreationResolvedError(err)).toBe(false);
  });
});

/**
 * Round 14 remediation: createManualLoan used to call authedFetch with no ownership verifier, so a
 * loan initiated by user A was sent with whichever session was current once authedFetch's session
 * lookup (or its clock-skew retry) resolved. These drive the real createManualLoan -> authedFetch
 * path with only supabase.auth.getSession and fetch faked.
 */
describe('createManualLoan — request bound to the initiating owner (Round 14 remediation)', () => {
  const input = {
    name: 'Car', loan_type: 'personal' as const, current_balance: 100, origination_principal_amount: null,
    interest_rate_percentage: null, origination_date: null, term_months: null, minimum_payment_amount: null,
    next_payment_due_date: null, notes: null, match_text: null,
  };
  const ownedByA = (session: { user: { id: string } }) => session.user.id === 'user-a';

  function bearerTokensSent(): string[] {
    return vi.mocked(fetch).mock.calls.map(
      (call) => ((call[1] as RequestInit).headers as Record<string, string>).Authorization
    );
  }

  it('a deferred getSession that resolves to user B is refused, and fetch is never called', async () => {
    let resolveSession!: (value: unknown) => void;
    mockGetSession.mockReturnValue(new Promise((resolve) => (resolveSession = resolve)));

    const sending = createManualLoan(input, 'key-1', ownedByA);
    // The identity changes while the lookup is outstanding.
    resolveSession({ data: { session: SESSION_B } });

    await expect(sending).rejects.toThrow(/owner/i);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('a clock-skew retry is re-verified: after switching to B the retry is refused and B\'s token is never sent', async () => {
    vi.useFakeTimers();
    let lookups = 0;
    mockGetSession.mockImplementation(() => {
      lookups++;
      return Promise.resolve({ data: { session: lookups === 1 ? SESSION_A : SESSION_B } });
    });
    vi.mocked(fetch).mockResolvedValueOnce(clockSkewErrorResponse() as never);

    const assertion = expect(createManualLoan(input, 'key-1', ownedByA)).rejects.toThrow(/owner/i);
    await vi.advanceTimersByTimeAsync(1500);
    await assertion;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(bearerTokensSent()).toEqual(['Bearer a-token']);
    vi.useRealTimers();
  });

  it('same user: sends once with A\'s token, carrying the idempotency key', async () => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_A } });
    vi.mocked(fetch).mockResolvedValue(okResponse({ loan: { id: 'loan-1' } }) as never);

    const result = await createManualLoan(input, 'key-1', ownedByA);

    expect(result).toEqual({ loan: { id: 'loan-1' } });
    expect(bearerTokensSent()).toEqual(['Bearer a-token']);
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ headers: expect.objectContaining({ 'Idempotency-Key': 'key-1' }) });
  });

  it('Round 16: posts ONLY to the idempotent route, never the legacy non-idempotent one', async () => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_A } });
    vi.mocked(fetch).mockResolvedValue(okResponse({ loan: { id: 'loan-1' } }) as never);

    await createManualLoan(input, 'key-1', ownedByA);

    const url = String(vi.mocked(fetch).mock.calls[0][0]);
    expect(url.endsWith('/api/manual-loans/idempotent')).toBe(true);
    expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({ method: 'POST' });
  });

  it('same user: a clock-skew retry still goes through, with A\'s token both times', async () => {
    vi.useFakeTimers();
    mockGetSession.mockResolvedValue({ data: { session: SESSION_A } });
    vi.mocked(fetch)
      .mockResolvedValueOnce(clockSkewErrorResponse() as never)
      .mockResolvedValueOnce(okResponse({ loan: { id: 'loan-1' } }) as never);

    const sending = createManualLoan(input, 'key-1', ownedByA);
    await vi.advanceTimersByTimeAsync(1500);

    await expect(sending).resolves.toEqual({ loan: { id: 'loan-1' } });
    expect(bearerTokensSent()).toEqual(['Bearer a-token', 'Bearer a-token']);
    vi.useRealTimers();
  });

  it('the verifier is consulted with the exact session about to be used', async () => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_A } });
    vi.mocked(fetch).mockResolvedValue(okResponse({ loan: { id: 'loan-1' } }) as never);
    const verify = vi.fn(() => true);

    await createManualLoan(input, 'key-1', verify);

    expect(verify).toHaveBeenCalledWith(SESSION_A);
    expect(verify.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(fetch).mock.invocationCallOrder[0]);
  });
});

/** Service-worker/version compatibility, phase 2: the client side of backend/src/middleware/clientApiLevel.ts. */
describe('authedFetch — client API level', () => {
  const verifyA = (session: { user: { id: string } }) => session.user.id === 'user-a';

  function levelResponse(body: unknown, api: string, min: string, init: { ok?: boolean; status?: number } = {}) {
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      headers: new Headers({ 'X-Api-Level': api, 'X-Min-Client-Api-Level': min }),
      json: () => Promise.resolve(body),
    };
  }

  beforeEach(() => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_A } });
  });

  it('sends X-Client-Api-Level on reads and on mutations', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse({ items: [], is_sandbox: false }) as never);
    await getLinkedItems();
    await updateNavLayout({ tabs: [] }, verifyA);
    for (const call of vi.mocked(fetch).mock.calls) {
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers['X-Client-Api-Level']).toBe(String(CLIENT_API_LEVEL));
      expect(headers['X-Client-Api-Level']).toBe('1');
    }
  });

  it('reads both levels from every response', async () => {
    // Distinct from the values beforeEach resets to, so this only passes if the headers were read.
    vi.mocked(fetch).mockResolvedValue(levelResponse({ items: [] }, '7', '1') as never);
    await getLinkedItems();
    expect(appUpdate.getSnapshot()).toMatchObject({ serverApiLevel: 7, minClientApiLevel: 1, updateRequired: false });
  });

  it('a newer server level alone does not block: mutations still go out', async () => {
    vi.mocked(fetch).mockResolvedValue(levelResponse({ items: [] }, '2', '1') as never);
    await getLinkedItems();
    expect(appUpdate.isUpdateRequired()).toBe(false);
    await updateNavLayout({ tabs: [] }, verifyA);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('a minimum above this client blocks new mutations before they are sent (reads still work)', async () => {
    vi.mocked(fetch).mockResolvedValue(levelResponse({ items: [] }, '2', '2') as never);
    await getLinkedItems();
    expect(appUpdate.isUpdateRequired()).toBe(true);

    await expect(updateNavLayout({ tabs: [] }, verifyA)).rejects.toMatchObject({ code: CLIENT_UPDATE_REQUIRED });
    await expect(createManualLoan({ name: 'x' } as never, 'key-1', verifyA)).rejects.toMatchObject({
      code: CLIENT_UPDATE_REQUIRED,
    });
    expect(fetch).toHaveBeenCalledTimes(1); // only the read
    await getLinkedItems();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('409 client_update_required marks the update required, throws coded, and is never replayed', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      levelResponse({ error: 'This version of the app is out of date', code: 'client_update_required' }, '1', '0', {
        ok: false,
        status: 409,
      }) as never
    );
    await expect(updateNavLayout({ tabs: [] }, verifyA)).rejects.toMatchObject({ code: CLIENT_UPDATE_REQUIRED });
    expect(appUpdate.isUpdateRequired()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    // Nothing resends it later either: the next mutation is refused locally.
    await expect(updateNavLayout({ tabs: [] }, verifyA)).rejects.toMatchObject({ code: CLIENT_UPDATE_REQUIRED });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('a network/CORS failure on a mutation is not retried', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await expect(createManualLoan({ name: 'x' } as never, 'key-1', verifyA)).rejects.toThrow('Failed to fetch');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(appUpdate.getSnapshot().guards).toEqual([]);
  });

  it('a mutation holds the update guard for its whole lifecycle, including the clock-skew retry', async () => {
    vi.useFakeTimers();
    let resolveSecond!: (v: unknown) => void;
    vi.mocked(fetch)
      .mockResolvedValueOnce(clockSkewErrorResponse() as never)
      .mockImplementationOnce(() => new Promise((r) => (resolveSecond = r)) as never);
    const guardsSeen: string[][] = [];
    mockGetSession.mockImplementation(() => {
      guardsSeen.push(appUpdate.getSnapshot().guards);
      return Promise.resolve({ data: { session: SESSION_A } });
    });

    const pending = updateNavLayout({ tabs: [] }, verifyA);
    await vi.advanceTimersByTimeAsync(0);
    expect(appUpdate.getSnapshot().guards).toEqual(['mutation']); // waiting out the retry delay
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(appUpdate.getSnapshot().guards).toEqual(['mutation']); // the retry is in flight
    resolveSecond(okResponse({ nav_layout: { tabs: [] } }));
    await pending;
    expect(guardsSeen.every((g) => g.includes('mutation'))).toBe(true);
    expect(appUpdate.getSnapshot().guards).toEqual([]);
    vi.useRealTimers();
  });

  it('releases the guard when the mutation fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: () => Promise.resolve({ error: 'boom' }),
    } as never);
    await expect(updateNavLayout({ tabs: [] }, verifyA)).rejects.toThrow('boom');
    expect(appUpdate.getSnapshot().guards).toEqual([]);
  });

  it('reads never take the mutation guard', async () => {
    let resolveFetch!: (v: unknown) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((r) => (resolveFetch = r)) as never);
    const pending = getLinkedItems();
    await Promise.resolve();
    await Promise.resolve();
    expect(appUpdate.getSnapshot().guards).toEqual([]);
    resolveFetch(okResponse({ items: [], is_sandbox: false }));
    await pending;
  });
});

describe('institution removal requests (Linked Institution Management)', () => {
  const verifyA = (session: { user: { id: string } }) => session.user.id === 'user-a';

  beforeEach(() => {
    mockGetSession.mockResolvedValue({ data: { session: SESSION_A } });
  });

  it('POSTs the confirmed digest and holds the app-update mutation guard for the whole request', async () => {
    let resolveFetch!: (v: unknown) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((r) => (resolveFetch = r)) as never);
    const pending = removeInstitution('item-1', 'digest-1', verifyA);
    await Promise.resolve();
    await Promise.resolve();
    expect(appUpdate.getSnapshot().guards).toEqual(['mutation']);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/plaid\/items\/item-1\/removal$/);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ preview_digest: 'digest-1' });
    resolveFetch(okResponse({ removal: { status: 'cleaned', finished: true } }));
    await pending;
    expect(appUpdate.getSnapshot().guards).toEqual([]);
  });

  it('a resume sends no digest', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(okResponse({ removal: {} }) as never);
    await removeInstitution('item-1', null, verifyA);
    expect(JSON.parse(String((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body))).toEqual({});
  });

  it('is refused before sending when this build is out of date (never removes on an incompatible client)', async () => {
    appUpdate.markUpdateRequired();
    await expect(removeInstitution('item-1', 'digest-1', verifyA)).rejects.toMatchObject({ code: 'client_update_required' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('the preview is a plain read (no mutation guard)', async () => {
    let resolveFetch!: (v: unknown) => void;
    vi.mocked(fetch).mockImplementationOnce(() => new Promise((r) => (resolveFetch = r)) as never);
    const pending = getInstitutionRemovalPreview('item-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(appUpdate.getSnapshot().guards).toEqual([]);
    resolveFetch(okResponse({ preview: {}, blocked_reason: null, blocked_message: null }));
    await pending;
  });
});
