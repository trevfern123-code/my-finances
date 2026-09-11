import { useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { updateFinancialPreferences } from '../lib/api';
import {
  clampMinimumCashBuffer,
  clampRecentAvgMonths,
  clampSavingsRateTarget,
  clampUpcomingBillsDays,
  type FinancialPreferences,
} from '../lib/financialPreferences';
import { useSaveStatus } from './useSaveStatus';

/**
 * Owns Financial Preferences v1 (minimum cash buffer, upcoming-bills window, recent-average
 * window, savings-rate target) plus the Safe to Spend Customization v1 toggles (include upcoming
 * bills / include remaining budget).
 *
 * Meant to be used inside a component that itself only ever mounts (via a changed `key`) once the
 * current authenticated lifecycle's own `saved` value already exists — see App.tsx's
 * `PreferencesScope`, which App.tsx deliberately does not render at all until its own
 * `preferencesStatus` is `'ready'`. Because of that, `saved` is used directly as this hook's
 * `useState` *lazy initializer* — not a default that a later passive effect copies real data
 * into (the previous design's own reasoning for using an effect at all — "mutating the `hydrated`
 * ref during render is unsafe" — no longer applies: there is no `hydrated` ref, and nothing
 * mutates during render; the initializer function is the one React-sanctioned place a mount's
 * first state is computed from props). A `useState` initializer only ever runs once, on a hook
 * instance's very first render, so this hook's very first render — the first one capable of
 * rendering an editable Financial Preferences control at all — already reflects the current
 * lifecycle's real, server-side values: there is no intermediate committed frame, visible or not,
 * where a default sibling value (e.g. a default savings-rate target) is what a same-tick edit to
 * a *different* field would actually save alongside the real one.
 *
 * This hook's own `SaveStatusTracker` (via useSaveStatus) is instance-scoped state that a fresh
 * mount always starts clean, closing the same class of gap for save status/Retry — a different
 * lifecycle's stale financial preferences (including the Safe-to-Spend toggles, which directly
 * feed the Safe to Spend and cash-flow-pace calculations) can never stay visible, and a stale
 * save's status/Retry can never surface in a new lifecycle's scope.
 *
 * `verifyOwnership`, built fresh on every render by the caller (PreferencesScope) but only ever
 * captured once per save (via a ref), is checked by authedFetch immediately before the write is
 * actually sent — including on its clock-skew retry — never merely once when the action was
 * taken. See useDashboardLayout's own doc comment for the identical reasoning.
 */
export function useFinancialPreferences(
  saved: {
    minimum_cash_buffer: number;
    upcoming_bills_days: number;
    recent_avg_months: number;
    savings_rate_target: number;
    safe_to_spend_include_upcoming_bills: boolean;
    safe_to_spend_include_remaining_budget: boolean;
  },
  verifyOwnership: (session: Session) => boolean
) {
  const [prefs, setPrefs] = useState<FinancialPreferences>(() => ({
    minimumCashBuffer: clampMinimumCashBuffer(saved.minimum_cash_buffer),
    upcomingBillsDays: clampUpcomingBillsDays(saved.upcoming_bills_days),
    recentAvgMonths: clampRecentAvgMonths(saved.recent_avg_months),
    savingsRateTarget: clampSavingsRateTarget(saved.savings_rate_target),
    includeUpcomingBills: saved.safe_to_spend_include_upcoming_bills,
    includeRemainingBudget: saved.safe_to_spend_include_remaining_budget,
  }));
  const { status: saveStatus, track, retry } = useSaveStatus();
  // Mirrors `prefs` synchronously — same reasoning as useDashboardLayout's `layoutRef`: lets
  // update() compute against the truly-latest values without putting persist() inside a setState
  // updater (StrictMode-safe: a single edit can never persist twice), and, more importantly here,
  // ensures a single-field edit's read-modify-write always starts from this lifecycle's own
  // latest (already-hydrated-from-mount) values, never a stale or default snapshot.
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const verifyOwnershipRef = useRef(verifyOwnership);
  verifyOwnershipRef.current = verifyOwnership;

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
