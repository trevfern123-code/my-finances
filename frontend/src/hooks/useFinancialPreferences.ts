import { useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { updateFinancialPreferences } from '../lib/api';
import {
  clampMinimumCashBuffer,
  clampRecentAvgMonths,
  clampSavingsRateTarget,
  clampUpcomingBillsDays,
  DEFAULT_FINANCIAL_PREFERENCES,
  type FinancialPreferences,
} from '../lib/financialPreferences';
import { useSaveStatus } from './useSaveStatus';

/**
 * Owns Financial Preferences v1 (minimum cash buffer, upcoming-bills window, recent-average
 * window, savings-rate target) plus the Safe to Spend Customization v1 toggles (include upcoming
 * bills / include remaining budget). Unlike useAppearance, there's no localStorage cache or
 * pre-paint DOM application here — these are plain values consumed by calculations that are
 * already loading asynchronously, not something that needs to be visible before first paint, so
 * the simpler hydrate-once-from-the-server shape is all that's needed. Hydration happens in an
 * effect (mirroring useAppearance), not directly in the render body — mutating the `hydrated` ref
 * during render is unsafe: React's dev-mode double-render can run that branch on a throwaway pass
 * whose state update never reaches the committed render, leaving `prefs` stuck at its default
 * forever even though `hydrated.current` reads true.
 *
 * Meant to be used inside a component that itself remounts (via a changed `key`) whenever the
 * authenticated lifecycle changes — see App.tsx's `PreferencesScope`. `hydrated` and this hook's
 * `SaveStatusTracker` (via useSaveStatus) are both one-shot/instance-scoped state that a fresh
 * mount always starts clean: this is what stops a different lifecycle's stale financial
 * preferences (including the Safe-to-Spend toggles, which directly feed the Safe to Spend and
 * cash-flow-pace calculations) from staying visible — or, worse, from having a single-field edit
 * silently persist all of them, sibling fields included, over a newer lifecycle's own newer
 * values — and stops a stale save's status/Retry from surfacing in a new lifecycle's scope.
 *
 * `saved` is `undefined` while the caller's own fetch (alongside the rest of the dashboard's
 * data) is still in flight, and `null` if the fetch failed — both fall back to defaults that
 * match today's hardcoded behavior, so calculations are never blocked on this loading.
 *
 * `verifyOwnership`, built fresh on every render by the caller (PreferencesScope) but only ever
 * captured once per save (via a ref), is checked by authedFetch immediately before the write is
 * actually sent — including on its clock-skew retry — never merely once when the action was
 * taken. See useDashboardLayout's own doc comment for the identical reasoning.
 */
export function useFinancialPreferences(
  saved:
    | {
        minimum_cash_buffer: number;
        upcoming_bills_days: number;
        recent_avg_months: number;
        savings_rate_target: number;
        safe_to_spend_include_upcoming_bills: boolean;
        safe_to_spend_include_remaining_budget: boolean;
      }
    | null
    | undefined,
  verifyOwnership: (session: Session) => boolean
) {
  const [prefs, setPrefs] = useState<FinancialPreferences>(DEFAULT_FINANCIAL_PREFERENCES);
  const hydrated = useRef(false);
  const { status: saveStatus, track, retry } = useSaveStatus();
  // Mirrors `prefs` synchronously — same reasoning as useDashboardLayout's `layoutRef`: lets
  // update() compute against the truly-latest values without putting persist() inside a setState
  // updater (StrictMode-safe: a single edit can never persist twice), and, more importantly here,
  // ensures a single-field edit's read-modify-write always starts from this lifecycle's own
  // latest values, never a stale snapshot.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const verifyOwnershipRef = useRef(verifyOwnership);
  verifyOwnershipRef.current = verifyOwnership;

  useEffect(() => {
    if (hydrated.current || saved === undefined) return;
    hydrated.current = true;
    if (saved) {
      const resolved: FinancialPreferences = {
        minimumCashBuffer: clampMinimumCashBuffer(saved.minimum_cash_buffer),
        upcomingBillsDays: clampUpcomingBillsDays(saved.upcoming_bills_days),
        recentAvgMonths: clampRecentAvgMonths(saved.recent_avg_months),
        savingsRateTarget: clampSavingsRateTarget(saved.savings_rate_target),
        includeUpcomingBills: saved.safe_to_spend_include_upcoming_bills,
        includeRemainingBudget: saved.safe_to_spend_include_remaining_budget,
      };
      prefsRef.current = resolved;
      setPrefs(resolved);
    }
  }, [saved]);

  function persist(next: FinancialPreferences) {
    // Stays applied locally this session even if the save fails — track() surfaces the real
    // outcome via saveStatus instead of silently swallowing it.
    track(() =>
      updateFinancialPreferences(
        {
          minimum_cash_buffer: next.minimumCashBuffer,
          upcoming_bills_days: next.upcomingBillsDays,
          recent_avg_months: next.recentAvgMonths,
          savings_rate_target: next.savingsRateTarget,
          safe_to_spend_include_upcoming_bills: next.includeUpcomingBills,
          safe_to_spend_include_remaining_budget: next.includeRemainingBudget,
        },
        (session) => verifyOwnershipRef.current(session)
      )
    );
  }

  function update(partial: Partial<FinancialPreferences>) {
    const next = { ...prefsRef.current, ...partial };
    prefsRef.current = next;
    setPrefs(next);
    persist(next);
  }

  return {
    ...prefs,
    setMinimumCashBuffer: (value: number) => update({ minimumCashBuffer: clampMinimumCashBuffer(value) }),
    setUpcomingBillsDays: (value: number) => update({ upcomingBillsDays: clampUpcomingBillsDays(value) }),
    setRecentAvgMonths: (value: number) => update({ recentAvgMonths: clampRecentAvgMonths(value) }),
    setSavingsRateTarget: (value: number) => update({ savingsRateTarget: clampSavingsRateTarget(value) }),
    setIncludeUpcomingBills: (value: boolean) => update({ includeUpcomingBills: value }),
    setIncludeRemainingBudget: (value: boolean) => update({ includeRemainingBudget: value }),
    saveStatus,
    retry,
  };
}
