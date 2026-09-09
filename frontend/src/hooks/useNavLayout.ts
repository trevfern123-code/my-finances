import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
 * signing back in as themselves. Because of that, `userId` and `expectedGeneration` are both fixed
 * for this hook's entire mounted lifetime: there is no identity-change detection or in-place reset
 * logic here at all.
 *
 * `expectedGeneration` and `userId` are plain function parameters, captured directly by the
 * closure built below — never stored in, or read back out of, a mutable ref. That's deliberate:
 * they are the *expected owner* a save was created for, and must never be reassignable once
 * captured. `isGenerationCurrent` is different in kind — it's how the *ambient, live* "what
 * generation is actually current right now" question gets answered at verification time, and is
 * expected to change over time; App.tsx gives it a stable identity (`useCallback(fn, [])`) so
 * including it in this hook's effect dependency arrays never causes spurious re-construction.
 *
 * Construction and disposal of the `NavLayoutSync` instance happen in `useLayoutEffect`, not
 * passive `useEffect`. Two independent reasons:
 *  1. React 18 StrictMode deliberately mounts every effect twice in development (setup, simulated
 *     cleanup, setup again) to catch exactly this class of bug. A render-phase lazy-init survives
 *     that fine when there's no cleanup, but `dispose()` is a real, permanent, one-way transition —
 *     StrictMode's simulated cleanup would dispose a render-phase-constructed instance immediately,
 *     and a render-phase guard would then never rebuild it. Effect-owned construction means
 *     StrictMode's second "setup" call builds a genuine replacement after the simulated disposal.
 *     `useLayoutEffect` gets this exact same self-healing property `useEffect` already had.
 *  2. `useLayoutEffect` runs synchronously after DOM mutation but strictly before the browser
 *     paints — so `syncRef.current` is guaranteed non-null by the time this component's UI is ever
 *     visible, closing the "user could interact before the sync exists" question by construction
 *     rather than by an argument about event-loop timing. Construction itself performs no network
 *     call (just object/closure creation), so doing it synchronously before paint costs nothing.
 *
 * `saved` must already be `undefined` unless it genuinely belongs to this identity's current
 * fetch — App.tsx's own generation-tagged derivation (lib/authGeneration.ts's
 * currentGenerationValue) is what guarantees that; this hook does not need its own check for it.
 */
export function useNavLayout(
  userId: string | null,
  expectedGeneration: number,
  isGenerationCurrent: (generation: number) => boolean,
  saved: NavLayoutEntry[] | null | undefined
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

  const syncRef = useRef<NavLayoutSync | null>(null);
  useLayoutEffect(() => {
    if (!userId) return;
    const sync = new NavLayoutSync({
      save: (next) =>
        updateNavLayout(
          { tabs: next },
          (session: Session) => session.user.id === userId && isGenerationCurrent(expectedGeneration)
        ),
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
  }, [userId, expectedGeneration, isGenerationCurrent]); // honestly exhaustive — none of these
  // three actually change value across this mount's lifetime (userId/expectedGeneration are fixed
  // by the keyed remount; isGenerationCurrent's identity is fixed by its own useCallback), so this
  // still only truly runs once per real mount — but there is no ref reassignment anywhere carrying
  // "who this belongs to."

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
