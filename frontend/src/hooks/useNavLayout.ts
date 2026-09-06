import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { updateNavLayout, type NavLayoutEntry } from '../lib/api';
import {
  DEFAULT_NAV_LAYOUT,
  mergeNavLayout,
  moveTab as moveTabInLayout,
  toggleTabVisibility as toggleTabVisibilityInLayout,
  type NavTabEntry,
} from '../lib/navLayout';
import { NavLayoutSync } from '../lib/navLayoutSync';
import type { SaveStatus } from '../lib/saveStatus';
import type { CustomizableTabId } from '../lib/tabRegistry';

export type { SaveStatus };

/**
 * Owns the main-navigation tab layout for exactly one authenticated identity's mounted lifetime.
 * This hook is meant to be used inside a component that itself remounts (via a changed `key`)
 * whenever the authenticated user changes — see App.tsx's `NavLayoutScope`, keyed by an auth
 * generation number that advances across every sign-in/sign-out transition, including a user
 * signing back in as themselves. Because of that, `userId` is fixed for this hook's entire mounted
 * lifetime: there is no identity-change detection or in-place reset logic here at all.
 *
 * The `NavLayoutSync` instance is constructed inside a `useEffect`, not lazily during render.
 * That's deliberate, not just stylistic: React 18 StrictMode deliberately mounts every effect
 * twice in development (setup, simulated cleanup, setup again) to catch exactly this class of
 * bug. A render-phase lazy-init (`if (!ref.current) ref.current = new X()`, guarded only by "does
 * anything already exist") survives that fine when the effect has no cleanup, but here the
 * cleanup calls `dispose()`, which is a real, permanent, one-way transition — StrictMode's
 * simulated cleanup would dispose the freshly-built instance immediately, and the render-phase
 * guard would then never rebuild it (something already exists in the ref, it's just inert),
 * silently no-opping every future submit() for the rest of the mount. Constructing inside the
 * effect instead means StrictMode's second "setup" call builds a *replacement* instance after the
 * simulated disposal, so the mount ends up with a live, working one — matching React's own
 * documented pattern for a resource whose lifecycle must survive this simulation. This was found
 * by live-browser testing, not by the test suite — vitest's environment doesn't run under
 * StrictMode, so this class of bug is invisible to it (same lesson as SaveStatusTracker's
 * detached-setTimeout bug from Phase 1).
 *
 * `verifyOwnership` is threaded through to lib/api.ts's updateNavLayout, which passes it to
 * authedFetch — checked there at the moment a request is actually about to be sent (including on
 * a clock-skew retry), which is what actually closes the "session changed mid-flight" window. It's
 * mirrored into a ref (`verifyOwnershipRef`) rather than being a dependency of the construction
 * effect: every render's version is functionally identical for this mount (`userId` is fixed, and
 * the live-generation check reads a ref fresh at call time), so the effect only needs to depend on
 * `userId` — including it as a dependency would tear down and rebuild the sync instance on every
 * unrelated render for no benefit.
 *
 * `saved` must already be `undefined` unless it genuinely belongs to this identity's current
 * fetch — App.tsx's own generation-tagged derivation (lib/authGeneration.ts's
 * currentGenerationValue) is what guarantees that; this hook does not need its own check for it.
 */
export function useNavLayout(
  userId: string | null,
  saved: NavLayoutEntry[] | null | undefined,
  verifyOwnership: (session: Session) => boolean
) {
  const [layout, setLayout] = useState<NavTabEntry[]>(() => mergeNavLayout(undefined));
  const [status, setStatus] = useState<SaveStatus>('idle');
  const hydratedRef = useRef(false);
  // Mirrors `layout` synchronously (not just "as of the last commit") so the action functions below
  // can compute against the truly-latest layout even across multiple calls within the same tick —
  // the same guarantee a functional setState updater used to provide, without putting the submit()
  // side effect inside a setState updater itself (see toggleVisibility/move/resetToDefault: each
  // updates this ref and calls setState with a plain value, then submits once, outside any updater —
  // so React, including under StrictMode, can never cause a single user action to persist twice).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const verifyOwnershipRef = useRef(verifyOwnership);
  verifyOwnershipRef.current = verifyOwnership;

  const syncRef = useRef<NavLayoutSync | null>(null);
  useEffect(() => {
    if (!userId) return;
    const sync = new NavLayoutSync({
      save: (next) => updateNavLayout({ tabs: next }, (session) => verifyOwnershipRef.current(session)),
      onStatusChange: setStatus,
    });
    syncRef.current = sync;
    return () => {
      sync.dispose();
      // Guards against a *later* effect run's instance being wiped out by an *earlier* run's
      // cleanup firing out of order — not expected given how React sequences these, but cheap
      // insurance: only null out the ref if it still points at the exact instance this cleanup
      // belongs to.
      if (syncRef.current === sync) syncRef.current = null;
    };
  }, [userId]);

  useEffect(() => {
    if (hydratedRef.current || saved === undefined || !userId) return;
    hydratedRef.current = true;
    const hydrated = mergeNavLayout(saved);
    layoutRef.current = hydrated;
    setLayout(hydrated);
  }, [saved, userId]);

  function toggleVisibility(id: CustomizableTabId) {
    const next = toggleTabVisibilityInLayout(layoutRef.current, id);
    layoutRef.current = next;
    setLayout(next);
    syncRef.current?.submit(next);
  }

  function move(id: CustomizableTabId, direction: 'up' | 'down') {
    const next = moveTabInLayout(layoutRef.current, id, direction);
    layoutRef.current = next;
    setLayout(next);
    syncRef.current?.submit(next);
  }

  function resetToDefault() {
    layoutRef.current = DEFAULT_NAV_LAYOUT;
    setLayout(DEFAULT_NAV_LAYOUT);
    syncRef.current?.submit(DEFAULT_NAV_LAYOUT);
  }

  return {
    layout,
    toggleVisibility,
    move,
    resetToDefault,
    status,
    retry: () => syncRef.current?.retry(),
  };
}
