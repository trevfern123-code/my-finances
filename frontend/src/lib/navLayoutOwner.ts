import { DEFAULT_NAV_LAYOUT, mergeNavLayout, type NavTabEntry } from './navLayout';
import type { SaveStatus } from './saveStatus';

/**
 * The full state a single authenticated user's navigation layout needs, bundled together
 * specifically so an identity change resets it as one atomic, testable value rather than several
 * independent pieces of React state that could in principle update out of step with each other.
 *
 * `ownerId` is `undefined` only before any identity has ever been established (the very first
 * render, before the app's own session check resolves) — afterward it's always either the real
 * authenticated user id this state belongs to, or `null` for "no one is signed in."
 */
export interface NavLayoutOwnerState {
  ownerId: string | null | undefined;
  hydratedForOwner: boolean;
  layout: NavTabEntry[];
  status: SaveStatus;
}

export const INITIAL_NAV_LAYOUT_OWNER_STATE: NavLayoutOwnerState = {
  ownerId: undefined,
  hydratedForOwner: false,
  layout: DEFAULT_NAV_LAYOUT,
  status: 'idle',
};

/**
 * Pure decision: has `userId` diverged from whichever identity `state` currently belongs to? If
 * so, returns a brand-new, fully-reset state for the new identity — including a sign-out
 * (`userId` becoming `null`), or switching back to a *previously seen* identity, which still
 * starts over unhydrated rather than reusing whatever that identity's layout happened to be last
 * time — a fresh default layout, idle status, not yet hydrated. If nothing changed, returns the
 * exact same `state` reference (so a caller can cheaply detect "did anything change" via `!==`,
 * and — critically — knows to dispose whatever sync/network lifecycle belonged to the previous
 * owner exactly when this returns a new object, never otherwise).
 */
export function resetForOwnerChange(state: NavLayoutOwnerState, userId: string | null): NavLayoutOwnerState {
  if (state.ownerId === userId) return state;
  return { ownerId: userId, hydratedForOwner: false, layout: DEFAULT_NAV_LAYOUT, status: 'idle' };
}

/**
 * Pure decision: given a freshly-arrived `saved` value (this identity's own fetched nav_layout),
 * should it hydrate `state`'s layout, and if so what does the hydrated state look like? Returns
 * `state` unchanged (bails) if:
 *  - already hydrated for the current owner (so a later refetch of the *same* user's data never
 *    clobbers local unsaved edits), or
 *  - `saved` hasn't arrived yet (`undefined` — the caller's own fetch is still in flight), or
 *  - there is no authenticated owner at all (`userId` is `null` — nothing to hydrate into), or
 *  - `userId` no longer matches `state.ownerId` — this is what makes a stale preference response,
 *    fetched for an identity that has since been superseded, unable to ever hydrate a *different*
 *    identity's state, even if it somehow still reached this function.
 */
export function hydrateIfNeeded(
  state: NavLayoutOwnerState,
  userId: string | null,
  saved: { id: string; visible: boolean }[] | null | undefined
): NavLayoutOwnerState {
  if (state.hydratedForOwner || saved === undefined || !userId || state.ownerId !== userId) {
    return state;
  }
  return { ...state, hydratedForOwner: true, layout: mergeNavLayout(saved) };
}
