import { useRef, useState } from 'react';
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
 * Meant to be used inside a component that itself only ever mounts (via a changed `key`) once the
 * current authenticated lifecycle's own `savedCards` value already exists — see App.tsx's
 * `PreferencesScope`, which App.tsx deliberately does not render at all until its own
 * `preferencesStatus` is `'ready'`. Because of that, `savedCards` is used directly as this hook's
 * `useState` *lazy initializer* — not a default that a later effect copies real data into. A
 * `useState` initializer function only ever runs once, on a hook instance's very first render, so
 * this hook's very first render already reflects the current lifecycle's real, server-side
 * layout: there is no intermediate committed frame — visible or not — where a default/blank
 * layout is what's actually editable. A later change to `savedCards` (e.g. an unrelated
 * refreshAll() re-fetching without a lifecycle change) is intentionally ignored, since the
 * initializer never runs again for an already-mounted instance — the same "a later refetch never
 * clobbers a local edit" guarantee a `hydrated` ref used to provide, now structural rather than a
 * flag this hook has to maintain itself.
 *
 * `savedCards` is `null` if the user has never customized anything, resolving to the built-in
 * default layout.
 *
 * `verifyOwnership`, built fresh on every render by the caller (PreferencesScope) but only ever
 * captured once per save (via a ref, so a call already in flight keeps whatever binding it
 * started with even if a newer render produced a new — functionally identical — closure), is
 * checked by authedFetch immediately before the write is actually sent — including on its
 * clock-skew retry — never merely once when the action was taken.
 */
export function useDashboardLayout(
  savedCards: DashboardCardEntry[] | null,
  verifyOwnership: (session: Session) => boolean
) {
  const [layout, setLayout] = useState<DashboardCard[]>(() => mergeDashboardLayout(savedCards));
  const [customizing, setCustomizing] = useState(false);
  // Mirrors `layout` synchronously (not just "as of the last commit") so the action functions
  // below can compute against the truly-latest layout even across multiple calls within the same
  // tick — the same guarantee a functional setState updater used to provide, without putting the
  // persist() side effect inside a setState updater itself (so React, including under StrictMode,
  // can never cause a single user action to persist twice).
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const verifyOwnershipRef = useRef(verifyOwnership);
  verifyOwnershipRef.current = verifyOwnership;

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
