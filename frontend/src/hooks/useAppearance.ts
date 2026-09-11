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
 * (via the inline script in index.html) to avoid a flash of the wrong appearance before this
 * hook's own owning scope even mounts, then immediately overwritten by the server value below,
 * which is the actual source of truth: a change made on another device or reverted server-side
 * always wins over whatever was cached locally. The cache key is deliberately unchanged by this
 * remediation — it stays device-global, not user-namespaced; see App.tsx's PreferencesScope doc
 * comment for why that's still safe: a stale user's cached theme can only ever be a *transient
 * pre-mount* flash (the inline script's own paint, before this hook's owning scope has even
 * mounted — see below), never a value this hook itself shows or persists as if it were the
 * current lifecycle's own.
 *
 * Meant to be used inside a component that itself only ever mounts (via a changed `key`) once the
 * current authenticated lifecycle's own `saved` value already exists — see App.tsx's
 * `PreferencesScope`, which App.tsx deliberately does not render at all until its own
 * `preferencesStatus` is `'ready'`. Because of that, `saved` is used directly as this hook's
 * `useState` *lazy initializer* — not a default that a later effect copies real data into. A
 * `useState` initializer function only ever runs once, on a hook instance's very first render, so
 * this hook's very first render — the first one capable of rendering an editable Appearance
 * control at all — already reflects the current lifecycle's real, server-side theme/accent: there
 * is no intermediate committed frame, visible or not, where the device-global cache (or any other
 * default) is what's actually editable. This hook's own `SaveStatusTracker` (via useSaveStatus)
 * is instance-scoped state that a fresh mount always starts clean, closing the same class of gap
 * for save status/Retry.
 *
 * `verifyOwnership`, built fresh on every render by the caller (PreferencesScope) but only ever
 * captured once per save (via a ref), is checked by authedFetch immediately before the write is
 * actually sent — including on its clock-skew retry — never merely once when the action was
 * taken. See useDashboardLayout's own doc comment for the identical reasoning.
 */
export function useAppearance(
  saved: { theme: string; accent_color: string },
  verifyOwnership: (session: Session) => boolean
) {
  const [appearance, setAppearance] = useState<StoredAppearance>(() => ({
    theme: normalizeTheme(saved.theme),
    accent: normalizeAccent(saved.accent_color),
  }));
  const { status: saveStatus, track, retry } = useSaveStatus();
  // Mirrors `appearance` synchronously — same reasoning as useDashboardLayout's `layoutRef`: lets
  // setTheme/setAccent compute against the truly-latest value without putting persist() inside a
  // setState updater (StrictMode-safe: a single click can never persist twice).
  const appearanceRef = useRef(appearance);
  appearanceRef.current = appearance;
  const verifyOwnershipRef = useRef(verifyOwnership);
  verifyOwnershipRef.current = verifyOwnership;

  // Re-applies on every change, including the initial (already-server-sourced) value on mount —
  // the inline script in index.html already applied whatever was cached before this component
  // even mounted, so if that happened to match the server value this is a no-op DOM write, not a
  // flash; if it didn't match (a different user's cache, or a change made elsewhere), this
  // corrects it as soon as this hook mounts.
  useEffect(() => {
    applyAppearanceToDocument(appearance.theme, appearance.accent);
  }, [appearance]);

  // Writes the server value into the cache once, on mount, so the *next* page load's pre-paint
  // script starts from this lifecycle's real value rather than whatever was cached before. Doesn't
  // need to run before paint (unlike the state initialization above) — nothing editable depends on
  // this write's own timing, only on the `appearance` state already being correct from the first
  // render, which the lazy initializer already guarantees. Deliberately mount-only ([] deps,
  // reading `saved` — this mount's fixed initial value — rather than the `appearance` state that
  // changes on every edit): a local edit's own persist() already re-writes the cache itself, so
  // this effect only needs to run once, to seed the cache from the server value that predates any
  // local edit.
  useEffect(() => {
    writeCachedAppearance({ theme: normalizeTheme(saved.theme), accent: normalizeAccent(saved.accent_color) });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only
  }, []);

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
