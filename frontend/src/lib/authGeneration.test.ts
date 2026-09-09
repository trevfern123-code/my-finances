import { describe, expect, it } from 'vitest';
import type { Session } from '@supabase/supabase-js';
import { authReducer, currentGenerationValue, initialAuthState, shouldApplyAuthEvent } from './authGeneration';

function fakeSession(userId: string): Session {
  return { user: { id: userId } } as Session;
}

describe('authReducer', () => {
  it('initial state is signed out with no session id', () => {
    expect(initialAuthState).toEqual({ session: null, sessionId: null });
  });

  it('adopts whatever session/sessionId a dispatched event carries', () => {
    const state = authReducer(initialAuthState, { type: 'AUTH_EVENT', session: fakeSession('user-a'), sessionId: 'sid-1' });
    expect(state.session?.user.id).toBe('user-a');
    expect(state.sessionId).toBe('sid-1');
  });

  it('a same-lifecycle token refresh (same sessionId, new session object) is adopted without any special-casing', () => {
    const signedIn = authReducer(initialAuthState, { type: 'AUTH_EVENT', session: fakeSession('user-a'), sessionId: 'sid-1' });
    const refreshedSession = { user: { id: 'user-a' }, access_token: 'new-token' } as Session;
    const refreshed = authReducer(signedIn, { type: 'AUTH_EVENT', session: refreshedSession, sessionId: 'sid-1' });
    expect(refreshed.sessionId).toBe('sid-1'); // unchanged — same lifecycle
    expect(refreshed.session).toBe(refreshedSession); // the fresh session object is still adopted
  });

  it('a same-user re-login after sign-out gets a different sessionId — never reuses the first login\'s identity', () => {
    let state = authReducer(initialAuthState, { type: 'AUTH_EVENT', session: fakeSession('user-a'), sessionId: 'sid-1' });
    expect(state.sessionId).toBe('sid-1');

    state = authReducer(state, { type: 'AUTH_EVENT', session: null, sessionId: null });
    expect(state.sessionId).toBeNull();

    // A genuinely new login for the same user gets its own, distinct sessionId — decided upstream
    // (App.tsx decodes it from the new token, or falls back to crypto.randomUUID()); the reducer
    // itself has no opinion about *which* id it is, only that it faithfully adopts it.
    state = authReducer(state, { type: 'AUTH_EVENT', session: fakeSession('user-a'), sessionId: 'sid-3' });
    expect(state.sessionId).toBe('sid-3');
    expect(state.sessionId).not.toBe('sid-1');
  });

  it('A -> B -> A: each login gets its own sessionId, including the second A login', () => {
    let state = authReducer(initialAuthState, { type: 'AUTH_EVENT', session: fakeSession('user-a'), sessionId: 'sid-1' });
    state = authReducer(state, { type: 'AUTH_EVENT', session: fakeSession('user-b'), sessionId: 'sid-2' });
    state = authReducer(state, { type: 'AUTH_EVENT', session: fakeSession('user-a'), sessionId: 'sid-3' });
    expect(state.sessionId).toBe('sid-3');
    expect(state.session?.user.id).toBe('user-a');
  });

  it('a same-user logout immediately followed by a re-login, applied as two sequential actions before either is necessarily rendered, ends at a distinct sessionId', () => {
    // Models two events dispatched back-to-back, faster than React could paint an intermediate
    // frame. React still reduces a useReducer's queued actions sequentially against the true prior
    // state even when their renders are batched into one.
    const gen1 = authReducer(initialAuthState, { type: 'AUTH_EVENT', session: fakeSession('user-a'), sessionId: 'sid-1' });
    const signedOut = authReducer(gen1, { type: 'AUTH_EVENT', session: null, sessionId: null });
    const gen3 = authReducer(signedOut, { type: 'AUTH_EVENT', session: fakeSession('user-a'), sessionId: 'sid-3' });

    expect(signedOut.sessionId).toBeNull(); // the intermediate signed-out lifecycle is never skipped
    expect(gen3.sessionId).toBe('sid-3');
    expect(gen3.sessionId).not.toBe(gen1.sessionId);
  });
});

describe('currentGenerationValue — stale-fetch guard, generic over the tag type', () => {
  it('a sid-1 fetch resolving after the lifecycle has advanced to sid-2 is rejected', () => {
    expect(currentGenerationValue(['A-data'], 'sid-1', 'sid-2')).toBeUndefined();
  });

  it('sid-1 -> sid-2 -> sid-3: an old sid-1 response is still rejected, even if sid-3 belongs to the same user as sid-1', () => {
    expect(currentGenerationValue(['A-data'], 'sid-1', 'sid-3')).toBeUndefined();
  });

  it('overlapping responses resolving out of order — only the response tagged with the current lifecycle hydrates', () => {
    expect(currentGenerationValue(['B-data'], 'sid-2', 'sid-2')).toEqual(['B-data']);
    expect(currentGenerationValue(['A-data'], 'sid-1', 'sid-2')).toBeUndefined();
  });

  it('only a response tagged with the exact current sessionId may hydrate', () => {
    expect(currentGenerationValue('x', 'sid-5', 'sid-5')).toBe('x');
    expect(currentGenerationValue('x', 'sid-4', 'sid-5')).toBeUndefined();
  });

  it('a value never tagged at all (nothing fetched yet) is rejected', () => {
    expect(currentGenerationValue('x', undefined, 'sid-5')).toBeUndefined();
  });

  it('a legitimate null (fetched successfully, nothing saved) still passes through when tagged with the current sessionId', () => {
    expect(currentGenerationValue(null, 'sid-5', 'sid-5')).toBeNull();
  });

  it('still works with numeric tags (generic, not sessionId-specific)', () => {
    expect(currentGenerationValue('x', 3, 3)).toBe('x');
    expect(currentGenerationValue('x', 2, 3)).toBeUndefined();
  });
});

describe('shouldApplyAuthEvent', () => {
  it('always applies a live (non-bootstrap) event', () => {
    expect(shouldApplyAuthEvent(false, false)).toBe(true);
    expect(shouldApplyAuthEvent(false, true)).toBe(true);
  });

  it('applies the bootstrap event if no live event has been seen yet', () => {
    expect(shouldApplyAuthEvent(true, false)).toBe(true);
  });

  it('rejects the bootstrap event once a live event has already been observed', () => {
    expect(shouldApplyAuthEvent(true, true)).toBe(false);
  });
});
