import { useEffect, useRef, useState } from 'react';
import { updateFinancialPreferences } from '../lib/api';
import {
  clampMinimumCashBuffer,
  clampRecentAvgMonths,
  clampSavingsRateTarget,
  clampUpcomingBillsDays,
  DEFAULT_FINANCIAL_PREFERENCES,
  type FinancialPreferences,
} from '../lib/financialPreferences';

/**
 * Owns Financial Preferences v1 (minimum cash buffer, upcoming-bills window, recent-average
 * window, savings-rate target). Unlike useAppearance, there's no localStorage cache or
 * pre-paint DOM application here — these are plain numbers consumed by calculations that are
 * already loading asynchronously, not something that needs to be visible before first paint, so
 * the simpler hydrate-once-from-the-server shape is all that's needed.
 *
 * `saved` is `undefined` while the caller's own fetch (alongside the rest of the dashboard's
 * data) is still in flight, and `null` if the fetch failed — both fall back to defaults that
 * match today's hardcoded behavior, so calculations are never blocked on this loading. Hydration
 * happens in an effect (mirroring useAppearance), not directly in the render body — mutating the
 * `hydrated` ref during render is unsafe: React's dev-mode double-render can run that branch on a
 * throwaway pass whose state update never reaches the committed render, leaving `prefs` stuck at
 * its default forever even though `hydrated.current` reads true.
 */
export function useFinancialPreferences(
  saved:
    | {
        minimum_cash_buffer: number;
        upcoming_bills_days: number;
        recent_avg_months: number;
        savings_rate_target: number;
      }
    | null
    | undefined
) {
  const [prefs, setPrefs] = useState<FinancialPreferences>(DEFAULT_FINANCIAL_PREFERENCES);
  const hydrated = useRef(false);

  useEffect(() => {
    if (hydrated.current || saved === undefined) return;
    hydrated.current = true;
    if (saved) {
      setPrefs({
        minimumCashBuffer: clampMinimumCashBuffer(saved.minimum_cash_buffer),
        upcomingBillsDays: clampUpcomingBillsDays(saved.upcoming_bills_days),
        recentAvgMonths: clampRecentAvgMonths(saved.recent_avg_months),
        savingsRateTarget: clampSavingsRateTarget(saved.savings_rate_target),
      });
    }
  }, [saved]);

  function persist(next: FinancialPreferences) {
    updateFinancialPreferences({
      minimum_cash_buffer: next.minimumCashBuffer,
      upcoming_bills_days: next.upcomingBillsDays,
      recent_avg_months: next.recentAvgMonths,
      savings_rate_target: next.savingsRateTarget,
    }).catch(() => {
      // Best-effort — stays applied locally this session even if the save failed, same as
      // useAppearance/useDashboardLayout.
    });
  }

  function update(partial: Partial<FinancialPreferences>) {
    setPrefs((prev) => {
      const next = { ...prev, ...partial };
      persist(next);
      return next;
    });
  }

  return {
    ...prefs,
    setMinimumCashBuffer: (value: number) => update({ minimumCashBuffer: clampMinimumCashBuffer(value) }),
    setUpcomingBillsDays: (value: number) => update({ upcomingBillsDays: clampUpcomingBillsDays(value) }),
    setRecentAvgMonths: (value: number) => update({ recentAvgMonths: clampRecentAvgMonths(value) }),
    setSavingsRateTarget: (value: number) => update({ savingsRateTarget: clampSavingsRateTarget(value) }),
  };
}
