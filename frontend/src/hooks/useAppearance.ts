import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { updateAppearance } from '../lib/api';
import {
  applyAppearanceToDocument,
  normalizeAccent,
  normalizeTheme,
  type AccentId,
  type ThemeId,
} from '../lib/theme';
import { useSaveStatus } from './useSaveStatus';

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
 * always wins over whatever was cached locally. The cache key is deliberately unchanged by this
 * remediation — it stays device-global, not user-namespaced; see App.tsx's PreferencesScope doc
 * comment for why that's still safe now that hydration is lifecycle-scoped: a stale user's cached
 * theme can only ever be a *transient pre-hydration flash* (corrected the instant this hook's own
 * hydration effect runs on a fresh mount), never a value this hook keeps showing or persists over
 * a newer lifecycle's — that was the actual correctness bug, now closed by PreferencesScope being
 * keyed per lifecycle. Making the cache itself per-user is tracked separately as cosmetic cleanup.
 *
 * Meant to be used inside a component that itself remounts (via a changed `key`) whenever the
 * authenticated lifecycle changes — see App.tsx's `PreferencesScope`. `hydrated` and this hook's
 * `SaveStatusTracker` (via useSaveStatus) are both one-shot/instance-scoped state that a fresh
 * mount always starts clean, so neither a different lifecycle's in-memory appearance nor a stale
 * save's status/Retry can ever survive into a new one.
 *
 * `saved` is `undefined` while the caller's own fetch (alongside the rest of the dashboard's data)
 * is still in flight, and `null` once fetched if the user has no saved preference yet. Mirrors
 * useDashboardLayout's shape.
 *
 * `verifyOwnership`, built fresh on every render by the caller (PreferencesScope) but only ever
 * captured once per save (via a ref), is checked by authedFetch immediately before the write is
 * actually sent — including on its clock-skew retry — never merely once when the action was
 * taken. See useDashboardLayout's own doc comment for the identical reasoning.
 */
export function useAppearance(
  saved: { theme: string; accent_color: string } | null | undefined,
  verifyOwnership: (session: Session) => boolean
) {
  const [appearance, setAppearance] = useState<StoredAppearance>(() => readCachedAppearance());
  const hydrated = useRef(false);
  const { status: saveStatus, track, retry } = useSaveStatus();
  // Mirrors `appearance` synchronously — same reasoning as useDashboardLayout's `layoutRef`: lets
  // setTheme/setAccent compute against the truly-latest value without putting persist() inside a
  // setState updater (StrictMode-safe: a single click can never persist twice).
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const verifyOwnershipRef = useRef(verifyOwnership);
  verifyOwnershipRef.current = verifyOwnership;

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
    appearanceRef.current = resolved;
    setAppearance(resolved);
    writeCachedAppearance(resolved);
  }, [saved]);

  function persist(next: StoredAppearance) {
    writeCachedAppearance(next);
    // Stays applied locally (and cached) this session even if the save fails — track() surfaces
    // the real outcome via saveStatus instead of silently swallowing it.
    track(() => updateAppearance({ theme: next.theme, accent_color: next.accent }, (session) => verifyOwnershipRef.current(session)));
  }

  function setTheme(theme: ThemeId) {
    const next = { ...appearanceRef.current, theme };
    appearanceRef.current = next;
    setAppearance(next);
    persist(next);
  }

  function setAccent(accent: AccentId) {
    const next = { ...appearanceRef.current, accent };
    appearanceRef.current = next;
    setAppearance(next);
    persist(next);
  }

  return { theme: appearance.theme, accent: appearance.accent, setTheme, setAccent, saveStatus, retry };
}
