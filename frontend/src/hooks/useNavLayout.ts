import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { NavLayoutEntry } from '../lib/api';
import {
  DEFAULT_NAV_LAYOUT,
  mergeNavLayout,
  moveTab as moveTabInLayout,
  toggleTabVisibility as toggleTabVisibilityInLayout,
  type NavTabEntry,
} from '../lib/navLayout';
import type { NavigationWriteCoordinator } from '../lib/navigationWriteCoordinator';
import type { SaveStatus } from '../lib/saveStatus';
import type { CustomizableTabId } from '../lib/tabRegistry';

export type { SaveStatus };

/**
 * Owns the main-navigation tab layout for exactly one authenticated login lifecycle's mounted
 * lifetime. This hook is meant to be used inside a component that itself remounts (via a changed
 * `key`) whenever the authenticated lifecycle changes — see App.tsx's `NavLayoutScope`, keyed by
 * Supabase's own `session_id` JWT claim (see lib/jwt.ts), which advances on every genuine sign-in/
 * sign-out transition, including a user signing back in as themselves, and stays stable across that
 * login's own token refreshes. Because of that, `userId` and `expectedSessionId` are both fixed for
 * this hook's entire mounted lifetime: there is no identity-change detection or in-place reset
 * logic here at all.
 *
 * Persistence is delegated to a `NavigationWriteCoordinator` shared across every mount (constructed
 * once in App.tsx, which never remounts) rather than a coordinator/queue constructed fresh per
 * mount — see that class's own doc comment for why this is what actually closes the cross-
 * lifecycle write-ordering gap a mount-scoped queue could not. This hook only `attach()`es to it on
 * mount and `detach()`s on unmount; it never constructs or disposes the coordinator itself.
 *
 * `attach`/`detach` happen inside `useLayoutEffect`, not passive `useEffect` — same two reasons as
 * before: (1) React 18 StrictMode's dev-mode setup/cleanup/setup double-invoke needs `attach()`'s
 * second call to leave the coordinator in a correctly-attached state, which it does (idempotent —
 * attaching twice with the same sessionId is harmless); (2) doing it synchronously before paint
 * means this scope is guaranteed attached before the browser ever shows it, closing the "could the
 * user interact before it's ready" question by construction.
 *
 * `verifyOwnership`, built fresh on every render by the caller (NavLayoutScope) but only ever
 * captured once per submission (not once per mount), checks three things in order: the returned
 * session's `user.id`, the returned session's own decoded `session_id` (compared directly against
 * this hook's immutable `expectedSessionId` — not against any ambient/committed React state), and
 * — as an additional, independently-sourced check that can only make the verification stricter,
 * never more permissive — whether the ambient committed lifecycle is still current. See
 * lib/api.ts's authedFetch for exactly when this runs (every attempt, including the clock-skew
 * retry) and App.tsx's NavLayoutScope for how it's assembled.
 *
 * `saved` must already be `undefined` unless it genuinely belongs to this lifecycle's current
 * fetch — App.tsx's own session-id-tagged derivation (lib/authGeneration.ts's
 * currentGenerationValue) is what guarantees that; this hook does not need its own check for it.
 */
export function useNavLayout(
  userId: string | null,
  expectedSessionId: string,
  coordinator: NavigationWriteCoordinator,
  verifyOwnership: (session: Session) => boolean,
  saved: NavLayoutEntry[] | null | undefined
) {
  const [layout, setLayout] = useState<NavTabEntry[]>(() => mergeNavLayout(undefined));
  const [status, setStatus] = useState<SaveStatus>('idle');
  const hydratedRef = useRef(false);
  // Mirrors `layout` synchronously (not just "as of the last commit") so the action functions below
  // can compute against the truly-latest layout even across multiple calls within the same tick —
  // the same guarantee a functional setState updater used to provide, without putting the submit()
  // side effect inside a setState updater itself (so React, including under StrictMode, can never
  // cause a single user action to persist twice).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const verifyOwnershipRef = useRef(verifyOwnership);
  verifyOwnershipRef.current = verifyOwnership;

  useLayoutEffect(() => {
    if (!userId) return;
    coordinator.attach(expectedSessionId, setStatus);
    return () => coordinator.detach(expectedSessionId);
  }, [userId, expectedSessionId, coordinator]);

  useEffect(() => {
    if (hydratedRef.current || saved === undefined || !userId) return;
    hydratedRef.current = true;
    const hydrated = mergeNavLayout(saved);
    layoutRef.current = hydrated;
    setLayout(hydrated);
  }, [saved, userId]);

  function submit(next: NavTabEntry[]) {
    coordinator.submit(next, expectedSessionId, (session) => verifyOwnershipRef.current(session));
  }

  function toggleVisibility(id: CustomizableTabId) {
    const next = toggleTabVisibilityInLayout(layoutRef.current, id);
    layoutRef.current = next;
    setLayout(next);
    submit(next);
  }

  function move(id: CustomizableTabId, direction: 'up' | 'down') {
    const next = moveTabInLayout(layoutRef.current, id, direction);
    layoutRef.current = next;
    setLayout(next);
    submit(next);
  }

  function resetToDefault() {
    layoutRef.current = DEFAULT_NAV_LAYOUT;
    setLayout(DEFAULT_NAV_LAYOUT);
    submit(DEFAULT_NAV_LAYOUT);
  }

  return {
    layout,
    toggleVisibility,
    move,
    resetToDefault,
    status,
    retry: () => coordinator.retry(expectedSessionId),
  };
}
