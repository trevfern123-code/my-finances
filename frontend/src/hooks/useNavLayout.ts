import { useEffect, useRef, useState } from 'react';
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
 * Owns the main-navigation tab layout — visibility, order, and persistence — mirroring
 * useDashboardLayout's hydrate-once shape, but persisting through NavLayoutSync (lib/navLayoutSync.ts)
 * instead of a fire-and-forget `.catch(() => {})`, so rapid hide/show/reorder actions can never
 * leave a stale layout as the last thing written to the server (see NavLayoutSync's own comment).
 *
 * `saved` is `undefined` while the caller's own fetch is still in flight, and `null` once fetched
 * if the user has never customized navigation — both resolve to the same built-in default layout.
 */
export function useNavLayout(saved: NavLayoutEntry[] | null | undefined) {
  const [layout, setLayout] = useState<NavTabEntry[]>(() => mergeNavLayout(undefined));
  const [status, setStatus] = useState<SaveStatus>('idle');
  const hydrated = useRef(false);
  const syncRef = useRef<NavLayoutSync | null>(null);
  if (!syncRef.current) {
    syncRef.current = new NavLayoutSync({
      save: (next) => updateNavLayout({ tabs: next }),
      onStatusChange: setStatus,
    });
  }

  useEffect(() => () => syncRef.current?.dispose(), []);

  useEffect(() => {
    if (hydrated.current || saved === undefined) return;
    hydrated.current = true;
    setLayout(mergeNavLayout(saved));
  }, [saved]);

  function persist(next: NavTabEntry[]) {
    syncRef.current!.submit(next);
  }

  function toggleVisibility(id: CustomizableTabId) {
    setLayout((prev) => {
      const next = toggleTabVisibilityInLayout(prev, id);
      persist(next);
      return next;
    });
  }

  function move(id: CustomizableTabId, direction: 'up' | 'down') {
    setLayout((prev) => {
      const next = moveTabInLayout(prev, id, direction);
      persist(next);
      return next;
    });
  }

  function resetToDefault() {
    setLayout(DEFAULT_NAV_LAYOUT);
    persist(DEFAULT_NAV_LAYOUT);
  }

  return {
    layout,
    toggleVisibility,
    move,
    resetToDefault,
    status,
    retry: () => syncRef.current!.retry(),
  };
}
