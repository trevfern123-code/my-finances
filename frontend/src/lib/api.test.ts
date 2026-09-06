import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('./supabaseClient', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

import { updateNavLayout } from './api';

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
