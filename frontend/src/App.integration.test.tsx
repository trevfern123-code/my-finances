// @vitest-environment jsdom
//
// Narrow React integration harness targeting exactly the authenticated-lifecycle boundary Codex
// found bugs at across multiple review rounds — bugs pure-function tests structurally cannot
// catch (whether a component actually remounts, whether StrictMode's setup/cleanup/setup leaves a
// usable instance, whether a *stale* setup's own late-resolving bootstrap promise stays a no-op
// after that exact setup was cleaned up, whether the returned Session's own JWT claim — not just
// ambient React state — is what request ownership is actually checked against, whether the
// Navigation write coordinator genuinely survives a full harness remount). Scoped to this one
// boundary; the rest of this project's ~260 tests stay framework-agnostic and un-mocked, matching
// its existing convention.
//
// AuthHarness/AuthSessionProbe below are thin test-local wrappers, not a parallel production
// architecture: both call the *real*, exported `useAuthSession` hook directly — the same
// implementation App.tsx itself uses — rather than re-implementing any part of its bootstrap/live-
// event logic. An earlier review round tested a hand-copied re-implementation of that effect (a
// `BootstrapHarness`) instead of the real one; that copy could (and did) silently drift from what
// App.tsx actually does. There is now only one place this logic exists — see hooks/useAuthSession.ts.
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, StrictMode, type MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavLayoutScope, PreferencesScope, navigationWriteCoordinator, type PreferencesFetchOutcome } from './App';
import { currentGenerationValue, type AuthState } from './lib/authGeneration';
import { getSpendingSummary, type NavLayoutEntry, type UserPreferences } from './lib/api';
import { NavigationWriteCoordinator } from './lib/navigationWriteCoordinator';
import { DEFAULT_REPORTING_RANGE, type ReportingRangeId } from './lib/reportingRange';
import { useAuthSession } from './hooks/useAuthSession';

const mockGetSession = vi.hoisted(() => vi.fn());
const mockOnAuthStateChange = vi.hoisted(() => vi.fn());
vi.mock('./lib/supabaseClient', () => ({
  supabase: { auth: { getSession: mockGetSession, onAuthStateChange: mockOnAuthStateChange } },
}));

interface FakeSession {
  user: { id: string };
  access_token: string;
}

/** Builds a session whose access_token is a real (unsigned — decodeSessionId never checks the
 *  signature), decodable fake JWT carrying the given session_id claim, so the full real
 *  encode/decode pipeline is exercised end to end rather than bypassed. */
function fakeSession(userId: string, sessionId: string): FakeSession {
  const base64url = (obj: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({ sub: userId, session_id: sessionId });
  return { user: { id: userId }, access_token: `${header}.${payload}.fake-signature` };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) };
}

/** Whether a PUT to a URL containing `urlSubstring` was ever sent on the shared `fetch` mock — used
 *  by the save-ownership tests below to check for a *specific* write, since the same mock now also
 *  captures the harness's read-only range-data GETs (see PreferencesHarness's applyRangeData),
 *  which legitimately fire alongside a save action and would make a bare "fetch was/wasn't called"
 *  count assertion too broad. */
function wasPutCalledWith(urlSubstring: string): boolean {
  return vi
    .mocked(fetch)
    .mock.calls.some(([url, init]) => String(url).includes(urlSubstring) && (init as RequestInit | undefined)?.method === 'PUT');
}

type Frame = { userId: string | null; sessionId: string | null };
type LiveCallback = (event: string, session: FakeSession | null) => void;

// Tracks whatever session the mocked Supabase client would currently report — mirrors real
// `supabase.auth.getSession()` semantics (it always reflects the client's live state, not whatever
// was true when some earlier call was made) so authedFetch's own per-submission session lookup
// (inside AuthHarness's `save`, or the real lib/api.ts authedFetch used by the lifetime tests) sees
// realistic data without every test having to hand-wire it. Tests that need a *stale* or delayed
// lookup (request-binding, clock-skew) override `mockGetSession` themselves, same as before.
let currentFakeSession: FakeSession | null = null;
let latestLiveCallback: LiveCallback | null = null;

/** Simulates a live `onAuthStateChange` push (sign-in, sign-out, or a same-session re-emission) —
 *  the same path a real Supabase client uses, and the only way any of these tests drive auth state:
 *  no test dispatches into a reducer directly, so every test exercises the real, exported
 *  `useAuthSession` hook's actual bootstrap/live-event handling, not a bypass of it. */
function emitAuthEvent(session: FakeSession | null) {
  currentFakeSession = session;
  latestLiveCallback!('AUTH_EVENT', session);
}

type PrefsFrame = {
  userId: string | null;
  sessionId: string | null;
  status: 'loading' | 'ready' | 'error';
  dashboardVisibleIds: string[];
  theme: string;
  accent: string;
  minimumCashBuffer: number;
  savingsRateTarget: number;
  includeUpcomingBills: boolean;
  range: string;
  /** The harness's own range-dependent proxy dataset (see applyRangeData below) — undefined until
   *  a request for the CURRENT sessionId/range/attempt has actually committed. */
  rangeNetWorth: number | undefined;
};

/** Builds a full UserPreferences payload (the exact shape App.tsx's real refreshAll() gets back
 *  from getUserPreferences()) with sensible defaults, so each test only has to override the
 *  field(s) it actually cares about. */
function fakePreferences(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    dashboard_layout: null,
    nav_layout: null,
    theme: 'system',
    accent_color: 'green',
    minimum_cash_buffer: 0,
    upcoming_bills_days: 14,
    recent_avg_months: 2,
    savings_rate_target: 15,
    safe_to_spend_include_upcoming_bills: true,
    safe_to_spend_include_remaining_budget: true,
    reporting_range: 'last_6_months',
    ...overrides,
  };
}

/** Imperative escape hatches for tests to simulate "App.tsx's refreshAll() just had its
 *  getUserPreferences() call settle" — reassigned on every PreferencesHarness render (same pattern
 *  as `emitAuthEvent`/`latestLiveCallback` above), always pointing at the currently mounted harness
 *  instance's own setters. `forSessionId` lets a test simulate a fetch that was *initiated* under
 *  an earlier sessionId settling after the lifecycle has already moved on — exactly mirroring
 *  App.tsx's own `requestedForSessionId` capture in refreshAll. `resolvePreferencesFetch` models a
 *  successful fetch; `rejectPreferencesFetch` models `getUserPreferences()` itself rejecting. */
let resolvePreferencesFetch: ((payload: UserPreferences, forSessionId: string) => void) | null = null;
let rejectPreferencesFetch: ((forSessionId: string) => void) | null = null;

/** Thin test-local wrapper mirroring App.tsx's own preferencesOutcome/preferencesOutcomeSessionId
 *  state, its tri-state `preferencesStatus` derivation, and its range-dataset ownership mechanism
 *  (reportingRangeRef/rangeDataRequestIdRef/applyReportingRange) — reusing the real, exported
 *  PreferencesScope, the real `PreferencesFetchOutcome` type, the real `currentGenerationValue`
 *  function, and the real `getSpendingSummary` from lib/api.ts (so a save/fetch here goes through
 *  the same authedFetch/session-lookup path production does), not a re-implementation of any of
 *  them. Directly analogous to how AuthHarness already mirrors App.tsx's sessionIdRef/
 *  isSessionCurrent wiring around the real, exported NavLayoutScope. The one piece that IS
 *  necessarily re-expressed here (not imported) is the shape of the monotonic request-id ownership
 *  check itself — App.tsx's version lives inside its own closures over `setSummary` et al. and
 *  can't be imported standalone without rendering all of `<App>`; the check is a single `===`
 *  comparison against a `useRef<number>`, mirrored 1:1 with App.tsx's own (see its own comments on
 *  `rangeDataRequestIdRef`/`applyReportingRange`/`refreshSummary`) rather than approximated. */
function PreferencesHarness({ frames }: { frames: PrefsFrame[] }) {
  const auth = useAuthSession();
  const userId = auth.session?.user.id ?? null;
  const sessionIdRef = useRef(auth.sessionId);
  useLayoutEffect(() => {
    sessionIdRef.current = auth.sessionId;
  }, [auth.sessionId]);
  const isSessionCurrent = useCallback((id: string) => sessionIdRef.current === id, []);

  const [preferencesOutcome, setPreferencesOutcome] = useState<PreferencesFetchOutcome | undefined>(undefined);
  const [preferencesOutcomeSessionId, setPreferencesOutcomeSessionId] = useState<string | undefined>(undefined);
  const preferencesOutcomeForCurrentSession = currentGenerationValue(
    preferencesOutcome,
    preferencesOutcomeSessionId,
    auth.sessionId
  );
  const preferencesStatus: 'loading' | 'ready' | 'error' = preferencesOutcomeForCurrentSession?.status ?? 'loading';
  const preferencesForCurrentSession =
    preferencesOutcomeForCurrentSession?.status === 'ready' ? preferencesOutcomeForCurrentSession.payload : undefined;

  resolvePreferencesFetch = (payload, forSessionId) => {
    setPreferencesOutcome({ status: 'ready', payload });
    setPreferencesOutcomeSessionId(forSessionId);
  };
  rejectPreferencesFetch = (forSessionId) => {
    setPreferencesOutcome({ status: 'error' });
    setPreferencesOutcomeSessionId(forSessionId);
  };

  // --- range-dataset ownership — mirrors App.tsx's reportingRangeRef/rangeDataRequestIdRef/
  // applyReportingRange/refreshSummary exactly; see this function's own doc comment above. ---
  const reportingRangeRef = useRef<ReportingRangeId>(DEFAULT_REPORTING_RANGE);
  const rangeDataRequestIdRef = useRef(0);
  const [rangeNetWorth, setRangeNetWorth] = useState<number | undefined>(undefined);

  // Clears the range-dependent proxy dataset the instant the lifecycle changes — mirrors App.tsx's
  // own sessionId-keyed clear in its `[sessionId, refreshAll]` effect exactly, for the identical
  // reason: without it, the render immediately after a lifecycle change could still show the
  // previous lifecycle's own rangeNetWorth value until this scope's own hydration completes.
  useEffect(() => {
    if (!auth.sessionId) return;
    setRangeNetWorth(undefined);
  }, [auth.sessionId]);

  async function applyRangeData(range: ReportingRangeId) {
    reportingRangeRef.current = range;
    const requestId = ++rangeDataRequestIdRef.current;
    try {
      const res = await getSpendingSummary(range);
      if (requestId === rangeDataRequestIdRef.current) setRangeNetWorth(res.net_worth);
    } catch {
      // ignore — mirrors App.tsx's refreshSummary
    }
  }

  // Mirrors App.tsx's own gating exactly: PreferencesScope is not rendered at all — not even with
  // a placeholder `saved` — until `preferencesStatus === 'ready'`. See App.tsx's own render body
  // and PreferencesScope's doc comment for why this (not an internal status flag passed into an
  // always-mounted scope) is what makes "edit before hydration" structurally unreachable.
  if (preferencesStatus === 'loading') {
    frames.push({
      userId,
      sessionId: auth.sessionId,
      status: 'loading',
      dashboardVisibleIds: [],
      theme: '',
      accent: '',
      minimumCashBuffer: 0,
      savingsRateTarget: 0,
      includeUpcomingBills: false,
      range: '',
      rangeNetWorth: undefined,
    });
    return <p data-testid="prefs-loading">Loading preferences...</p>;
  }
  if (preferencesStatus === 'error') {
    frames.push({
      userId,
      sessionId: auth.sessionId,
      status: 'error',
      dashboardVisibleIds: [],
      theme: '',
      accent: '',
      minimumCashBuffer: 0,
      savingsRateTarget: 0,
      includeUpcomingBills: false,
      range: '',
      rangeNetWorth: undefined,
    });
    // No Retry button here deliberately: App's real one just re-invokes refreshAll(), which this
    // harness doesn't reconstruct (see the harness's own doc comment) — tests simulate a
    // successful retry the same way they simulate the original fetch, by calling
    // resolvePreferencesFetch directly, which is the exact mechanism App's refreshAll would drive
    // it through on a real retry.
    return <p data-testid="prefs-error">Couldn't load preferences.</p>;
  }
  const currentPreferences = preferencesForCurrentSession!;

  return (
    <PreferencesScope
      key={auth.sessionId ?? 'signed-out'}
      userId={userId}
      sessionId={auth.sessionId ?? ''}
      isSessionCurrent={isSessionCurrent}
      saved={currentPreferences}
      onReportingRangeReady={applyRangeData}
    >
      {({ dashboardLayout, appearance, financialPreferences, reportingRange }) => {
        frames.push({
          userId,
          sessionId: auth.sessionId,
          status: 'ready',
          dashboardVisibleIds: dashboardLayout.layout.filter((c) => c.visible).map((c) => c.id),
          theme: appearance.theme,
          accent: appearance.accent,
          minimumCashBuffer: financialPreferences.minimumCashBuffer,
          savingsRateTarget: financialPreferences.savingsRateTarget,
          includeUpcomingBills: financialPreferences.includeUpcomingBills,
          range: reportingRange.range,
          rangeNetWorth,
        });
        return (
          <div data-testid="prefs-content">
            <button data-testid="toggle-stats" onClick={() => dashboardLayout.toggleVisibility('stats')}>
              Toggle stats
            </button>
            <button data-testid="set-theme-dark" onClick={() => appearance.setTheme('dark')}>
              Dark
            </button>
            <button data-testid="set-accent-blue" onClick={() => appearance.setAccent('blue')}>
              Blue
            </button>
            <button data-testid="appearance-retry" onClick={() => appearance.retry()}>
              Retry appearance
            </button>
            <span data-testid="appearance-status">{appearance.saveStatus}</span>
            <button data-testid="set-savings-rate-25" onClick={() => financialPreferences.setSavingsRateTarget(25)}>
              Set savings 25
            </button>
            <button data-testid="set-min-cash-500" onClick={() => financialPreferences.setMinimumCashBuffer(500)}>
              Set min cash 500
            </button>
            <button data-testid="financial-retry" onClick={() => financialPreferences.retry()}>
              Retry financial
            </button>
            <span data-testid="financial-status">{financialPreferences.saveStatus}</span>
            <button data-testid="set-range-3m" onClick={() => reportingRange.setRange('last_3_months')}>
              3 months
            </button>
            <button data-testid="simulate-plaid-linked" onClick={() => applyRangeData(reportingRangeRef.current)}>
              Simulate successful Plaid link
            </button>
            <span data-testid="layout">{JSON.stringify(dashboardLayout.layout)}</span>
            <span data-testid="theme">{appearance.theme}</span>
            <span data-testid="accent">{appearance.accent}</span>
            <span data-testid="savings-rate">{financialPreferences.savingsRateTarget}</span>
            <span data-testid="min-cash">{financialPreferences.minimumCashBuffer}</span>
            <span data-testid="include-upcoming-bills">{String(financialPreferences.includeUpcomingBills)}</span>
            <span data-testid="range">{reportingRange.range}</span>
            <span data-testid="range-net-worth">{rangeNetWorth ?? ''}</span>
          </div>
        );
      }}
    </PreferencesScope>
  );
}

function AuthHarness({
  loading = false,
  saved,
  frames,
  coordinator,
}: {
  loading?: boolean;
  saved?: NavLayoutEntry[] | null;
  frames: Frame[];
  /** Omit for a fresh, test-private coordinator (the default — keeps most tests fully isolated
   *  from each other). Only the coordinator-lifetime tests pass the real, exported production
   *  singleton (App.tsx's own `navigationWriteCoordinator`) to prove it actually survives a full
   *  harness remount, not merely a NavLayoutScope remount within one still-mounted harness. */
  coordinator?: NavigationWriteCoordinator;
}) {
  const auth = useAuthSession();
  const userId = auth.session?.user.id ?? null;
  // Mirrors App.tsx's own sessionIdRef/isSessionCurrent exactly — updated in useLayoutEffect,
  // never during render, for the same commit-safety reason.
  const sessionIdRef = useRef(auth.sessionId);
  useLayoutEffect(() => {
    sessionIdRef.current = auth.sessionId;
  }, [auth.sessionId]);
  const isSessionCurrent = useCallback((id: string) => sessionIdRef.current === id, []);
  const coordinatorRef = useRef<NavigationWriteCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current =
      coordinator ??
      new NavigationWriteCoordinator({
        // Mirrors lib/api.ts's real authedFetch ordering exactly: the session is looked up and
        // verified BEFORE the network call is ever made, not after — this is the whole point of
        // Case C (a superseded request must never reach the wire at all).
        save: async (layout, verify) => {
          const session = (await mockGetSession()).data.session;
          if (!session) throw new Error('Not signed in');
          if (!verify(session)) throw new Error('Session no longer matches the expected authenticated owner');
          const res = await (globalThis.fetch as unknown as typeof fetch)('/fake', { method: 'PUT' });
          if (!res.ok) throw new Error('save failed');
          return res.json();
        },
      });
  }

  return (
    <NavLayoutScope
      key={auth.sessionId ?? 'signed-out'}
      userId={userId}
      sessionId={auth.sessionId ?? ''}
      isSessionCurrent={isSessionCurrent}
      coordinator={coordinatorRef.current}
      saved={saved}
    >
      {(navLayout) => {
        frames.push({ userId, sessionId: auth.sessionId });
        if (loading) return <p data-testid="loading">Loading...</p>;
        return (
          <div data-testid="content">
            <button data-testid="hide-loans" onClick={() => navLayout.toggleVisibility('loans')}>
              Hide
            </button>
            <button data-testid="retry" onClick={() => navLayout.retry()}>
              Retry
            </button>
            <span data-testid="status">{navLayout.status}</span>
            <span data-testid="layout">{JSON.stringify(navLayout.layout)}</span>
          </div>
        );
      }}
    </NavLayoutScope>
  );
}

/** Thin wrapper around the real `useAuthSession` hook, for tests that only need to observe
 *  `{session, sessionId}` transitions — bootstrap-ordering and StrictMode/unmount invalidation —
 *  without NavLayoutScope or a coordinator at all. */
function AuthSessionProbe({ onState }: { onState: (state: AuthState) => void }) {
  const auth = useAuthSession();
  useEffect(() => {
    onState(auth);
  });
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  currentFakeSession = null;
  latestLiveCallback = null;
  resolvePreferencesFetch = null;
  mockOnAuthStateChange.mockImplementation((cb: LiveCallback) => {
    latestLiveCallback = cb;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  mockGetSession.mockImplementation(() => Promise.resolve({ data: { session: currentFakeSession } }));
});

afterEach(() => {
  // This project's vitest.config.ts does not set `test.globals: true` (deliberately — every other
  // test file imports its own describe/it/expect), so @testing-library/react's auto-cleanup, which
  // hooks a global afterEach, never registers. Without an explicit cleanup() call each rendered
  // tree stays mounted into the next test, and a later getByTestId can match a stale element from
  // a previous test instead of throwing "not found" — clean up explicitly instead.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('1. an A -> B transition never commits userId=B with A\'s sessionId/key', () => {
  it('no recorded frame ever pairs a new user id with the previous sessionId', async () => {
    const frames: Frame[] = [];
    render(<AuthHarness frames={frames} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-a')).toBe(true));
    const aSessionId = frames.find((f) => f.userId === 'user-a')!.sessionId;

    act(() => emitAuthEvent(fakeSession('user-b', 'sid-2')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-b')).toBe(true));

    const badFrame = frames.find((f) => f.userId === 'user-b' && f.sessionId === aSessionId);
    expect(badFrame).toBeUndefined();
  });
});

describe('2. NavLayoutScope remains mounted through an ordinary loading cycle', () => {
  it('an ordinary loading toggle never disposes (detaches) the Navigation coordinator attachment', async () => {
    const detachSpy = vi.spyOn(NavigationWriteCoordinator.prototype, 'detach');
    const frames: Frame[] = [];
    const { rerender } = render(<AuthHarness frames={frames} loading={false} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-a')).toBe(true));
    detachSpy.mockClear(); // ignore any StrictMode-unrelated setup noise before this point

    rerender(<AuthHarness frames={frames} loading={true} />);
    rerender(<AuthHarness frames={frames} loading={false} />);

    expect(detachSpy).not.toHaveBeenCalled();
  });
});

describe('3. pending Navigation persistence is not discarded by a normal refresh', () => {
  it('an in-flight save (and its status) survives a loading cycle and still completes afterward', async () => {
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-1') } });
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {})); // never resolves — stays "saving"

    const frames: Frame[] = [];
    const { getByTestId, rerender } = render(
      <AuthHarness frames={frames} saved={[{ id: 'loans', visible: true }]} />
    );

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => {
      getByTestId('hide-loans').click();
    });
    await waitFor(() => expect(getByTestId('status').textContent).toBe('saving'));

    // Simulate an ordinary refreshAll() cycle happening mid-save.
    rerender(<AuthHarness frames={frames} loading={true} saved={[{ id: 'loans', visible: true }]} />);
    rerender(<AuthHarness frames={frames} loading={false} saved={[{ id: 'loans', visible: true }]} />);

    // Still saving — the loading cycle did not discard or reset the in-flight/queued work.
    expect(getByTestId('status').textContent).toBe('saving');
  });
});

describe('4. StrictMode setup -> cleanup -> setup leaves a usable, live coordinator attachment', () => {
  it('a real Hide action under StrictMode actually reaches persistence', async () => {
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-1') } });
    vi.mocked(fetch).mockResolvedValue(okResponse({ nav_layout: { tabs: [] } }) as never);

    const frames: Frame[] = [];
    const { getByTestId } = render(
      <StrictMode>
        <AuthHarness frames={frames} saved={[{ id: 'loans', visible: true }]} />
      </StrictMode>
    );

    // latestLiveCallback is whichever effect setup is *currently* registered — under StrictMode's
    // synchronous dev-mode setup -> cleanup -> setup, that's already setup #2's by the time render()
    // returns, so this correctly targets the live, current attachment, never the cleaned-up one.
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => {
      getByTestId('hide-loans').click();
    });

    // If StrictMode's simulated cleanup had permanently disposed the attachment without a real
    // setup rebuilding it, this would silently never leave 'idle' and fetch() would never be called.
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('saved'));
  });
});

describe('5. a sid-1 save is rejected once the committed sessionId is sid-3, even with the same user id', () => {
  it('never reaches fetch() once superseded, and the coordinator surfaces an error', async () => {
    const sessionLookup = deferred<{ data: { session: FakeSession } }>();
    mockGetSession.mockReturnValue(sessionLookup.promise);

    const frames: Frame[] = [];
    const { getByTestId } = render(<AuthHarness frames={frames} saved={[{ id: 'loans', visible: true }]} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => {
      getByTestId('hide-loans').click(); // dispatched expecting sid-1, session lookup now pending
    });
    await waitFor(() => expect(getByTestId('status').textContent).toBe('saving'));

    // Advance to sid-3 (A -> signed out -> A again) while the lookup is still in flight.
    act(() => emitAuthEvent(null));
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-3')));

    // The lookup for the sid-1 request finally resolves — with the *same user*, 'user-a', and a
    // *different* session_id (sid-3, since the client's live session has moved on) — after the
    // committed sessionId has already advanced.
    await act(async () => {
      sessionLookup.resolve({ data: { session: fakeSession('user-a', 'sid-3') } });
      await sessionLookup.promise.catch(() => {});
    });

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('6. sign out then back into the same account gives a fresh Navigation lifecycle and rehydrates that lifecycle\'s data', () => {
  it('the second login\'s own saved layout is what renders, not the first session\'s', async () => {
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-1') } });

    const frames: Frame[] = [];
    const { getByTestId, rerender } = render(
      <AuthHarness frames={frames} saved={[{ id: 'loans', visible: false }]} />
    );

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => {
      const layout = JSON.parse(getByTestId('layout').textContent!);
      expect(layout.find((t: { id: string }) => t.id === 'loans').visible).toBe(false);
    });

    act(() => emitAuthEvent(null)); // sign out

    // Second login as the same user, with genuinely different saved data.
    rerender(<AuthHarness frames={frames} saved={[{ id: 'budget', visible: false }]} />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-3')));

    await waitFor(() => {
      const layout = JSON.parse(getByTestId('layout').textContent!);
      expect(layout.find((t: { id: string }) => t.id === 'budget').visible).toBe(false);
      expect(layout.find((t: { id: string }) => t.id === 'loans').visible).toBe(true); // not the first session's hide
    });
  });
});

describe('7. back-to-back batched SIGNED_OUT -> SIGNED_IN for the same user produces a new sessionId', () => {
  it('processes both actions sequentially even when delivered before React paints an intermediate frame', async () => {
    const frames: Frame[] = [];
    render(<AuthHarness frames={frames} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-a')).toBe(true));

    // Both events happen inside the SAME act() — modeling events delivered back-to-back, faster
    // than React could paint an intermediate signed-out frame.
    act(() => {
      emitAuthEvent(null);
      emitAuthEvent(fakeSession('user-a', 'sid-3'));
    });

    await waitFor(() => {
      const last = frames.filter((f) => f.userId === 'user-a').at(-1)!;
      expect(last.sessionId).toBe('sid-3');
      expect(last.sessionId).not.toBe('sid-1');
    });
  });
});

describe('8. request binding — the returned Session\'s own JWT session_id, not just ambient state', () => {
  it('A1 expecting sid-1 sees a returned Session with the same user id but a different session_id -> rejected before fetch', async () => {
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-3') } }); // returns sid-3
    const frames: Frame[] = [];
    const { getByTestId } = render(<AuthHarness frames={frames} saved={[{ id: 'loans', visible: true }]} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1'))); // committed/expected: sid-1
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => getByTestId('hide-loans').click());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('error'));
    expect(fetch).not.toHaveBeenCalled(); // rejected before the network call, purely on the direct session_id mismatch
  });

  it('same user + same session_id + a refreshed access token -> allowed', async () => {
    // A genuinely refreshed token: same session_id claim, different token string.
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-1') } });
    vi.mocked(fetch).mockResolvedValue(okResponse({ nav_layout: { tabs: [] } }) as never);

    const frames: Frame[] = [];
    const { getByTestId } = render(<AuthHarness frames={frames} saved={[{ id: 'loans', visible: true }]} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => getByTestId('hide-loans').click());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('saved'));
  });

  it('clock-skew retry scenario: a later session lookup returning a different session_id is rejected even mid-retry-style sequencing', async () => {
    const firstLookup = deferred<{ data: { session: FakeSession } }>();
    let callCount = 0;
    mockGetSession.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return firstLookup.promise;
      return Promise.resolve({ data: { session: fakeSession('user-a', 'sid-3') } }); // a later lookup sees sid-3
    });

    const frames: Frame[] = [];
    const { getByTestId } = render(<AuthHarness frames={frames} saved={[{ id: 'loans', visible: true }]} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => getByTestId('hide-loans').click());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('saving'));

    // First lookup finally resolves with the *original* sid-1 session (as if this were the first
    // attempt succeeding through to a save() call that itself re-checks on a later internal retry
    // path) — but by now sessionId has already moved to sid-3 client-side too.
    act(() => emitAuthEvent(null));
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-3')));
    await act(async () => {
      firstLookup.resolve({ data: { session: fakeSession('user-a', 'sid-1') } });
      await firstLookup.promise.catch(() => {});
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it('the direct returned-session check rejects even if the ambient isSessionCurrent ref were (hypothetically) stale', async () => {
    // Verifies §1's specific claim: rejection does not depend on the ambient ref catching up —
    // the returned session's own session_id is compared directly. We can't literally desync
    // React's committed state from Supabase's client here (that's the whole point of the fix), but
    // we can confirm the mismatch is caught the instant getSession() resolves, before any
    // additional render/commit cycle would have had a chance to update the ambient ref.
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-999-never-committed') } });
    const frames: Frame[] = [];
    const { getByTestId } = render(<AuthHarness frames={frames} saved={[{ id: 'loans', visible: true }]} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => getByTestId('hide-loans').click());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('error'));
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('9. auth bootstrap ordering', () => {
  it('a delayed bootstrap getSession(A1) resolving after a live B2 event never overwrites B2', async () => {
    const bootstrap = deferred<{ data: { session: FakeSession | null } }>();
    mockGetSession.mockReturnValue(bootstrap.promise);

    const states: AuthState[] = [];
    render(<AuthSessionProbe onState={(s) => states.push(s)} />);

    // B2's live event fires and is fully processed before the slow bootstrap ever resolves.
    await act(async () => {
      emitAuthEvent(fakeSession('user-b', 'sid-b2'));
    });
    expect(states.at(-1)).toEqual({ session: currentFakeSession, sessionId: 'sid-b2' });

    // The stale A1 bootstrap result finally resolves.
    await act(async () => {
      bootstrap.resolve({ data: { session: fakeSession('user-a', 'sid-a1') } });
      await bootstrap.promise;
    });

    expect(states.at(-1)?.sessionId).toBe('sid-b2'); // never reverted to A1
  });

  it('a delayed bootstrap getSession(A1) resolving after SIGNED_OUT -> A3 live events never overwrites A3', async () => {
    const bootstrap = deferred<{ data: { session: FakeSession | null } }>();
    mockGetSession.mockReturnValue(bootstrap.promise);

    const states: AuthState[] = [];
    render(<AuthSessionProbe onState={(s) => states.push(s)} />);

    await act(async () => {
      emitAuthEvent(null); // SIGNED_OUT
      emitAuthEvent(fakeSession('user-a', 'sid-a3')); // SIGNED_IN A3
    });
    expect(states.at(-1)?.sessionId).toBe('sid-a3');

    await act(async () => {
      bootstrap.resolve({ data: { session: fakeSession('user-a', 'sid-a1') } }); // stale A1
      await bootstrap.promise;
    });

    expect(states.at(-1)?.sessionId).toBe('sid-a3'); // never reverted to A1
  });

  it('a normal (fast) bootstrap followed by a duplicate live event for the same session applies cleanly', async () => {
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-1') } });

    const states: AuthState[] = [];
    render(<AuthSessionProbe onState={(s) => states.push(s)} />);

    await waitFor(() => expect(states.at(-1)?.sessionId).toBe('sid-1'));
    const countAfterBootstrap = states.length;

    await act(async () => {
      emitAuthEvent(fakeSession('user-a', 'sid-1')); // duplicate re-emission, same session_id
    });

    expect(states.at(-1)?.sessionId).toBe('sid-1'); // unchanged, no spurious reset
    expect(states.length).toBe(countAfterBootstrap + 1); // one clean extra reduction, nothing odd
  });
});

describe('10. StrictMode / real-unmount bootstrap invalidation (Blocker 1)', () => {
  it('a stale setup #1 bootstrap resolving after StrictMode cleanup + setup #2\'s live B2 never overwrites B2', async () => {
    const bootstrap1 = deferred<{ data: { session: FakeSession | null } }>();
    let getSessionCallIndex = 0;
    mockGetSession.mockImplementation(() => {
      getSessionCallIndex += 1;
      // setup #1's own bootstrap call — held open, resolved explicitly later in this test.
      if (getSessionCallIndex === 1) return bootstrap1.promise;
      // setup #2's own bootstrap call — irrelevant to this test, left permanently pending.
      return new Promise(() => {});
    });
    const liveCallbacks: LiveCallback[] = [];
    const unsubscribes: ReturnType<typeof vi.fn>[] = [];
    mockOnAuthStateChange.mockImplementation((cb: LiveCallback) => {
      liveCallbacks.push(cb);
      const unsub = vi.fn();
      unsubscribes.push(unsub);
      return { data: { subscription: { unsubscribe: unsub } } };
    });

    const states: AuthState[] = [];
    render(
      <StrictMode>
        <AuthSessionProbe onState={(s) => states.push(s)} />
      </StrictMode>
    );

    // React has already run setup #1 -> cleanup #1 -> setup #2 synchronously as part of this
    // initial render (this is the same StrictMode double-invoke test 4 above already relies on).
    // liveCallbacks[0] is setup #1's (now cleaned-up) callback; liveCallbacks[1] is setup #2's
    // (current) one — and setup #1's own unsubscribe must already have run.
    expect(liveCallbacks.length).toBe(2);
    expect(unsubscribes[0]).toHaveBeenCalled();

    // setup #2 (the live, current one) observes a live B2 event.
    await act(async () => {
      liveCallbacks[1]('AUTH_EVENT', fakeSession('user-b', 'sid-b2'));
    });
    expect(states.at(-1)?.sessionId).toBe('sid-b2');

    // setup #1's stale bootstrap (A1) finally resolves, long after its own cleanup ran — it must
    // be a complete no-op: not merely superseded by sawLiveEvent (setup #1's own sawLiveEvent is,
    // from its own point of view, still false — it never saw a live event itself), but blocked by
    // the `active` invalidation flag set the instant setup #1 was cleaned up.
    await act(async () => {
      bootstrap1.resolve({ data: { session: fakeSession('user-a', 'sid-a1') } });
      await bootstrap1.promise;
    });

    expect(states.at(-1)?.sessionId).toBe('sid-b2'); // still B2 — never reverted to setup #1's stale A1
    expect(states.some((s) => s.sessionId === 'sid-a1')).toBe(false);
  });

  it('a bootstrap resolving after a genuine component unmount never dispatches', async () => {
    const bootstrap = deferred<{ data: { session: FakeSession | null } }>();
    mockGetSession.mockReturnValue(bootstrap.promise);

    const states: AuthState[] = [];
    const { unmount } = render(<AuthSessionProbe onState={(s) => states.push(s)} />);
    const stateCountBeforeUnmount = states.length;

    unmount(); // a genuine, complete teardown — not a StrictMode simulation

    await act(async () => {
      bootstrap.resolve({ data: { session: fakeSession('user-a', 'sid-1') } });
      await bootstrap.promise;
    });

    // No new state report after unmount — proof the dispatch itself never happened (not merely
    // that nothing rendered it), since onState is called from the probe's own effect on every
    // commit that includes a state change.
    expect(states.length).toBe(stateCountBeforeUnmount);
  });

  it('a rejected bootstrap getSession() never dispatches and never becomes an unhandled rejection', async () => {
    mockGetSession.mockRejectedValue(new Error('network unreachable'));

    const states: AuthState[] = [];
    render(<AuthSessionProbe onState={(s) => states.push(s)} />);
    const stateCountAfterMount = states.length; // the probe's own effect reports the initial state once

    // Let the rejection actually settle (awaited here, so if the hook left it uncaught this test
    // itself would surface it as an unhandled rejection — the real regression this guards against).
    await act(async () => {
      await Promise.resolve().catch(() => {});
      await Promise.resolve();
    });

    // A failed bootstrap must never be treated as "signed out" or dispatch anything at all — no
    // *new* state report happened beyond the initial mount, and the initial state is untouched.
    expect(states.length).toBe(stateCountAfterMount);
    expect(states.at(-1)).toEqual({ session: null, sessionId: null });

    // A live event afterward still works normally — the rejected bootstrap didn't wedge anything.
    await act(async () => {
      emitAuthEvent(fakeSession('user-a', 'sid-1'));
    });
    expect(states.at(-1)?.sessionId).toBe('sid-1');
  });
});

describe('11. NavigationWriteCoordinator lifetime — survives a full harness (App-level) remount (Blocker 3)', () => {
  it('an already-in-flight A1 write and a freshly-mounted A3 harness still serialize through the same real, exported coordinator: wire order A1 -> A3', async () => {
    const fetchCall1 = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    vi.mocked(fetch).mockImplementationOnce(() => fetchCall1.promise as never).mockResolvedValueOnce(
      okResponse({ nav_layout: { tabs: [] } }) as never
    );

    const framesA1: Frame[] = [];
    const mountA1 = render(<AuthHarness frames={framesA1} coordinator={navigationWriteCoordinator} />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(mountA1.getByTestId('content')).toBeTruthy());

    act(() => {
      mountA1.getByTestId('hide-loans').click(); // A1's write is dispatched — its own fetch() is held open
    });
    await waitFor(() => expect(mountA1.getByTestId('status').textContent).toBe('saving'));
    expect(fetch).toHaveBeenCalledTimes(1);

    mountA1.unmount(); // React App/scope A is fully unmounted — a genuine, complete teardown

    // A new App/scope mounts in the same page and submits a newer A3 layout, using the *same*
    // real, exported coordinator (not a fresh instance — this is what actually proves the
    // singleton, not merely this test's own bookkeeping, is what's serializing the writes).
    const framesA3: Frame[] = [];
    const mountA3 = render(<AuthHarness frames={framesA3} coordinator={navigationWriteCoordinator} />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-3')));
    await waitFor(() => expect(mountA3.getByTestId('content')).toBeTruthy());
    act(() => {
      mountA3.getByTestId('hide-loans').click(); // queued — A1's write is still on the wire
    });

    // A3's write must not have gone out yet: still exactly the one call from A1.
    expect(fetch).toHaveBeenCalledTimes(1);

    // A1's already-issued request finally settles.
    await act(async () => {
      fetchCall1.resolve(okResponse({ nav_layout: { tabs: [] } }));
      await fetchCall1.promise;
    });

    // Only now does A3's newest layout reach the wire — the required ordering: A1 first, A3 after,
    // never concurrently, and the final (and only second) call is A3's.
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    mountA3.unmount();
  });

  it('stale A1 completion cannot report status into the newly attached A3 scope', async () => {
    const fetchCall1 = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    vi.mocked(fetch).mockImplementationOnce(() => fetchCall1.promise as never);

    const framesA1: Frame[] = [];
    const mountA1 = render(<AuthHarness frames={framesA1} coordinator={navigationWriteCoordinator} />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(mountA1.getByTestId('content')).toBeTruthy());
    act(() => mountA1.getByTestId('hide-loans').click());
    await waitFor(() => expect(mountA1.getByTestId('status').textContent).toBe('saving'));

    mountA1.unmount();

    const framesA3: Frame[] = [];
    const mountA3 = render(<AuthHarness frames={framesA3} coordinator={navigationWriteCoordinator} />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-3')));
    await waitFor(() => expect(mountA3.getByTestId('content')).toBeTruthy());
    // A3 makes no edit of its own — its status should read whatever a freshly attached scope starts as.
    const statusBeforeA1Settles = mountA3.getByTestId('status').textContent;

    await act(async () => {
      fetchCall1.resolve(okResponse({ nav_layout: { tabs: [] } })); // A1's stale request settles
      await fetchCall1.promise;
    });

    // A3's own status must be completely unaffected by A1's stale completion.
    expect(mountA3.getByTestId('status').textContent).toBe(statusBeforeA1Settles);
    mountA3.unmount();
  });

  // The two tests above both remount under a genuinely different sessionId (sid-1 -> sid-3) —
  // Codex specifically flagged that as an incomplete regression: a full harness/App-level remount
  // can happen while the very same Supabase session stays active (its sessionId unchanged), and
  // that case needs its own coverage, since sessionId alone is exactly what the previous round's
  // coordinator used to gate status/detach/retry ownership on.
  it('a full remount under the SAME session_id still gets a distinct attachment: the old attachment\'s success never reports into the new one, and wire order stays old -> new', async () => {
    const fetchCall1 = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    const fetchCall2 = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    vi.mocked(fetch)
      .mockImplementationOnce(() => fetchCall1.promise as never)
      .mockImplementationOnce(() => fetchCall2.promise as never);

    const framesOld: Frame[] = [];
    const mountOld = render(<AuthHarness frames={framesOld} coordinator={navigationWriteCoordinator} />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(mountOld.getByTestId('content')).toBeTruthy());

    act(() => {
      mountOld.getByTestId('hide-loans').click(); // old attachment's write dispatched — held open
    });
    await waitFor(() => expect(mountOld.getByTestId('status').textContent).toBe('saving'));
    expect(fetch).toHaveBeenCalledTimes(1);

    mountOld.unmount(); // a genuine, complete teardown — the underlying sid-1 session stays active

    // A new harness mounts under the exact SAME session_id — a distinct attachment.
    const framesNew: Frame[] = [];
    const mountNew = render(<AuthHarness frames={framesNew} coordinator={navigationWriteCoordinator} />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1'))); // same session_id as before
    await waitFor(() => expect(mountNew.getByTestId('content')).toBeTruthy());

    act(() => {
      mountNew.getByTestId('hide-loans').click(); // new attachment's own edit — merely queued for now:
      // the old attachment's request is still in flight, so the coordinator can't dispatch this one
      // yet (Case B) — status stays whatever it was (the hook's initial 'idle', since this
      // attachment has made no request of its own yet), not a premature 'saving'.
    });
    expect(fetch).toHaveBeenCalledTimes(1); // not sent yet — the old attachment's write is still on the wire

    // The old attachment's already-issued request finally settles successfully. This is what
    // actually lets the coordinator chase the new attachment's queued edit — which is also the
    // moment the previous, buggy coordinator would have (incorrectly) reported the OLD attachment's
    // own 'saved' into the NEW attachment, since both share the same sessionId.
    await act(async () => {
      fetchCall1.resolve(okResponse({ nav_layout: { tabs: [] } }));
      await fetchCall1.promise;
    });

    // Critical assertion — this is exactly the false-positive Codex reproduced: the OLD
    // attachment's success must not have been reported into the NEW attachment as a premature
    // 'saved'. Instead, the new attachment now (and only now) has its OWN request dispatched and
    // correctly shows ITS OWN 'saving' state — never the old attachment's completion status.
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(mountNew.getByTestId('status').textContent).toBe('saving');

    // Now the new attachment's own request settles.
    await act(async () => {
      fetchCall2.resolve(okResponse({ nav_layout: { tabs: [] } }));
      await fetchCall2.promise;
    });

    await waitFor(() => expect(mountNew.getByTestId('status').textContent).toBe('saved'));
    // Wire order: the old attachment's write first, the new attachment's second — never
    // concurrently, and exactly two calls total.
    expect(fetch).toHaveBeenCalledTimes(2);
    mountNew.unmount();
  });

  it('an old attachment\'s failure under the SAME session_id cannot surface a false Error (with a nonfunctional Retry) in the new attachment', async () => {
    const fetchCall1 = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    vi.mocked(fetch).mockImplementationOnce(() => fetchCall1.promise as never);

    const framesOld: Frame[] = [];
    const mountOld = render(<AuthHarness frames={framesOld} coordinator={navigationWriteCoordinator} />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(mountOld.getByTestId('content')).toBeTruthy());
    act(() => mountOld.getByTestId('hide-loans').click());
    await waitFor(() => expect(mountOld.getByTestId('status').textContent).toBe('saving'));

    mountOld.unmount();

    const framesNew: Frame[] = [];
    const mountNew = render(<AuthHarness frames={framesNew} coordinator={navigationWriteCoordinator} />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-1'))); // same session_id — a distinct attachment
    await waitFor(() => expect(mountNew.getByTestId('content')).toBeTruthy());
    const statusBeforeOldSettles = mountNew.getByTestId('status').textContent; // fresh attachment's starting status

    // The old attachment's already-issued request finally fails — a real authedFetch-shaped
    // failure (a non-ok response), not a mocked coordinator-level rejection, so this exercises the
    // exact production failure path.
    await act(async () => {
      fetchCall1.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'stale failure' }) });
      await fetchCall1.promise.catch(() => {});
    });
    await Promise.resolve();
    await Promise.resolve();

    // The new attachment must be completely unaffected — no false 'error', status unchanged.
    expect(mountNew.getByTestId('status').textContent).toBe(statusBeforeOldSettles);

    // And since nothing was ever incorrectly surfaced to it, Retry has nothing of its own to do —
    // clicking it sends no new request at all. There is no "false Error with a nonfunctional
    // Retry," because there is no false Error to begin with.
    act(() => mountNew.getByTestId('retry').click());
    expect(fetch).toHaveBeenCalledTimes(1); // still just the old attachment's own (now-settled) call

    mountNew.unmount();
  });
});

// ---------------------------------------------------------------------------------------------
// Authenticated preference isolation remediation — PreferencesScope (Dashboard Layout, Appearance,
// Financial Preferences incl. Safe-to-Spend, Reporting Range). Mirrors the NavLayoutScope test
// sections above in structure and intent: these four hooks used to live directly in App, which
// never unmounts across auth transitions, so each hook's one-shot `hydrated` ref only ever
// hydrated once *ever* — a later fetch for a different user, or the same user's new session, was
// silently ignored. PreferencesHarness exercises the real, exported PreferencesScope exactly the
// way AuthHarness already exercises the real, exported NavLayoutScope.
// ---------------------------------------------------------------------------------------------

describe('12. PreferencesScope — cross-lifecycle isolation (all four preference systems)', () => {
  it("A -> B without a page reload: B never renders A's dashboard layout, theme, financial preferences, or reporting range", async () => {
    const frames: PrefsFrame[] = [];
    render(<PreferencesHarness frames={frames} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await act(async () => {
      resolvePreferencesFetch!(
        fakePreferences({
          dashboard_layout: { cards: [{ id: 'stats', visible: false }] },
          theme: 'dark',
          accent_color: 'purple',
          minimum_cash_buffer: 1000,
          savings_rate_target: 40,
          safe_to_spend_include_upcoming_bills: false,
          reporting_range: 'last_12_months',
        }),
        'sid-a1'
      );
    });
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-a')).toBe(true));
    const aFrame = frames.filter((f) => f.userId === 'user-a').at(-1)!;
    expect(aFrame.theme).toBe('dark');
    expect(aFrame.range).toBe('last_12_months');
    expect(aFrame.dashboardVisibleIds).not.toContain('stats');

    // B logs in — same tab, no reload.
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences(), 'sid-b1'); // B's own defaults — nothing like A's
    });

    await waitFor(() => expect(frames.some((f) => f.userId === 'user-b')).toBe(true));
    const bFrame = frames.filter((f) => f.userId === 'user-b').at(-1)!;
    // Dashboard Layout: B does not render A's dashboard layout.
    expect(bFrame.dashboardVisibleIds).toContain('stats');
    // Appearance: B does not keep A's authenticated appearance after hydration.
    expect(bFrame.theme).toBe('system');
    expect(bFrame.accent).toBe('green');
    // Financial Preferences (incl. Safe-to-Spend): B receives B's own preferences/values.
    expect(bFrame.minimumCashBuffer).toBe(0);
    expect(bFrame.savingsRateTarget).toBe(15);
    expect(bFrame.includeUpcomingBills).toBe(true);
    // Reporting Range: B's reports use B's reporting range.
    expect(bFrame.range).toBe('last_6_months');
  });

  it("A1 -> A3 same-user relogin: A3 rehydrates from the server rather than keeping A1's in-memory state", async () => {
    const frames: PrefsFrame[] = [];
    render(<PreferencesHarness frames={frames} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences({ theme: 'light', savings_rate_target: 10, reporting_range: 'this_month' }), 'sid-a1');
    });
    await waitFor(() => expect(frames.some((f) => f.sessionId === 'sid-a1')).toBe(true));

    // A signs out, then back in as themselves — a brand-new Supabase session_id, simulating a
    // change made on another device in between (a newer savings_rate_target/range on the server).
    act(() => emitAuthEvent(null));
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a3')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences({ theme: 'dark', savings_rate_target: 25, reporting_range: 'last_12_months' }), 'sid-a3');
    });

    await waitFor(() => {
      const a3Frame = frames.filter((f) => f.sessionId === 'sid-a3').at(-1)!;
      expect(a3Frame.theme).toBe('dark');
      expect(a3Frame.savingsRateTarget).toBe(25); // Financial Preferences: A1 -> A3 gets the current server range/values
      expect(a3Frame.range).toBe('last_12_months'); // Reporting Range: A1 -> A3 gets the current server range
    });
  });

  // A stale-fetch-resolves-last scenario ("A pending -> B ready -> A settles last: B remains
  // ready") used to be tested here directly against PreferencesHarness. It has been moved to
  // App.production.test.tsx, which renders the real, default-exported `<App>` end to end: Codex
  // flagged (twice) that this harness's own `resolvePreferencesFetch`/`rejectPreferencesFetch`
  // write unconditionally, by design — gating them the same way App.tsx's real refreshAll now
  // does would just be a second, parallel implementation of the exact protection under test. See
  // App.production.test.tsx's "stale preference outcome" describe block for the real coverage.

  it('a token refresh under the same session_id does not remount or re-hydrate any of the four hooks', async () => {
    const frames: PrefsFrame[] = [];
    const { getByTestId } = render(<PreferencesHarness frames={frames} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences({ theme: 'dark', accent_color: 'green' }), 'sid-a1');
    });
    await waitFor(() => expect(frames.some((f) => f.theme === 'dark')).toBe(true));

    // A locally edits the accent — this must survive a same-session token refresh untouched. A
    // spurious remount would lose this unpersisted-yet local edit and fall back to whatever
    // useAppearance's own hydration effect re-derives from `saved` (still tagged sid-a1, still
    // 'green') — so surviving as 'blue' is a real, distinguishing signal that no remount happened.
    vi.mocked(fetch).mockResolvedValue(okResponse({ theme: 'dark', accent_color: 'blue' }) as never);
    act(() => getByTestId('set-accent-blue').click());
    await waitFor(() => expect(getByTestId('accent').textContent).toBe('blue'));

    // A token refresh: same user, same session_id (fakeSession is deterministic per (userId,
    // sessionId) pair, so calling it again with the identical pair models Supabase re-emitting
    // the same session after a refresh — the access token changes in practice, but this harness
    // doesn't need to vary the token string for sessionId comparisons to hold).
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));

    // sessionId is unchanged, so PreferencesScope never remounts, and no new hydration happens —
    // the locally-edited accent is untouched. A spurious remount would have reset it to 'green'
    // (useAppearance's hydration effect re-deriving from `saved`, still tagged sid-a1).
    expect(getByTestId('accent').textContent).toBe('blue');
  });
});

describe('13. Dashboard Layout — save ownership', () => {
  it('a toggle made under A cannot persist an A-derived layout once B is current', async () => {
    const frames: PrefsFrame[] = [];
    const { getByTestId } = render(<PreferencesHarness frames={frames} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences(), 'sid-a1');
    });
    await waitFor(() => expect(frames.some((f) => f.sessionId === 'sid-a1')).toBe(true));
    // Hydration itself already fired a read-only range-data GET (see applyRangeData) — clear it so
    // the assertion below is scoped to just this test's own save action.
    vi.mocked(fetch).mockClear();

    // A's own session lookup for this save is held open until after B becomes current.
    const lookup = deferred<{ data: { session: FakeSession | null } }>();
    mockGetSession.mockReturnValueOnce(lookup.promise);
    act(() => getByTestId('toggle-stats').click()); // A's edit — save() dispatched, awaiting getSession()

    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1'))); // B becomes current before the lookup resolves

    await act(async () => {
      lookup.resolve({ data: { session: fakeSession('user-b', 'sid-b1') } }); // the session actually returned is B's
      await lookup.promise;
    });

    expect(fetch).not.toHaveBeenCalled(); // A's edit never reached the network under B's credentials
  });
});

describe('14. Appearance — stale save completion and Retry cannot cross into a new lifecycle', () => {
  it("a stale A save success cannot update B's appearance save status", async () => {
    const frames: PrefsFrame[] = [];
    const { getByTestId } = render(<PreferencesHarness frames={frames} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences(), 'sid-a1');
    });
    await waitFor(() => expect(frames.some((f) => f.sessionId === 'sid-a1')).toBe(true));

    const fetchCall = deferred<{ ok: boolean; status: number; json: () => Promise<unknown> }>();
    vi.mocked(fetch).mockReturnValueOnce(fetchCall.promise as never);
    act(() => getByTestId('set-theme-dark').click()); // A's save dispatched, held open
    await waitFor(() => expect(getByTestId('appearance-status').textContent).toBe('saving'));

    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1'))); // B becomes current — a fresh scope mounts
    // B's own preferences haven't hydrated yet — nothing of A's (or a default) is shown as if it
    // were authoritative; per PreferencesScope's readiness gate, there is no appearance UI at all
    // yet, only the loading placeholder.
    expect(getByTestId('prefs-loading')).toBeTruthy();

    // B's own fetch resolves — a fresh scope, a fresh SaveStatusTracker, starting idle.
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences(), 'sid-b1');
    });
    await waitFor(() => expect(getByTestId('appearance-status').textContent).toBe('idle'));

    // A's stale save finally settles successfully, after B is already fully hydrated and idle.
    await act(async () => {
      fetchCall.resolve(okResponse({ theme: 'dark', accent_color: 'green' }));
      await fetchCall.promise;
    });

    // B's own (freshly mounted) appearance scope must never show a save it never made.
    expect(getByTestId('appearance-status').textContent).toBe('idle');
  });

  it("a stale A Retry cannot execute A's appearance write under B's credentials", async () => {
    const frames: PrefsFrame[] = [];
    const { getByTestId } = render(<PreferencesHarness frames={frames} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences(), 'sid-a1');
    });
    await waitFor(() => expect(frames.some((f) => f.sessionId === 'sid-a1')).toBe(true));
    vi.mocked(fetch).mockClear(); // drop A's hydration-triggered range-data GET from the count below

    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'network down' }),
    } as never);
    act(() => getByTestId('set-theme-dark').click()); // A's save fails
    await waitFor(() => expect(getByTestId('appearance-status').textContent).toBe('error'));
    expect(fetch).toHaveBeenCalledTimes(1);

    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1'))); // B logs in — a fresh scope, nothing failed yet
    expect(getByTestId('prefs-loading')).toBeTruthy(); // B's own preferences not hydrated yet

    // B's own fetch resolves — a fresh, unfailed SaveStatusTracker.
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences(), 'sid-b1');
    });
    await waitFor(() => expect(getByTestId('appearance-status').textContent).toBe('idle'));
    // B's own hydration fires its own (legitimate, unrelated) range-data GET — clear it so the
    // Retry assertion below is scoped to just the Retry click itself.
    vi.mocked(fetch).mockClear();

    // B's Retry button belongs to that brand-new SaveStatusTracker (PreferencesScope remounted) —
    // there's nothing of B's own to retry, so it must be a no-op: no new network call.
    act(() => getByTestId('appearance-retry').click());
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('15. Financial Preferences (incl. Safe-to-Spend) — the priority regression target', () => {
  it("A1 -> A3: A3 rehydrates the server's current values, and editing one field does not clobber the others back to A1's stale snapshot", async () => {
    vi.mocked(fetch).mockResolvedValue(
      okResponse({
        minimum_cash_buffer: 500,
        upcoming_bills_days: 14,
        recent_avg_months: 2,
        savings_rate_target: 25,
        safe_to_spend_include_upcoming_bills: true,
        safe_to_spend_include_remaining_budget: true,
      }) as never
    );
    const frames: PrefsFrame[] = [];
    const { getByTestId } = render(<PreferencesHarness frames={frames} />);

    // A1: hydrates with the OLD savings_rate_target (15) — the value before a change made on
    // another device.
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences({ savings_rate_target: 15 }), 'sid-a1');
    });
    await waitFor(() => expect(frames.some((f) => f.sessionId === 'sid-a1')).toBe(true));

    // A signs out, then back in as themselves (A3) — without a page reload. The server now has a
    // NEWER savings_rate_target (25), set from another device in between.
    act(() => emitAuthEvent(null));
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a3')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences({ savings_rate_target: 25, minimum_cash_buffer: 0 }), 'sid-a3');
    });

    // A3 must show the server's current value, not A1's stale one.
    await waitFor(() => expect(getByTestId('savings-rate').textContent).toBe('25'));

    // A3 edits ONE field (minimum_cash_buffer) — this must persist savings_rate_target=25 (A3's
    // own rehydrated value), never A1's stale 15, even though A1's in-memory state existed first.
    act(() => getByTestId('set-min-cash-500').click());

    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const lastCall = vi.mocked(fetch).mock.calls.at(-1)!;
    const sentBody = JSON.parse((lastCall[1] as RequestInit).body as string);
    expect(sentBody.minimum_cash_buffer).toBe(500); // the actual edit
    expect(sentBody.savings_rate_target).toBe(25); // A3's own value — never A1's stale 15
  });

  it("a stale A1 save cannot execute under A3's credentials", async () => {
    const frames: PrefsFrame[] = [];
    const { getByTestId } = render(<PreferencesHarness frames={frames} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences(), 'sid-a1');
    });
    await waitFor(() => expect(frames.some((f) => f.sessionId === 'sid-a1')).toBe(true));
    vi.mocked(fetch).mockClear(); // drop A1's hydration-triggered range-data GET from the count below

    const lookup = deferred<{ data: { session: FakeSession | null } }>();
    mockGetSession.mockReturnValueOnce(lookup.promise);
    act(() => getByTestId('set-savings-rate-25').click()); // A1's edit — awaiting its own session lookup

    act(() => emitAuthEvent(null));
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a3'))); // same user re-logs in before the lookup resolves

    await act(async () => {
      lookup.resolve({ data: { session: fakeSession('user-a', 'sid-a3') } }); // returns A3's session, not A1's
      await lookup.promise;
    });

    expect(fetch).not.toHaveBeenCalled(); // A1's edit never reached the network under A3
  });
});

describe('16. Reporting Range — save ownership', () => {
  it("a stale A range save cannot execute under B's credentials", async () => {
    const frames: PrefsFrame[] = [];
    const { getByTestId } = render(<PreferencesHarness frames={frames} />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences(), 'sid-a1');
    });
    await waitFor(() => expect(frames.some((f) => f.sessionId === 'sid-a1')).toBe(true));

    // setRange() fires two independent things, each with its own authedFetch -> getSession()
    // lookup, in this order: an immediate, read-only range-data GET (via onReportingRangeReady/
    // applyRangeData — self-protected by its own request-id, not an ownership question) and the
    // actual preference *save* PUT (session-lookup-gated). Only the PUT is this test's concern, so
    // only its lookup (the second getSession() call) is held open.
    const lookup = deferred<{ data: { session: FakeSession | null } }>();
    mockGetSession
      .mockReturnValueOnce(Promise.resolve({ data: { session: fakeSession('user-a', 'sid-a1') } })) // the GET's own lookup
      .mockReturnValueOnce(lookup.promise); // the PUT's own lookup — held open
    act(() => getByTestId('set-range-3m').click()); // A's range change — awaiting its own session lookup

    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));

    await act(async () => {
      lookup.resolve({ data: { session: fakeSession('user-b', 'sid-b1') } });
      await lookup.promise;
    });

    expect(wasPutCalledWith('/reporting-range')).toBe(false); // A's save never reached the network under B
  });
});

describe('17. PreferencesScope under StrictMode', () => {
  it('a real edit under StrictMode setup -> cleanup -> setup actually reaches persistence', async () => {
    vi.mocked(fetch).mockResolvedValue(okResponse({ theme: 'dark', accent_color: 'green' }) as never);
    const frames: PrefsFrame[] = [];
    const { getByTestId } = render(
      <StrictMode>
        <PreferencesHarness frames={frames} />
      </StrictMode>
    );

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await act(async () => {
      resolvePreferencesFetch!(fakePreferences(), 'sid-a1');
    });
    await waitFor(() => expect(frames.some((f) => f.sessionId === 'sid-a1')).toBe(true));
    vi.mocked(fetch).mockClear(); // drop hydration's own range-data GET from the count below

    act(() => getByTestId('set-theme-dark').click());

    // If StrictMode's simulated cleanup had left any of the four hooks (or their SaveStatusTracker)
    // in a broken state, this would silently never reach the network.
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(getByTestId('appearance-status').textContent).toBe('saved'));

    // Exactly one PUT reached the network for this one click — StrictMode's double-invoke must not
    // have caused a double-persist.
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// Sections 18-21 (pre-hydration structural-absence, range-dataset lifecycle/range ownership,
// simulated Plaid-link refresh, preference-failure recovery) previously lived here, built on
// PreferencesHarness. Codex flagged (twice) that this harness only reproduces part of App's real
// behavior for exactly these concerns — it mirrors, rather than reuses, App's own readiness/range-
// ownership/Retry/Plaid-link logic — so passing tests here were not sufficient evidence for those
// blockers. That coverage now lives in App.production.test.tsx, which renders the real, default-
// exported `<App>` component end to end (auth, lib/api, and react-plaid-link mocked at the
// boundary) so these specific guarantees are proven against the actual production implementation,
// not a parallel one. PreferencesHarness (above) remains for the lower-level, hook-focused
// coverage it was always suited for: A->B/A1->A3 clean hydration, token-refresh no-op, per-hook
// save ownership, stale save/Retry isolation, and StrictMode.
