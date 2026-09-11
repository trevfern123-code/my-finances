import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { updateReportingRange } from '../lib/api';
import { DEFAULT_REPORTING_RANGE, normalizeReportingRange, type ReportingRangeId } from '../lib/reportingRange';

/**
 * Owns the Date-Range Customization v1 preference — which of the 5 reporting-range presets drives
 * Monthly Breakdown, the Overview spending chart, and the Net Worth chart. No localStorage cache:
 * unlike theme/accent, there's no pre-paint DOM flash to prevent here, so hydration is a plain
 * `useEffect` keyed on the fetched value (mirroring useAppearance/useFinancialPreferences).
 *
 * Meant to be used inside a component that itself remounts (via a changed `key`) whenever the
 * authenticated lifecycle changes — see App.tsx's `PreferencesScope`. `hydrated` is one-shot,
 * instance-scoped state that a fresh mount always starts clean, so a different lifecycle's stale
 * reporting range can never stay visible (and, via `onReady` below, can never keep App-level data
 * fetched at the wrong range either).
 *
 * `saved` is `undefined` while the caller's own fetch (alongside the rest of the dashboard's data)
 * is still in flight, and `null` if the fetch failed — both fall back to the default, matching
 * today's hardcoded 6-month behavior so calculations are never blocked on this loading.
 *
 * `verifyOwnership`, built fresh on every render by the caller (PreferencesScope) but only ever
 * captured once per save (via a ref), is checked by authedFetch immediately before the write is
 * actually sent — including on its clock-skew retry — never merely once when the action was
 * taken. See useDashboardLayout's own doc comment for the identical reasoning.
 *
 * `onReady`, also captured via a ref so it never needs to appear in an effect's dependency array,
 * is called exactly once on hydration (with whatever range this lifecycle actually has — the
 * saved one, or the default) and again on every `setRange`. App.tsx uses it to know "what range
 * is current" for the handful of range-dependent data fetches that live outside this hook (see
 * App.tsx's applyReportingRange) — without this hook needing to know anything about what those
 * fetches are.
 */
export function useReportingRange(
  saved: string | null | undefined,
  verifyOwnership: (session: Session) => boolean,
  onReady: (range: ReportingRangeId) => void
) {
  const [range, setRangeState] = useState<ReportingRangeId>(DEFAULT_REPORTING_RANGE);
  const hydrated = useRef(false);
  const verifyOwnershipRef = useRef(verifyOwnership);
  verifyOwnershipRef.current = verifyOwnership;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  useEffect(() => {
    if (hydrated.current || saved === undefined) return;
    hydrated.current = true;
    const resolved = saved ? normalizeReportingRange(saved) : DEFAULT_REPORTING_RANGE;
    setRangeState(resolved);
    onReadyRef.current(resolved);
  }, [saved]);

  function setRange(next: ReportingRangeId) {
    setRangeState(next);
    onReadyRef.current(next);
    updateReportingRange({ reporting_range: next }, (session) => verifyOwnershipRef.current(session)).catch(() => {
      // Best-effort — stays applied locally this session even if the save failed, same as
      // useAppearance/useFinancialPreferences.
    });
  }

  return { range, setRange };
}
