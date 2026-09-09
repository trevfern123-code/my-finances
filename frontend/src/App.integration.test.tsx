// @vitest-environment jsdom
//
// Narrow React integration harness targeting exactly the authenticated-lifecycle boundary Codex
// found bugs at across multiple review rounds — bugs pure-function tests structurally cannot
// catch (whether a component actually remounts, whether StrictMode's setup/cleanup/setup leaves a
// usable instance, whether two auth events dispatched back-to-back before a paint are still
// reduced sequentially). Scoped to this one boundary; the rest of this project's ~250 tests stay
// framework-agnostic and un-mocked, matching its existing convention.
//
// AuthHarness below is test-local glue, not a parallel production architecture: it composes the
// *real* authReducer and the *real*, exported NavLayoutScope exactly the way App.tsx itself wires
// them (useReducer -> key={generation} -> NavLayoutScope), without needing App's other ~30
// unrelated state variables and 13 data-fetch calls just to reach this one boundary.
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { useCallback, useLayoutEffect, useReducer, useRef, StrictMode, type MutableRefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NavLayoutScope } from './App';
import { authReducer, initialAuthState } from './lib/authGeneration';
import type { NavLayoutEntry } from './lib/api';
import { NavLayoutSync } from './lib/navLayoutSync';

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('./lib/supabaseClient', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

interface FakeSession {
  user: { id: string };
  access_token: string;
}

function fakeSession(userId: string, accessToken = `${userId}-token`): FakeSession {
  return { user: { id: userId }, access_token: accessToken };
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

type Frame = { userId: string | null; authGeneration: number };
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
  // Mirrors App.tsx's own authGenerationRef/isGenerationCurrent exactly — updated in
  // useLayoutEffect, never during render, for the same commit-safety reason.
  const authGenerationRef = useRef(auth.generation);
  useLayoutEffect(() => {
    authGenerationRef.current = auth.generation;
  }, [auth.generation]);
  const isGenerationCurrent = useCallback((g: number) => authGenerationRef.current === g, []);

  dispatchRef.current = (session) => dispatchAuth({ type: 'AUTH_EVENT', session: session as never });

  return (
    <NavLayoutScope
      key={auth.generation}
      userId={userId}
      authGeneration={auth.generation}
      isGenerationCurrent={isGenerationCurrent}
      saved={saved}
    >
      {(navLayout) => {
        frames.push({ userId, authGeneration: auth.generation });
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
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

describe('1. an A -> B transition never commits userId=B with A\'s generation/key', () => {
  it('no recorded frame ever pairs a new user id with the previous generation', async () => {
    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    render(<AuthHarness dispatchRef={dispatchRef} frames={frames} />);

    act(() => dispatchRef.current!(fakeSession('user-a')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-a')).toBe(true));
    const aGeneration = frames.find((f) => f.userId === 'user-a')!.authGeneration;

    act(() => dispatchRef.current!(fakeSession('user-b')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-b')).toBe(true));

    const badFrame = frames.find((f) => f.userId === 'user-b' && f.authGeneration === aGeneration);
    expect(badFrame).toBeUndefined();
  });
});

describe('2. NavLayoutScope remains mounted through an ordinary loading cycle', () => {
  it('an ordinary loading toggle never disposes the Navigation sync', async () => {
    const disposeSpy = vi.spyOn(NavLayoutSync.prototype, 'dispose');
    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { rerender } = render(<AuthHarness dispatchRef={dispatchRef} frames={frames} loading={false} />);

    act(() => dispatchRef.current!(fakeSession('user-a')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-a')).toBe(true));
    disposeSpy.mockClear(); // ignore any StrictMode-unrelated setup noise before this point

    rerender(<AuthHarness dispatchRef={dispatchRef} frames={frames} loading={true} />);
    rerender(<AuthHarness dispatchRef={dispatchRef} frames={frames} loading={false} />);

    expect(disposeSpy).not.toHaveBeenCalled();
  });
});

describe('3. pending Navigation persistence is not discarded by a normal refresh', () => {
  it('an in-flight save (and its status) survives a loading cycle and still completes afterward', async () => {
    const sessionLookup = deferred<{ data: { session: FakeSession } }>();
    mockGetSession.mockReturnValue(sessionLookup.promise);
    vi.mocked(fetch).mockResolvedValue(okResponse({ nav_layout: { tabs: [] } }) as never);

    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId, rerender } = render(
      <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: true }]} />
    );

    act(() => dispatchRef.current!(fakeSession('user-a')));
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

    await act(async () => {
      sessionLookup.resolve({ data: { session: fakeSession('user-a') } });
      await sessionLookup.promise;
    });
    await waitFor(() => expect(getByTestId('status').textContent).toBe('saved'));
  });
});

describe('4. StrictMode setup -> cleanup -> setup leaves a usable, live NavLayoutSync', () => {
  it('a real Hide action under StrictMode actually reaches persistence', async () => {
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a') } });
    vi.mocked(fetch).mockResolvedValue(okResponse({ nav_layout: { tabs: [] } }) as never);

    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId } = render(
      <StrictMode>
        <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: true }]} />
      </StrictMode>
    );

    act(() => dispatchRef.current!(fakeSession('user-a')));
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => {
      getByTestId('hide-loans').click();
    });

    // If StrictMode's simulated cleanup had permanently disposed the sync without a real setup
    // rebuilding it, this would silently never leave 'idle' and fetch() would never be called.
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await waitFor(() => expect(getByTestId('status').textContent).toBe('saved'));
  });
});

describe('5. a generation-1 save is rejected once the committed generation is 3, even with the same user id', () => {
  it('never reaches fetch() once superseded, and the sync surfaces an error', async () => {
    const sessionLookup = deferred<{ data: { session: FakeSession } }>();
    mockGetSession.mockReturnValue(sessionLookup.promise);

    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId } = render(
      <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: true }]} />
    );

    act(() => dispatchRef.current!(fakeSession('user-a'))); // generation 1
    await waitFor(() => expect(getByTestId('content')).toBeTruthy());

    act(() => {
      getByTestId('hide-loans').click(); // dispatched under generation 1, session lookup now pending
    });
    await waitFor(() => expect(getByTestId('status').textContent).toBe('saving'));

    // Advance to generation 3 (A -> signed out -> A again) while the lookup is still in flight.
    act(() => dispatchRef.current!(null));
    act(() => dispatchRef.current!(fakeSession('user-a')));

    // The lookup for the generation-1 request finally resolves — with the *same user*, 'user-a' —
    // after generation has moved on.
    await act(async () => {
      sessionLookup.resolve({ data: { session: fakeSession('user-a') } });
      await sessionLookup.promise.catch(() => {});
    });

    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('6. sign out then back into the same account gives a fresh Navigation lifecycle and rehydrates that lifecycle\'s data', () => {
  it('the second login\'s own saved layout is what renders, not the first session\'s', async () => {
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a') } });

    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    const { getByTestId, rerender } = render(
      <AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'loans', visible: false }]} />
    );

    act(() => dispatchRef.current!(fakeSession('user-a')));
    await waitFor(() => {
      const layout = JSON.parse(getByTestId('layout').textContent!);
      expect(layout.find((t: { id: string }) => t.id === 'loans').visible).toBe(false);
    });

    act(() => dispatchRef.current!(null)); // sign out

    // Second login as the same user, with genuinely different saved data.
    rerender(<AuthHarness dispatchRef={dispatchRef} frames={frames} saved={[{ id: 'budget', visible: false }]} />);
    act(() => dispatchRef.current!(fakeSession('user-a')));

    await waitFor(() => {
      const layout = JSON.parse(getByTestId('layout').textContent!);
      expect(layout.find((t: { id: string }) => t.id === 'budget').visible).toBe(false);
      expect(layout.find((t: { id: string }) => t.id === 'loans').visible).toBe(true); // not the first session's hide
    });
  });
});

describe('7. back-to-back batched SIGNED_OUT -> SIGNED_IN for the same user produces a new generation', () => {
  it('processes both actions sequentially even when delivered before React paints an intermediate frame', async () => {
    const dispatchRef: MutableRefObject<Dispatch | null> = { current: null };
    const frames: Frame[] = [];
    render(<AuthHarness dispatchRef={dispatchRef} frames={frames} />);

    act(() => dispatchRef.current!(fakeSession('user-a')));
    await waitFor(() => expect(frames.some((f) => f.userId === 'user-a')).toBe(true));
    const firstGeneration = frames.filter((f) => f.userId === 'user-a').at(-1)!.authGeneration;

    // Both dispatches happen inside the SAME act() — modeling events delivered back-to-back,
    // faster than React could paint an intermediate signed-out frame.
    act(() => {
      dispatchRef.current!(null);
      dispatchRef.current!(fakeSession('user-a'));
    });

    await waitFor(() => {
      const last = frames.filter((f) => f.userId === 'user-a').at(-1)!;
      expect(last.authGeneration).not.toBe(firstGeneration);
      expect(last.authGeneration).toBe(firstGeneration + 2); // signed-out bump + re-sign-in bump, both counted
    });
  });
});
