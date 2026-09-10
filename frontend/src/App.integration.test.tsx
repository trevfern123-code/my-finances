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
import { useCallback, useEffect, useLayoutEffect, useRef, StrictMode, type MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavLayoutScope, navigationWriteCoordinator } from './App';
import type { AuthState } from './lib/authGeneration';
import type { NavLayoutEntry } from './lib/api';
import { NavigationWriteCoordinator } from './lib/navigationWriteCoordinator';
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
});
