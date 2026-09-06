import { useCallback, useEffect, useRef, useState } from 'react';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

// How long the "Saved ✓" confirmation stays visible before fading back to idle. An error, by
// contrast, never auto-clears — it stays until a retry succeeds or another save is attempted.
const SAVED_DISPLAY_MS = 2000;

/**
 * A truthful save-status tracker for the auto-save preference hooks (useAppearance,
 * useFinancialPreferences, …). `status` only ever becomes 'saved' after the underlying request
 * has actually resolved — never merely because local state changed — and only ever becomes
 * 'error' after it has actually rejected. This does not change how a preference hook already
 * applies a change optimistically to local state (that stays exactly as it was); it only makes
 * the real, awaited outcome of the save visible instead of silently swallowed.
 *
 * `track` takes a thunk rather than an already-started promise so `retry` can safely re-invoke
 * the exact same attempt (same payload) without the caller needing to remember it separately.
 */
export function useSaveStatus() {
  const [status, setStatus] = useState<SaveStatus>('idle');
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();
  const lastAttempt = useRef<(() => Promise<unknown>) | null>(null);
  // Guards against a slow, stale request's resolution clobbering the status after a newer one
  // has already started (or the component doing something else in the meantime) — only the
  // most recently started attempt is allowed to move `status` when it settles.
  const attemptId = useRef(0);

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const track = useCallback((run: () => Promise<unknown>) => {
    lastAttempt.current = run;
    clearTimeout(resetTimer.current);
    const id = ++attemptId.current;
    setStatus('saving');
    run().then(
      () => {
        if (attemptId.current !== id) return;
        setStatus('saved');
        resetTimer.current = setTimeout(() => setStatus('idle'), SAVED_DISPLAY_MS);
      },
      () => {
        if (attemptId.current !== id) return;
        setStatus('error');
      }
    );
  }, []);

  const retry = useCallback(() => {
    if (lastAttempt.current) track(lastAttempt.current);
  }, [track]);

  return { status, track, retry };
}
