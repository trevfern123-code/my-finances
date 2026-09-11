import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { updateReportingRange } from '../lib/api';
import { normalizeReportingRange, type ReportingRangeId } from '../lib/reportingRange';

/**
 * Owns the Date-Range Customization v1 preference — which of the 5 reporting-range presets drives
 * Monthly Breakdown, the Overview spending chart, and the Net Worth chart.
 *
 * Meant to be used inside a component that itself only ever mounts (via a changed `key`) once the
 * current authenticated lifecycle's own `saved` value already exists — see App.tsx's
 * `PreferencesScope`, which App.tsx deliberately does not render at all until its own
 * `preferencesStatus` is `'ready'`. Because of that, `saved` is used directly as this hook's
 * `useState` *lazy initializer* — not a default that a later passive effect copies real data
 * into. A `useState` initializer only ever runs once, on a hook instance's very first render, so
 * this hook's very first render — the first one capable of rendering an editable range control at
 * all — already reflects the current lifecycle's real, server-side range: there is no
 * intermediate committed frame, visible or not, where the built-in default range is what's
 * actually editable (and therefore savable, silently reverting a since-changed selection once a
 * passive effect would otherwise have run).
 *
 * `onReady`, captured via a ref so it never needs to appear in an effect's dependency array, is
 * called exactly once on mount (with this lifecycle's real initial range) and again on every
 * `setRange`. App.tsx uses it to know "what range is current" for the range-dependent data
 * fetches that live outside this hook (see App.tsx's applyReportingRange) — without this hook
 * needing to know anything about what those fetches are. The mount-time call happens in an
 * ordinary passive effect (not a layout effect): unlike this hook's own *state* — which must
 * already be correct on the very first render, per the reasoning above — the range-dependent
 * *data fetch* this triggers is a separate, already independently-ownership-protected concern
 * (App.tsx's rangeDataRequestIdRef), so its own timing relative to paint doesn't affect whether
 * any editable state is ever exposed as a stale default.
 *
 * `verifyOwnership`, built fresh on every render by the caller (PreferencesScope) but only ever
 * captured once per save (via a ref), is checked by authedFetch immediately before the write is
 * actually sent — including on its clock-skew retry — never merely once when the action was
 * taken. See useDashboardLayout's own doc comment for the identical reasoning.
 */
export function useReportingRange(
  saved: string,
  verifyOwnership: (session: Session) => boolean,
  onReady: (range: ReportingRangeId) => void
) {
  const [range, setRangeState] = useState<ReportingRangeId>(() => normalizeReportingRange(saved));
  const verifyOwnershipRef = useRef(verifyOwnership);
  verifyOwnershipRef.current = verifyOwnership;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;

  // Fires the initial range-data fetch exactly once, on mount, with this lifecycle's real
  // (already-hydrated, per the state initializer above) starting range — see this hook's own doc
  // comment for why a passive effect is fine here even though it wasn't for the *state* itself.
  const firedInitialReady = useRef(false);
  useEffect(() => {
    if (firedInitialReady.current) return;
    firedInitialReady.current = true;
    onReadyRef.current(range);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately mount-only; guarded above
  }, []);

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
