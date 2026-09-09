import type { Session } from '@supabase/supabase-js';

/**
 * `{ session, sessionId }` as one atomic unit, updated by a single reducer — the whole point being
 * that a genuine identity transition can never be observed as a committed render where one has
 * updated and the other hasn't. `sessionId` is Supabase's own `session_id` JWT claim (see
 * lib/jwt.ts's decodeSessionId), not a client-side reconstruction: it identifies one continuous
 * login lifecycle — stable across that login's own token refreshes, but distinct for every actual
 * sign-in, including a user signing back in as themselves after signing out. Two logins by the
 * same real person are never treated as the same lifecycle merely because their `user.id` values
 * match.
 *
 * This is deliberately the authoritative identifier, not a client-side bookkeeping counter — see
 * the design history in this file's git blame for why an earlier `userId`-diffing approach
 * (`nextAuthGeneration`, now removed) could not correctly distinguish "the same user, signed back
 * in" from "still the original login."
 */
export interface AuthState {
  session: Session | null;
  sessionId: string | null;
}

export const initialAuthState: AuthState = { session: null, sessionId: null };

/** The only action this reducer handles: "here is whatever Supabase just told us the session is,
 *  and its already-decoded session_id," whether from the initial `getSession()` call or a later
 *  `onAuthStateChange` event (SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, or a benign re-emission of
 *  the currently active session). `sessionId` is decoded by the caller (see App.tsx) before
 *  dispatching — decoding is synchronous, so there's no async gap between observing an event and
 *  including its session_id in the same atomic transition. */
export type AuthAction = { type: 'AUTH_EVENT'; session: Session | null; sessionId: string | null };

/** Pure reducer — a straight adoption of whatever the action carries. Unlike the generation-
 *  counter version this replaced, there's no "is this new" decision to make here at all: since
 *  `sessionId` already *is* Supabase's own authoritative lifecycle identity, simply adopting
 *  whatever value it carries on every event is correct by construction — a same-lifecycle token
 *  refresh naturally carries the same sessionId (so nothing that reads it sees a change), and a
 *  genuine new login naturally carries a different one. The reducer's real job — preserved from
 *  the previous design — is purely the atomicity guarantee: `session` and `sessionId` update in
 *  one state transition, so a committed render can never observe one updated and not the other,
 *  even when two events (e.g. a same-user sign-out immediately followed by a re-login) are
 *  dispatched back-to-back before React has a chance to paint an intermediate frame — React still
 *  applies a useReducer's queued actions sequentially against the true prior state before
 *  rendering the batched result. */
export function authReducer(state: AuthState, action: AuthAction): AuthState {
  return { session: action.session, sessionId: action.sessionId };
}

/**
 * Pure decision: is `value` (tagged with the lifecycle identity it was fetched under,
 * `valueGeneration`) usable right now, given the actual `currentGeneration`? Returns `value` only
 * when the tag exactly matches; otherwise returns `undefined` — "not yet fetched for the current
 * authenticated lifecycle," never the stale holdover. Generic over the tag type (`G`) so the same
 * logic works whether the identity is Supabase's `sessionId` string (the current use — see
 * App.tsx's navLayoutRawSessionId) or any other comparable tag; nothing about the comparison
 * itself is specific to numbers. Evaluated fresh on every render, so it needs no effect-ordering
 * guarantees to stay correct.
 */
export function currentGenerationValue<T, G>(value: T, valueGeneration: G | undefined, currentGeneration: G): T | undefined {
  return valueGeneration === currentGeneration ? value : undefined;
}

/**
 * Pure decision: should an observed auth event actually be applied? `isBootstrap` marks the
 * initial `getSession()` snapshot taken at page load; `sawLiveEvent` records whether any
 * `onAuthStateChange` event has been observed yet, from any point since. A live event is always a
 * pushed notification of something that happened *after* the bootstrap snapshot was taken — so
 * once one has arrived, the bootstrap result represents strictly older information and must never
 * override it, no matter which of the two promises/callbacks happens to settle later. This is what
 * guards against a slow `getSession()` call resolving after a faster live sign-in/sign-out event
 * and incorrectly reverting the committed auth state back to stale bootstrap data.
 */
export function shouldApplyAuthEvent(isBootstrap: boolean, sawLiveEvent: boolean): boolean {
  return !(isBootstrap && sawLiveEvent);
}
