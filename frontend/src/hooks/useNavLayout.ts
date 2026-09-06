import { useEffect, useRef, useState } from 'react';
import { updateNavLayout, type NavLayoutEntry } from '../lib/api';
import { DEFAULT_NAV_LAYOUT, moveTab as moveTabInLayout, toggleTabVisibility as toggleTabVisibilityInLayout } from '../lib/navLayout';
import {
  hydrateIfNeeded,
  resetForOwnerChange,
  INITIAL_NAV_LAYOUT_OWNER_STATE,
  type NavLayoutOwnerState,
} from '../lib/navLayoutOwner';
import { NavLayoutSync } from '../lib/navLayoutSync';
import type { SaveStatus } from '../lib/saveStatus';
import type { CustomizableTabId } from '../lib/tabRegistry';

export type { SaveStatus };

/**
 * Owns the main-navigation tab layout — visibility, order, and persistence — scoped to the
 * currently authenticated user, identified by `userId` (not a one-time hydration flag: see
 * lib/navLayoutOwner.ts's `resetForOwnerChange`). Whenever `userId` changes — first sign-in,
 * switching to a different account, or signing out (`userId` becoming `null`) — every piece of
 * this hook's state is reset synchronously during render, before this render is ever committed, so
 * a previous user's layout, save status, or in-flight/queued write can never become visible under —
 * or dispatch on behalf of — a different identity. The previous identity's NavLayoutSync instance
 * is disposed in that same synchronous step (see its own dispose() for the matching guarantee on
 * the network/queue side): any of that identity's not-yet-sent layout is discarded immediately, and
 * an already-in-flight request is left to finish normally but can no longer affect anything.
 *
 * `saved` is `undefined` while the caller's own fetch (alongside the rest of the dashboard's data)
 * is still in flight, and `null` once fetched if the current user has never customized navigation.
 * The caller (App.tsx) is responsible for not handing this hook a *stale* `saved` value fetched for
 * a since-superseded identity — see App.tsx's own guard around setting it — but `hydrateIfNeeded`
 * also independently refuses to hydrate from a `saved` value unless it's paired with the `userId`
 * that matches the state's own current owner, as a second, cheaper line of defense.
 */
export function useNavLayout(userId: string | null, saved: NavLayoutEntry[] | null | undefined) {
  const [state, setState] = useState<NavLayoutOwnerState>(INITIAL_NAV_LAYOUT_OWNER_STATE);
  const syncRef = useRef<NavLayoutSync | null>(null);
  // Mirrors `state` synchronously — not just "as of the last commit" — so the action functions
  // below can compute against the truly-latest layout even across multiple calls within the same
  // tick, matching the guarantee the old functional-setState-updater form used to provide, without
  // putting the persist() side effect inside a setState updater itself (see toggleVisibility/move/
  // resetToDefault: each updates this ref and calls setState with a plain value, then calls
  // persist() once, outside of any updater — so React (including under StrictMode, which may
  // invoke an updater function twice) can never cause a single user action to persist twice).
  const stateRef = useRef(state);
  stateRef.current = state;

  const resetState = resetForOwnerChange(stateRef.current, userId);
  if (resetState !== stateRef.current) {
    stateRef.current = resetState;
    syncRef.current?.dispose();
    syncRef.current = userId
      ? new NavLayoutSync({
          save: (next) => updateNavLayout({ tabs: next }),
          onStatusChange: (status) => setState((prev) => ({ ...prev, status })),
        })
      : null; // logged out — nothing to submit to; toggle/move/reset simply won't be reachable
    setState(resetState);
  }

  useEffect(() => () => syncRef.current?.dispose(), []);

  useEffect(() => {
    const hydrated = hydrateIfNeeded(stateRef.current, userId, saved);
    if (hydrated !== stateRef.current) {
      stateRef.current = hydrated;
      setState(hydrated);
    }
  }, [saved, userId]);

  function toggleVisibility(id: CustomizableTabId) {
    const next = toggleTabVisibilityInLayout(stateRef.current.layout, id);
    stateRef.current = { ...stateRef.current, layout: next };
    setState(stateRef.current);
    syncRef.current?.submit(next);
  }

  function move(id: CustomizableTabId, direction: 'up' | 'down') {
    const next = moveTabInLayout(stateRef.current.layout, id, direction);
    stateRef.current = { ...stateRef.current, layout: next };
    setState(stateRef.current);
    syncRef.current?.submit(next);
  }

  function resetToDefault() {
    stateRef.current = { ...stateRef.current, layout: DEFAULT_NAV_LAYOUT };
    setState(stateRef.current);
    syncRef.current?.submit(DEFAULT_NAV_LAYOUT);
  }

  return {
    layout: state.layout,
    toggleVisibility,
    move,
    resetToDefault,
    status: state.status,
    retry: () => syncRef.current?.retry(),
  };
}
