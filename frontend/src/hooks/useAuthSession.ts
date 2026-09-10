import { useEffect, useReducer } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabaseClient';
import { authReducer, initialAuthState, shouldApplyAuthEvent, type AuthState } from '../lib/authGeneration';
import { decodeSessionId } from '../lib/jwt';

/**
 * Owns the one authoritative `{ session, sessionId }` pair for this tab's current authenticated
 * lifecycle — see lib/authGeneration.ts's AuthState/authReducer doc comments for what `sessionId`
 * is and why session/sessionId update atomically.
 *
 * Extracted out of App.tsx as its own hook for one reason: so the *exact* implementation App uses
 * in production is also the one App.integration.test.tsx exercises directly. An earlier review
 * round tested a hand-copied re-implementation of this effect (a `BootstrapHarness`) instead of
 * the real one — that copy could (and did) silently drift from what App.tsx actually does. There is
 * now only one place this logic exists.
 *
 * Registers `onAuthStateChange` before initiating the bootstrap `getSession()` call, so a live
 * event that fires before the bootstrap promise even resolves is never missed. `sawLiveEvent`
 * guards a real ordering hazard: the bootstrap snapshot and a live event are two independent async
 * sources, and a live event can fire *and resolve* before the slower bootstrap does even though the
 * bootstrap represents strictly older information — once any live event has been observed, a
 * later-resolving bootstrap result must never overwrite it (see shouldApplyAuthEvent).
 *
 * `active` closes a second, distinct hazard `sawLiveEvent` alone does not: a *stale effect setup's*
 * bootstrap promise resolving after that exact setup has already been cleaned up — notably React 18
 * StrictMode's dev-only setup -> cleanup -> setup double-invoke, where setup #1's bootstrap call can
 * still be outstanding when its cleanup runs (unsubscribing its own live subscription does nothing
 * to stop that unrelated Promise continuation), setup #2 then observes its own live event, and only
 * afterward does setup #1's bootstrap promise resolve. Without `active`, setup #1's now-stale
 * `applyEvent` would still fire and could dispatch stale data over setup #2's already-committed,
 * newer state — `sawLiveEvent` alone can't catch this because it's scoped per-setup: setup #1's own
 * `sawLiveEvent` is (correctly) still `false` from its own point of view. `active` is set exactly
 * once, in this setup's own cleanup, and checked as the very first thing `applyEvent` does, so a
 * cleaned-up setup's callback becomes a complete, permanent no-op — including after a genuine
 * top-level unmount, not just a StrictMode-simulated one.
 */
export function useAuthSession(): AuthState {
  const [auth, dispatchAuth] = useReducer(authReducer, initialAuthState);

  useEffect(() => {
    let active = true;
    let sawLiveEvent = false;

    function applyEvent(newSession: Session | null, isBootstrap: boolean) {
      if (!active) return;
      if (!shouldApplyAuthEvent(isBootstrap, sawLiveEvent)) return;
      if (!isBootstrap) sawLiveEvent = true;
      // Decoded synchronously (see lib/jwt.ts) — no async gap between observing an event and
      // including its session_id in the same atomic dispatch. A decode failure (should not happen
      // — session_id is a required Supabase claim — but never assumed impossible) falls back to a
      // freshly generated id, guaranteeing this is still always treated as a new lifecycle rather
      // than silently trusting a guess that it's a continuation of the previous one.
      const newSessionId = newSession ? (decodeSessionId(newSession.access_token) ?? crypto.randomUUID()) : null;
      dispatchAuth({ type: 'AUTH_EVENT', session: newSession, sessionId: newSessionId });
    }

    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      applyEvent(newSession, false);
    });
    supabase.auth.getSession().then(({ data }) => applyEvent(data.session, true));

    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, []);

  return auth;
}
