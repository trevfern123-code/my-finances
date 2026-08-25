import { useEffect, useRef, useState } from 'react';
import { updateAppearance } from '../lib/api';
import {
  applyAppearanceToDocument,
  normalizeAccent,
  normalizeTheme,
  type AccentId,
  type ThemeId,
} from '../lib/theme';

const STORAGE_KEY = 'my-finances-appearance';

interface StoredAppearance {
  theme: ThemeId;
  accent: AccentId;
}

const DEFAULT_APPEARANCE: StoredAppearance = { theme: 'system', accent: 'green' };

function readCachedAppearance(): StoredAppearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<StoredAppearance>;
    return { theme: normalizeTheme(parsed.theme), accent: normalizeAccent(parsed.accent) };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function writeCachedAppearance(appearance: StoredAppearance) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    // Storage can be unavailable (private browsing, quota) — appearance just won't survive a
    // reload without the server round-trip in that case; nothing else breaks.
  }
}

/**
 * Owns the app's theme/accent choice. localStorage is purely a startup cache — read synchronously
 * (via the inline script in index.html) to avoid a flash of the wrong appearance before this hook
 * even mounts. Once the server value loads, it's the source of truth: this hook overwrites the
 * cache to match it, never the reverse, so a change made on another device or reverted server-side
 * always wins over whatever was cached locally.
 *
 * `saved` is `undefined` while the caller's own fetch (alongside the rest of the dashboard's data)
 * is still in flight, and `null` once fetched if the user has no saved preference yet. Mirrors
 * useDashboardLayout's shape.
 */
export function useAppearance(saved: { theme: string; accent_color: string } | null | undefined) {
  const [appearance, setAppearance] = useState<StoredAppearance>(() => readCachedAppearance());
  const hydrated = useRef(false);

  // Re-applies on every change, including the initial cached value on mount — the inline script
  // in index.html already applied that same cached value before paint, so this is a no-op DOM
  // write in the common case, not a flash.
  useEffect(() => {
    applyAppearanceToDocument(appearance.theme, appearance.accent);
  }, [appearance]);

  useEffect(() => {
    if (hydrated.current || saved === undefined) return;
    hydrated.current = true;
    const resolved: StoredAppearance = saved
      ? { theme: normalizeTheme(saved.theme), accent: normalizeAccent(saved.accent_color) }
      : DEFAULT_APPEARANCE;
    setAppearance(resolved);
    writeCachedAppearance(resolved);
  }, [saved]);

  function persist(next: StoredAppearance) {
    writeCachedAppearance(next);
    updateAppearance({ theme: next.theme, accent_color: next.accent }).catch(() => {
      // Best-effort — stays applied locally (and cached) this session even if the save failed.
    });
  }

  function setTheme(theme: ThemeId) {
    setAppearance((prev) => {
      const next = { ...prev, theme };
      persist(next);
      return next;
    });
  }

  function setAccent(accent: AccentId) {
    setAppearance((prev) => {
      const next = { ...prev, accent };
      persist(next);
      return next;
    });
  }

  return { theme: appearance.theme, accent: appearance.accent, setTheme, setAccent };
}
