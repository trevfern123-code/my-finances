import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { updateDashboardLayout, type DashboardCardEntry } from '../lib/api';
import {
  PRESETS,
  mergeDashboardLayout,
  moveCard as moveCardInLayout,
  toggleCardVisibility as toggleCardVisibilityInLayout,
  type CardId,
  type DashboardCard,
  type PresetId,
} from '../lib/dashboardLayout';

/**
 * Owns the Overview dashboard's card layout — visibility, order, and persistence — entirely
 * independent of how any individual card renders, so the same hook (and the pure logic it's
 * built on in lib/dashboardLayout.ts) can drive a future mobile app's own card components.
 *
 * Meant to be used inside a component that itself remounts (via a changed `key`) whenever the
 * authenticated lifecycle changes — see App.tsx's `PreferencesScope`, keyed by Supabase's own
 * `session_id` JWT claim. Because of that, this hook's own `hydrated` ref is deliberately a
 * one-shot latch, not a session-aware guard of its own: a fresh mount always starts at
 * `hydrated.current = false`, so there is no window where a different (or stale) lifecycle's
 * cards could ever be shown or persisted over this one's.
 *
 * `savedCards` is `undefined` while the caller's own fetch (alongside the rest of the
 * dashboard's data) is still in flight, and `null` once fetched if the user has never
 * customized anything — both resolve to the same built-in default layout, hydrated exactly
 * once per mount so a later refetch (e.g. after some unrelated action, or a stale response that
 * belongs to a superseded lifecycle) never clobbers a local edit made in between.
 *
 * `verifyOwnership`, built fresh on every render by the caller (PreferencesScope) but only ever
 * captured once per save (via a ref, so a call already in flight keeps whatever binding it
 * started with even if a newer render produced a new — functionally identical — closure), is
 * checked by authedFetch immediately before the write is actually sent — including on its
 * clock-skew retry — never merely once when the action was taken.
 */
export function useDashboardLayout(
  savedCards: DashboardCardEntry[] | null | undefined,
  verifyOwnership: (session: Session) => boolean
) {
  const [layout, setLayout] = useState<DashboardCard[]>(() => mergeDashboardLayout(undefined));
  const [customizing, setCustomizing] = useState(false);
  const hydrated = useRef(false);
  // Mirrors `layout` synchronously (not just "as of the last commit") so the action functions
  // below can compute against the truly-latest layout even across multiple calls within the same
  // tick — the same guarantee a functional setState updater used to provide, without putting the
  // persist() side effect inside a setState updater itself (so React, including under StrictMode,
  // can never cause a single user action to persist twice).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const verifyOwnershipRef = useRef(verifyOwnership);
  verifyOwnershipRef.current = verifyOwnership;

  useEffect(() => {
    if (hydrated.current || savedCards === undefined) return;
    hydrated.current = true;
    const hydratedLayout = mergeDashboardLayout(savedCards);
    layoutRef.current = hydratedLayout;
    setLayout(hydratedLayout);
  }, [savedCards]);

  function persist(next: DashboardCard[]) {
    updateDashboardLayout({ cards: next }, (session) => verifyOwnershipRef.current(session)).catch(() => {
      // Best-effort — the change stays applied locally for this session even if the save
      // failed; the user isn't blocked, and the next successful save catches it up.
    });
  }

  function toggleVisibility(cardId: CardId) {
    const next = toggleCardVisibilityInLayout(layoutRef.current, cardId);
    layoutRef.current = next;
    setLayout(next);
    persist(next);
  }

  function move(cardId: CardId, direction: 'up' | 'down') {
    const next = moveCardInLayout(layoutRef.current, cardId, direction);
    layoutRef.current = next;
    setLayout(next);
    persist(next);
  }

  function applyPreset(presetId: PresetId) {
    const next = PRESETS[presetId];
    layoutRef.current = next;
    setLayout(next);
    persist(next);
  }

  return { layout, customizing, setCustomizing, toggleVisibility, move, applyPreset };
}
