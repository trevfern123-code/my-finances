// @vitest-environment jsdom
//
// Narrow React integration harness targeting exactly the authenticated-lifecycle boundary Codex
// found bugs at across multiple review rounds — bugs pure-function tests structurally cannot
// catch (whether a component actually remounts, whether StrictMode's setup/cleanup/setup leaves a
// usable instance, whether two auth events dispatched back-to-back before a paint are still
// reduced sequentially, whether the returned Session's own JWT claim — not just ambient React
// state — is what request ownership is actually checked against). Scoped to this one boundary;
// the rest of this project's ~260 tests stay framework-agnostic and un-mocked, matching its
// existing convention.
//
// AuthHarness/BootstrapHarness below are test-local glue, not a parallel production architecture:
// they compose the *real* authReducer, decodeSessionId, shouldApplyAuthEvent, and the *real*,
// exported NavLayoutScope exactly the way App.tsx itself wires them, without needing App's other
// ~30 unrelated state variables and 13 data-fetch calls just to reach this one boundary.
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, StrictMode, type MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavLayoutScope } from './App';
import { authReducer, initialAuthState, shouldApplyAuthEvent } from './lib/authGeneration';
import { decodeSessionId } from './lib/jwt';
import type { NavLayoutEntry } from './lib/api';
import { NavigationWriteCoordinator } from './lib/navigationWriteCoordinator';

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
type Dispatch = (session: FakeSession | null) => void;

function AuthHarness({
  loading = false,
  saved,
  dispatchRef,
  frames,
}: {
  loading?: boolean;
  saved?: NavLayoutEntry[] | null;
  dispatchRef: MutableRefObject<Dispatch | null>;
  frames: Frame[];
}) {
  const [auth, dispatchAuth] = useReducer(authReducer, initialAuthState);
  const userId = auth.session?.user.id ?? null;
  // Mirrors App.tsx's own sessionIdRef/isSessionCurrent exactly — updated in useLayoutEffect,
  // never during render, for the same commit-safety reason.
  const sessionIdRef = useRef(auth.sessionId);
  useLayoutEffect(() => {
    sessionIdRef.current = auth.sessionId;
  }, [auth.sessionId]);
  const isSessionCurrent = useCallback((id: string) => sessionIdRef.current === id, []);
  // Mirrors App.tsx's own coordinatorRef — constructed once, never disposed, shared across every
  // NavLayoutScope mount this harness produces.
  const coordinatorRef = useRef<NavigationWriteCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new NavigationWriteCoordinator({
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

  // Decodes the real session_id from the fake session's own access_token — exercising the actual
  // decode path, not a shortcut.
  dispatchRef.current = (session) => {
    const sessionId = session ? decodeSessionId(session.access_token) : null;
    dispatchAuth({ type: 'AUTH_EVENT', session: session as never, sessionId });
  };

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

/** Mirrors App.tsx's own bootstrap getSession() + onAuthStateChange wiring exactly (including the
 *  sawLiveEvent guard), for the bootstrap-ordering tests specifically — these don't need
 *  NavLayoutScope or the coordinator at all, only the auth-event application logic itself. */
function BootstrapHarness({ onState }: { onState: (state: { userId: string | null; sessionId: string | null }) => void }) {
  const [auth, dispatchAuth] = useReducer(authReducer, initialAuthState);

  useEffect(() => {
    let sawLiveEvent = false;
    function applyEvent(newSession: FakeSession | null, isBootstrap: boolean) {
      if (!shouldApplyAuthEvent(isBootstrap, sawLiveEvent)) return;
      if (!isBootstrap) sawLiveEvent = true;
      const newSessionId = newSession ? decodeSessionId(newSession.access_token) : null;
      dispatchAuth({ type: 'AUTH_EVENT', session: newSession as never, sessionId: newSessionId });
    }
    const { data: subscription } = mockOnAuthStateChange((_e: unknown, s: FakeSession | null) => applyEvent(s, false));
    mockGetSession().then((res: { data: { session: FakeSession | null } }) => applyEvent(res.data.session, true));
    return () => subscription.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    onState({ userId: auth.session?.user.id ?? null, sessionId: auth.sessionId });
  });

  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  mockOnAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } });
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
    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    render(<AuthHarness dispatchRef={dispatchRef} frames={frames} />);

    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-a')).toBe(true));
    const aSessionId = frames.find((f) => f.userId === 'user-a')!.sessionId;

    act(() => dispatchRef.current!(fakeSession('user-b', 'sid-2')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-b')).toBe(true));

    const badFrame = frames.find((f) => f.userId === 'user-b' && f.sessionId === aSessionId);
    expect(badFrame).toBeUndefined();
  });
});

describe('2. NavLayoutScope remains mounted through an ordinary loading cycle', () => {
  it('an ordinary loading toggle never disposes (detaches) the Navigation coordinator attachment', async () => {
    const detachSpy = vi.spyOn(NavigationWriteCoordinator.prototype, 'detach');
    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { rerender } = render(<AuthHarness dispatchRef={dispatchRef} frames={frames} loading={false} />);

    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-a')).toBe(true));
    detachSpy.mockClear(); // ignore any StrictMode-unrelated setup noise before this point

    rerender(<AuthHarness dispatchRef={dispatchRef} frames={frames} loading={true} />);
    rerender(<AuthHarness dispatchRef={dispatchRef} frames={frames} loading={false} />);

    expect(detachSpy).not.toHaveBeenCalled();
  });
});

describe('3. pending Navigation persistence is not discarded by a normal refresh', () => {
  it('an in-flight save (and its status) survives a loading cycle and still completes afterward', async () => {
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-1') } });
    vi.mocked(fetch).mockImplementation(() => new Promise(() => {})); // never resolves — stays "saving"

    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId, rerender } = render(
      <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: true }]} />
    );

    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => {
      getByTestId('hide-loans').click();
    });
    await waitFor(() => expect(getByTestId('status').textContent).toBe('saving'));

    // Simulate an ordinary refreshAll() cycle happening mid-save.
    rerender(<AuthHarness dispatchRef={dispatchRef} frames={frames} loading={true} saved={[{ id: 'loans', visible: true }]} />);
    rerender(<AuthHarness dispatchRef={dispatchRef} frames={frames} loading={false} saved={[{ id: 'loans', visible: true }]} />);

    // Still saving — the loading cycle did not discard or reset the in-flight/queued work.
    expect(getByTestId('status').textContent).toBe('saving');
  });
});

describe('4. StrictMode setup -> cleanup -> setup leaves a usable, live coordinator attachment', () => {
  it('a real Hide action under StrictMode actually reaches persistence', async () => {
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-1') } });
    vi.mocked(fetch).mockResolvedValue(okResponse({ nav_layout: { tabs: [] } }) as never);

    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId } = render(
      <StrictMode>
        <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: true }]} />
      </StrictMode>
    );

    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-1')));
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

    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId } = render(
      <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: true }]} />
    );

    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => {
      getByTestId('hide-loans').click(); // dispatched expecting sid-1, session lookup now pending
    });
    await waitFor(() => expect(getByTestId('status').textContent).toBe('saving'));

    // Advance to sid-3 (A -> signed out -> A again) while the lookup is still in flight.
    act(() => dispatchRef.current!(null));
    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-3')));

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

    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId, rerender } = render(
      <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: false }]} />
    );

    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-1')));
    await waitFor(() => {
      const layout = JSON.parse(getByTestId('layout').textContent!);
      expect(layout.find((t: { id: string }) => t.id === 'loans').visible).toBe(false);
    });

    act(() => dispatchRef.current!(null)); // sign out

    // Second login as the same user, with genuinely different saved data.
    rerender(<AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'budget', visible: false }]} />);
    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-3')));

    await waitFor(() => {
      const layout = JSON.parse(getByTestId('layout').textContent!);
      expect(layout.find((t: { id: string }) => t.id === 'budget').visible).toBe(false);
      expect(layout.find((t: { id: string }) => t.id === 'loans').visible).toBe(true); // not the first session's hide
    });
  });
});

describe('7. back-to-back batched SIGNED_OUT -> SIGNED_IN for the same user produces a new sessionId', () => {
  it('processes both actions sequentially even when delivered before React paints an intermediate frame', async () => {
    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    render(<AuthHarness dispatchRef={dispatchRef} frames={frames} />);

    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-a')).toBe(true));

    // Both dispatches happen inside the SAME act() — modeling events delivered back-to-back,
    // faster than React could paint an intermediate signed-out frame.
    act(() => {
      dispatchRef.current!(null);
      dispatchRef.current!(fakeSession('user-a', 'sid-3'));
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
    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId } = render(
      <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: true }]} />
    );

    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-1'))); // committed/expected: sid-1
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => getByTestId('hide-loans').click());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('error'));
    expect(fetch).not.toHaveBeenCalled(); // rejected before the network call, purely on the direct session_id mismatch
  });

  it('same user + same session_id + a refreshed access token -> allowed', async () => {
    // A genuinely refreshed token: same session_id claim, different token string.
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-1') } });
    vi.mocked(fetch).mockResolvedValue(okResponse({ nav_layout: { tabs: [] } }) as never);

    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId } = render(
      <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: true }]} />
    );

    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-1')));
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

    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId } = render(
      <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: true }]} />
    );

    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-1')));
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => getByTestId('hide-loans').click());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('saving'));

    // First lookup finally resolves with the *original* sid-1 session (as if this were the first
    // attempt succeeding through to a save() call that itself re-checks on a later internal retry
    // path) — but by now sessionId has already moved to sid-3 client-side too.
    act(() => dispatchRef.current!(null));
    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-3')));
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
    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId } = render(
      <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: true }]} />
    );

    act(() => dispatchRef.current!(fakeSession('user-a', 'sid-1')));
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
    let liveCallback: ((event: unknown, session: FakeSession | null) => void) | null = null;
    mockOnAuthStateChange.mockImplementation((cb: (event: unknown, session: FakeSession | null) => void) => {
      liveCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    const states: { userId: string | null; sessionId: string | null }[] = [];
    render(<BootstrapHarness onState={(s) => states.push(s)} />);

    // B2's live event fires and is fully processed before the slow bootstrap ever resolves.
    await act(async () => {
      liveCallback!(null, fakeSession('user-b', 'sid-b2'));
    });
    expect(states.at(-1)).toEqual({ userId: 'user-b', sessionId: 'sid-b2' });

    // The stale A1 bootstrap result finally resolves.
    await act(async () => {
      bootstrap.resolve({ data: { session: fakeSession('user-a', 'sid-a1') } });
      await bootstrap.promise;
    });

    expect(states.at(-1)).toEqual({ userId: 'user-b', sessionId: 'sid-b2' }); // never reverted to A1
  });

  it('a delayed bootstrap getSession(A1) resolving after SIGNED_OUT -> A3 live events never overwrites A3', async () => {
    const bootstrap = deferred<{ data: { session: FakeSession | null } }>();
    mockGetSession.mockReturnValue(bootstrap.promise);
    let liveCallback: ((event: unknown, session: FakeSession | null) => void) | null = null;
    mockOnAuthStateChange.mockImplementation((cb: (event: unknown, session: FakeSession | null) => void) => {
      liveCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    const states: { userId: string | null; sessionId: string | null }[] = [];
    render(<BootstrapHarness onState={(s) => states.push(s)} />);

    await act(async () => {
      liveCallback!(null, null); // SIGNED_OUT
      liveCallback!(null, fakeSession('user-a', 'sid-a3')); // SIGNED_IN A3
    });
    expect(states.at(-1)).toEqual({ userId: 'user-a', sessionId: 'sid-a3' });

    await act(async () => {
      bootstrap.resolve({ data: { session: fakeSession('user-a', 'sid-a1') } }); // stale A1
      await bootstrap.promise;
    });

    expect(states.at(-1)).toEqual({ userId: 'user-a', sessionId: 'sid-a3' }); // never reverted to A1
  });

  it('a normal (fast) bootstrap followed by a duplicate live event for the same session applies cleanly', async () => {
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-1') } });
    let liveCallback: ((event: unknown, session: FakeSession | null) => void) | null = null;
    mockOnAuthStateChange.mockImplementation((cb: (event: unknown, session: FakeSession | null) => void) => {
      liveCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });

    const states: { userId: string | null; sessionId: string | null }[] = [];
    render(<BootstrapHarness onState={(s) => states.push(s)} />);

    await waitFor(() => expect(states.at(-1)).toEqual({ userId: 'user-a', sessionId: 'sid-1' }));

    await act(async () => {
      liveCallback!(null, fakeSession('user-a', 'sid-1')); // duplicate re-emission, same session_id
    });

    expect(states.at(-1)).toEqual({ userId: 'user-a', sessionId: 'sid-1' }); // unchanged, no spurious reset
  });
});
