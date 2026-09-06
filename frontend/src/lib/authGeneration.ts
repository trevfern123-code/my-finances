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
