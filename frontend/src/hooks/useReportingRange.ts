import { useEffect, useRef, useState } from 'react';
import { updateReportingRange } from '../lib/api';
import { DEFAULT_REPORTING_RANGE, normalizeReportingRange, type ReportingRangeId } from '../lib/reportingRange';

/**
 * Owns the Date-Range Customization v1 preference — which of the 5 reporting-range presets drives
 * Monthly Breakdown, the Overview spending chart, and the Net Worth chart. No localStorage cache:
 * unlike theme/accent, there's no pre-paint DOM flash to prevent here, so hydration is a plain
 * `useEffect` keyed on the fetched value (mirroring useAppearance/useFinancialPreferences).
 *
 * `saved` is `undefined` while the caller's own fetch (alongside the rest of the dashboard's data)
 * is still in flight, and `null` if the fetch failed — both fall back to the default, matching
 * today's hardcoded 6-month behavior so calculations are never blocked on this loading.
 */
export function useReportingRange(saved: string | null | undefined) {
  const [range, setRangeState] = useState<ReportingRangeId>(DEFAULT_REPORTING_RANGE);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current || saved === undefined) return;
    hydrated.current = true;
    if (saved) setRangeState(normalizeReportingRange(saved));
  }, [saved]);

  function setRange(next: ReportingRangeId) {
    setRangeState(next);
    updateReportingRange({ reporting_range: next }).catch(() => {
      // Best-effort — stays applied locally this session even if the save failed, same as
      // useAppearance/useFinancialPreferences.
    });
  }

  return { range, setRange };
}
