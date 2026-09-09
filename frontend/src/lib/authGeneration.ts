import type { Session } from '@supabase/supabase-js';

/**
 * One clear identity for "which authenticated lifecycle is currently active" — an integer that
 * changes across every relevant auth ownership transition: signed-out -> a user, a user -> signed-
 * out, one user -> a different user, and — critically — a user signing back in as themselves after
 * an intervening sign-out. Two login sessions by the same person are never treated as the same
 * generation merely because their `user.id` values match; only an unbroken, continuous session
 * (e.g. a background token refresh, which never changes `userId`) keeps the same generation.
 *
 * This is deliberately a plain, client-side bookkeeping number — it has no meaning to the backend,
 * which only ever knows about `user.id` via the bearer token. Its entire job is letting the
 * frontend tell "data fetched under an earlier login" apart from "data fetched under the current
 * one," even when both logins belong to the same real person.
 */

/** Pure decision: does a transition from `previousUserId` to `userId` represent a new auth
 *  generation? True for every actual change — including a change to/from `null` (signed out) and a
 *  change between two different real ids. False only when `userId` is unchanged (e.g. a session/
 *  token refresh for the same continuous login, which never alters `userId`). */
export function isNewAuthGeneration(previousUserId: string | null, userId: string | null): boolean {
  return previousUserId !== userId;
}

/** Pure reducer: the next generation number given the current one and an observed user-id
 *  transition. Bumps by exactly one on a genuine transition; otherwise returns `currentGeneration`
 *  unchanged. */
export function nextAuthGeneration(
  currentGeneration: number,
  previousUserId: string | null,
  userId: string | null
): number {
  return isNewAuthGeneration(previousUserId, userId) ? currentGeneration + 1 : currentGeneration;
}

/**
 * Pure decision: is `value` (tagged with the generation it was fetched under, `valueGeneration`)
 * usable right now, given the actual `currentGeneration`? Returns `value` only when the tag
 * exactly matches; otherwise returns `undefined` — "not yet fetched for the current authenticated
 * lifecycle," never the stale holdover. This is what lets a raw fetch result carry enough
 * ownership information to prove it belongs to the current generation (rather than merely the
 * current user id), and is evaluated fresh on every render, so it needs no effect-ordering
 * guarantees to stay correct — see App.tsx's own use of this for navLayoutRaw.
 */
export function currentGenerationValue<T>(
  value: T,
  valueGeneration: number | undefined,
  currentGeneration: number
): T | undefined {
  return valueGeneration === currentGeneration ? value : undefined;
}

/**
 * `{ session, generation }` as one atomic unit, updated by a single reducer — the whole point
 * being that a genuine identity transition can never be observed as a committed render where one
 * has updated and the other hasn't. Previously `session` (a useState, set synchronously inside the
 * Supabase auth callback) and `generation` (bumped afterward, in a separate effect reacting to the
 * derived user id) were two independent pieces of state; there necessarily existed one committed
 * render where `userId` already reflected a new sign-in while `generation` — and therefore
 * NavLayoutScope's key — still reflected the old one. A `useReducer` makes both fields the output
 * of one state transition, which React can never apply partially.
 */
export interface AuthState {
  session: Session | null;
  generation: number;
}

export const initialAuthState: AuthState = { session: null, generation: 0 };

/** The only action this reducer handles: "here is whatever Supabase just told us the session is,"
 *  whether from the initial `getSession()` call or a later `onAuthStateChange` event (SIGNED_IN,
 *  SIGNED_OUT, TOKEN_REFRESHED, or a benign re-emission of the currently active session). The
 *  reducer — not the caller — decides whether this represents a new generation. */
export type AuthAction = { type: 'AUTH_EVENT'; session: Session | null };

/** Pure reducer. Each call processes exactly one AUTH_EVENT against whatever state came before it
 *  — including when two events are dispatched back-to-back before React has a chance to render in
 *  between (e.g. a same-user logout immediately followed by a re-login): React still applies
 *  reducer actions to a `useReducer` sequentially, each computed from the true previous state, even
 *  when their resulting renders are batched into one — so a `SIGNED_OUT` action processed between
 *  two `SIGNED_IN` actions for the same user still produces two distinct generation bumps, never
 *  one, regardless of whether an intermediate render for the signed-out state ever paints. */
export function authReducer(state: AuthState, action: AuthAction): AuthState {
  const previousUserId = state.session?.user.id ?? null;
  const userId = action.session?.user.id ?? null;
  return {
    session: action.session,
    generation: nextAuthGeneration(state.generation, previousUserId, userId),
  };
}
