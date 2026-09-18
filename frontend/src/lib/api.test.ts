import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('./supabaseClient', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

import {
  createManualLoan,
  isManualLoanCreationResolvedError,
  updateNavLayout,
  updateDashboardLayout,
  updateAppearance,
  updateFinancialPreferences,
  updateReportingRange,
} from './api';

const SESSION_A = { user: { id: 'user-a' }, access_token: 'a-token' };
const SESSION_B = { user: { id: 'user-b' }, access_token: 'b-token' };

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

function clockSkewErrorResponse() {
  return { ok: false, status: 401, json: () => Promise.resolve({ error: 'issued at future' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
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
      ok: false,
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
      ok: false,
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
