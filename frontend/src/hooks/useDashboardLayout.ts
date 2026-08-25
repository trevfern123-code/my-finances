import { useEffect, useRef, useState } from 'react';
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
 * `savedCards` is `undefined` while the caller's own fetch (alongside the rest of the
 * dashboard's data) is still in flight, and `null` once fetched if the user has never
 * customized anything — both resolve to the same built-in default layout, hydrated exactly
 * once so a later refetch (e.g. after some unrelated action) never clobbers a local edit made
 * in between.
 */
export function useDashboardLayout(savedCards: DashboardCardEntry[] | null | undefined) {
  const [layout, setLayout] = useState<DashboardCard[]>(() => mergeDashboardLayout(undefined));
  const [customizing, setCustomizing] = useState(false);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current || savedCards === undefined) return;
    hydrated.current = true;
    setLayout(mergeDashboardLayout(savedCards));
  }, [savedCards]);

  function persist(next: DashboardCard[]) {
    updateDashboardLayout({ cards: next }).catch(() => {
      // Best-effort — the change stays applied locally for this session even if the save
      // failed; the user isn't blocked, and the next successful save catches it up.
    });
  }

  function toggleVisibility(cardId: CardId) {
    setLayout((prev) => {
      const next = toggleCardVisibilityInLayout(prev, cardId);
      persist(next);
      return next;
    });
  }

  function move(cardId: CardId, direction: 'up' | 'down') {
    setLayout((prev) => {
      const next = moveCardInLayout(prev, cardId, direction);
      persist(next);
      return next;
    });
  }

  function applyPreset(presetId: PresetId) {
    const next = PRESETS[presetId];
    setLayout(next);
    persist(next);
  }

  return { layout, customizing, setCustomizing, toggleVisibility, move, applyPreset };
}
