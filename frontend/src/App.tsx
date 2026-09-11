import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './lib/supabaseClient';
import {
  createBudgetCategory,
  createManualLoan,
  createManualPayment,
  clearTransactionSplits,
  deleteCategoryMapping,
  deleteManualLoan,
  deleteManualPayment,
  getAssetsSummary,
  getBudgetCategories,
  getCategoryMappings,
  getLinkedItems,
  getLoanPayments,
  getLoans,
  getManualLoans,
  getMonthlyBreakdown,
  getNetWorthHistory,
  getPlaidCategories,
  getRecurringStreams,
  getSpendingSummary,
  getTransactions,
  getUserPreferences,
  approveTransaction,
  saveCategoryMapping,
  saveTransactionSplits,
  setTransactionCategory,
  syncTransactions as syncTransactionsRequest,
  unlinkLoanPayment,
  updateAccountCreditLimit,
  updateAccountCustomization,
  updateAccountSavingsGoal,
  updateBudgetCategory,
  updateLinkedLoanPayment,
  updateManualLoan,
  updateManualPayment,
  updateNavLayout,
  type AssetGroup,
  type BudgetCategory,
  type CategoryMapping,
  type LinkedItem,
  type Loan,
  type LoanPayment,
  type ManualLoan,
  type ManualLoanInput,
  type ManualPaymentInput,
  type MonthBreakdown,
  type NavLayoutEntry,
  type NetWorthPoint,
  type RecurringStream,
  type SpendingSummary,
  type TransactionItem,
  type UserPreferences,
} from './lib/api';
import { currentGenerationValue } from './lib/authGeneration';
import { groupCardsIntoRows, type CardId } from './lib/dashboardLayout';
import { decodeSessionId } from './lib/jwt';
import { getVisibleOrderedTabIds } from './lib/navLayout';
import { NavigationWriteCoordinator } from './lib/navigationWriteCoordinator';
import { DEFAULT_REPORTING_RANGE, type ReportingRangeId } from './lib/reportingRange';
import { buildWebTabList } from './lib/webTabNav';
import { useAuthSession } from './hooks/useAuthSession';
import { useDashboardLayout } from './hooks/useDashboardLayout';
import { useAppearance } from './hooks/useAppearance';
import { useFinancialPreferences } from './hooks/useFinancialPreferences';
import { useNavLayout } from './hooks/useNavLayout';
import { useReportingRange } from './hooks/useReportingRange';
import { Auth } from './components/Auth';
import { PlaidLink } from './components/PlaidLink';
import { LinkedAccounts } from './components/LinkedAccounts';
import { TransactionsFeed } from './components/TransactionsFeed';
import { BudgetCategories } from './components/BudgetCategories';
import { OverviewStats } from './components/OverviewStats';
import { SafeToSpend } from './components/SafeToSpend';
import { CashFlowPace } from './components/CashFlowPace';
import { AccountQuickView } from './components/AccountQuickView';
import { UpcomingBills } from './components/UpcomingBills';
import { RecentActivity } from './components/RecentActivity';
import { MonthlySpendingChart } from './components/MonthlySpendingChart';
import { NetWorthChart } from './components/NetWorthChart';
import { MonthlyBreakdown } from './components/MonthlyBreakdown';
import { SubscriptionsRecurring } from './components/SubscriptionsRecurring';
import { LoanProgress } from './components/LoanProgress';
import { IncomeSavings } from './components/IncomeSavings';
import { Settings } from './components/Settings';
import { DashboardCustomizer } from './components/DashboardCustomizer';
import { ReportingRangeSelector } from './components/ReportingRangeSelector';
import { TabNav } from './components/TabNav';
import './App.css';

// The backend caps /api/plaid/transactions at 200 regardless of what's requested — fetching the
// max lets the Monthly Breakdown and Budget tab drill-downs (both filtered client-side from this
// same in-memory list) cover as much history as the API allows, rather than the default 50.
const TRANSACTIONS_FETCH_LIMIT = 200;

/**
 * The current lifecycle's own `getUserPreferences()` outcome — distinct from the general `loading`
 * flag (set by every refreshAll() call, including ones unrelated to auth, like PlaidLink's
 * onLinked) and distinct from "not yet resolved" vs "resolved but failed." Tagged with the
 * sessionId it was fetched under (see `preferencesStatus`'s derivation in App) using the same
 * currentGenerationValue mechanism as navLayoutRaw already uses — a pure, per-render
 * derivation, so a lifecycle change is reflected the instant sessionId itself changes, with no
 * effect-timing gap where a stale outcome could still read as current for even one render.
 */
export type PreferencesFetchOutcome = { status: 'ready'; payload: UserPreferences } | { status: 'error' };

// The one Navigation write coordinator for this browser tab — a genuine module-level singleton,
// constructed exactly once when this module is first evaluated, not inside the `App` component
// function. This is deliberate, not merely a style choice: a `useRef`-scoped instance living
// inside `App` would only actually survive for as long as one `App` component *instance* does — if
// `App` were ever unmounted and a new one mounted within the same page, a fresh `useRef` would
// silently construct a second, competing coordinator with no memory of the first one's in-flight or
// queued work, quietly breaking the documented "at most one write on the wire per tab" guarantee.
// A module-level constant has no such gap: this module is only ever evaluated once per realm (ES
// module semantics), so every `NavLayoutScope` mount — across every `App` instance this page ever
// creates — attaches to the exact same object. Exported so App.integration.test.tsx can exercise
// this exact instance directly for the coordinator-lifetime regression tests, rather than a
// same-shaped copy. See lib/navigationWriteCoordinator.ts's own doc comment for the full guarantee.
export const navigationWriteCoordinator = new NavigationWriteCoordinator({
  save: (layout, verify) => updateNavLayout({ tabs: layout }, verify),
});

/**
 * Scopes useNavLayout's layout/status state and its attachment to the shared
 * `NavigationWriteCoordinator` to exactly one authenticated login lifecycle. App.tsx renders this
 * keyed by Supabase's own `session_id` JWT claim (`<NavLayoutScope key={sessionId} ...>`), so
 * whenever that changes, React unmounts the previous instance (running useNavLayout's real
 * `useLayoutEffect` cleanup — a disposal that happens at a committed, irreversible point, never
 * during a render that might be abandoned) and mounts a brand-new one with fresh initial state. A
 * fresh mount never has the previous lifecycle's data to begin with, so there is no window — not
 * even a single frame — where one lifecycle's layout could render under a different one.
 *
 * Only this hook's own state is scoped this way — every other piece of App's state (items,
 * transactions, etc.) intentionally keeps living in the outer, unkeyed App component, exactly as
 * it did before. Dashboard Layout, Appearance, Financial Preferences, and Reporting Range get the
 * same keyed-scope treatment via the sibling `PreferencesScope` below, for the same reason. A
 * render-prop (`children`) is used instead of threading the rest of App's local state through as
 * a long, separate prop list — the function passed as `children` is defined inline inside App's
 * own render body, so it already has ordinary closure access to everything else App owns
 * (activeTab, items, handlers, ...) without this component needing to know about any of it.
 */
export function NavLayoutScope({
  userId,
  sessionId,
  isSessionCurrent,
  coordinator,
  saved,
  children,
}: {
  userId: string | null;
  sessionId: string;
  isSessionCurrent: (sessionId: string) => boolean;
  coordinator: NavigationWriteCoordinator;
  saved: NavLayoutEntry[] | null | undefined;
  children: (navLayout: ReturnType<typeof useNavLayout>) => ReactNode;
}) {
  // `userId`/`sessionId` are fixed for this mount's entire lifetime (a change to either would
  // remount this component via its key). `verifyOwnership` is reconstructed every render but every
  // version is functionally identical — see useNavLayout's own doc comment for why that's safe —
  // and checks three things in order: the *returned* session's user id, the *returned* session's
  // own decoded session_id compared directly against this mount's immutable `sessionId` (not
  // against any ambient/committed React state — this is what closes the pre-React-commit hole:
  // even if React hasn't yet processed a newer sign-in, a session object Supabase actually hands
  // back for a superseded lifecycle will decode to a different session_id and fail here
  // regardless), and finally the ambient `isSessionCurrent` check as additional, independently-
  // sourced defense-in-depth (see lib/authGeneration.ts's shouldApplyAuthEvent comment for why
  // this can only make the check stricter, never more permissive). Checked by lib/api.ts's
  // authedFetch at the moment a save is actually about to be sent, including its clock-skew retry.
  const verifyOwnership = (session: Session) =>
    session.user.id === userId && decodeSessionId(session.access_token) === sessionId && isSessionCurrent(sessionId);
  const navLayout = useNavLayout(userId, sessionId, coordinator, verifyOwnership, saved);
  return <>{children(navLayout)}</>;
}

/**
 * Scopes the four "older" preference hooks — Dashboard Layout, Appearance, Financial Preferences
 * (including the Safe-to-Spend toggles), and Reporting Range — and their lifecycle-sensitive
 * internal state (each hook's own one-shot hydration ref, plus useAppearance's and
 * useFinancialPreferences's own SaveStatusTracker instance) to exactly one authenticated login
 * lifecycle. Mirrors `NavLayoutScope` above exactly, for exactly the same reason: App.tsx renders
 * this keyed by Supabase's own `session_id` JWT claim (`<PreferencesScope key={sessionId} ...>`),
 * so whenever that changes, React unmounts the previous instance and mounts a brand-new one with
 * fresh initial state for all four hooks.
 *
 * This closes the authenticated-lifecycle isolation defects a standalone audit found: these four
 * hooks used to live directly in `App`, which never unmounts across auth transitions (A -> B,
 * A1 -> A3, or a plain logout/login) — so each hook's one-shot `hydrated` ref only ever hydrated
 * once *ever* per page load, and a later `getUserPreferences()` fetch for a different user, or
 * the same user's new session, was silently ignored, leaving the previous lifecycle's dashboard
 * layout, theme, financial preferences, and reporting range visible — and, on the next edit,
 * persisted — under the new one. Once this scope itself remounts per lifecycle, that same
 * one-shot hydration ref becomes exactly right: a fresh mount always starts unhydrated, so there
 * is no window where a stale lifecycle's preferences could ever be shown or persisted over a
 * newer one's.
 *
 * `saved` is the whole `getUserPreferences()` payload — already rejected by App.tsx's own
 * session-id-tagged derivation (`preferencesForCurrentSession`, built with
 * lib/authGeneration.ts's currentGenerationValue, the exact mechanism Navigation's own
 * `navLayoutRawForCurrentSession` already uses) if it doesn't belong to the *current* lifecycle.
 * That closes the sibling race this scope's remount alone cannot: "A's fetch starts, logout, B
 * logs in, B's fetch completes, A's fetch resolves last" — A's late response is tagged with A's
 * own sessionId, so the derivation discards it regardless of arrival order, and it never reaches
 * these hooks even if B's scope hasn't remounted yet by the time it resolves.
 *
 * `verifyOwnership` mirrors NavLayoutScope's exactly: the *returned* session's user id, the
 * *returned* session's own decoded session_id compared directly against this mount's immutable
 * `sessionId`, and the ambient `isSessionCurrent` check as additional defense-in-depth. Every
 * save from any of the four hooks is bound to it, checked by lib/api.ts's authedFetch immediately
 * before the write is actually sent — including on its clock-skew retry.
 *
 * Deliberately narrow, per the remediation's own scope: only these four hooks live here.
 * `activeTab`, `items`, `transactions`, `summary`/`netWorthHistory`/`monthlyBreakdown`, and every
 * other piece of App's state stay in the outer, unkeyed `App` component exactly as they did
 * before. None of these four preferences has a write queue (unlike Navigation), so this — scope-
 * level hydration reset plus per-save request-time ownership — is the whole mechanism required;
 * this does not introduce a coordinator or attachment-id system.
 *
 * `status` (App's `preferencesStatus`, derived from `PreferencesFetchOutcome`) governs whether
 * `saved` is even meaningfully populated: it's `undefined` for both `'loading'` and `'error'`, and
 * only the current lifecycle's actual payload for `'ready'`. Passed straight through to `children`
 * — this component doesn't decide what to render for a non-ready status (that's App's call, since
 * it owns the copy/retry UI), it just guarantees the four hooks never hydrate from, and their
 * controls are therefore never reachable against, anything but a fully-arrived current-lifecycle
 * payload. This is what actually prevents "edit before hydration": until `status === 'ready'`,
 * `saved` stays `undefined`, so every hook stays at its pre-hydration default and — because App's
 * JSX doesn't render the interactive controls at all before `'ready'` — there is no control in the
 * DOM capable of persisting that default as if it were authoritative.
 */
export function PreferencesScope({
  userId,
  sessionId,
  isSessionCurrent,
  status,
  saved,
  onReportingRangeReady,
  children,
}: {
  userId: string | null;
  sessionId: string;
  isSessionCurrent: (sessionId: string) => boolean;
  status: 'loading' | 'ready' | 'error';
  saved: UserPreferences | undefined;
  onReportingRangeReady: (range: ReportingRangeId) => void;
  children: (prefs: {
    status: 'loading' | 'ready' | 'error';
    dashboardLayout: ReturnType<typeof useDashboardLayout>;
    appearance: ReturnType<typeof useAppearance>;
    financialPreferences: ReturnType<typeof useFinancialPreferences>;
    reportingRange: ReturnType<typeof useReportingRange>;
  }) => ReactNode;
}) {
  const verifyOwnership = (session: Session) =>
    session.user.id === userId && decodeSessionId(session.access_token) === sessionId && isSessionCurrent(sessionId);

  const dashboardLayout = useDashboardLayout(
    saved === undefined ? undefined : (saved.dashboard_layout?.cards ?? null),
    verifyOwnership
  );
  const appearance = useAppearance(
    saved === undefined ? undefined : { theme: saved.theme, accent_color: saved.accent_color },
    verifyOwnership
  );
  const financialPreferences = useFinancialPreferences(
    saved === undefined
      ? undefined
      : {
          minimum_cash_buffer: saved.minimum_cash_buffer,
          upcoming_bills_days: saved.upcoming_bills_days,
          recent_avg_months: saved.recent_avg_months,
          savings_rate_target: saved.savings_rate_target,
          safe_to_spend_include_upcoming_bills: saved.safe_to_spend_include_upcoming_bills,
          safe_to_spend_include_remaining_budget: saved.safe_to_spend_include_remaining_budget,
        },
    verifyOwnership
  );
  const reportingRange = useReportingRange(
    saved === undefined ? undefined : saved.reporting_range,
    verifyOwnership,
    onReportingRangeReady
  );

  return <>{children({ status, dashboardLayout, appearance, financialPreferences, reportingRange })}</>;
}

export default function App() {
  // `{ session, sessionId }` as one atomic unit, and the bootstrap/live-event wiring that produces
  // it (including the StrictMode/unmount-safe invalidation guard) — see hooks/useAuthSession.ts's
  // own doc comment. `sessionId` is Supabase's own `session_id` JWT claim, the authoritative
  // identity for one continuous login lifecycle (stable across that login's own token refreshes,
  // distinct for every actual sign-in) — not a client-side reconstruction.
  const { session, sessionId } = useAuthSession();
  const [activeTab, setActiveTab] = useState('overview');
  const [items, setItems] = useState<LinkedItem[]>([]);
  const [isSandbox, setIsSandbox] = useState(false);
  const [transactions, setTransactions] = useState<TransactionItem[]>([]);
  const [budgetCategories, setBudgetCategories] = useState<BudgetCategory[]>([]);
  const [summary, setSummary] = useState<SpendingSummary | null>(null);
  const [netWorthHistory, setNetWorthHistory] = useState<NetWorthPoint[]>([]);
  const [monthlyBreakdown, setMonthlyBreakdown] = useState<MonthBreakdown[]>([]);
  const [recurringStreams, setRecurringStreams] = useState<RecurringStream[]>([]);
  const [totalMonthlyOutflow, setTotalMonthlyOutflow] = useState(0);
  const [totalMonthlyInflow, setTotalMonthlyInflow] = useState(0);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [totalDebt, setTotalDebt] = useState(0);
  const [totalMinimumPayment, setTotalMinimumPayment] = useState(0);
  const [manualLoans, setManualLoans] = useState<ManualLoan[]>([]);
  const [assetGroups, setAssetGroups] = useState<AssetGroup[]>([]);
  const [totalAssets, setTotalAssets] = useState(0);
  const [categoryMappings, setCategoryMappings] = useState<CategoryMapping[]>([]);
  const [plaidCategories, setPlaidCategories] = useState<string[]>([]);
  const [navLayoutRaw, setNavLayoutRaw] = useState<NavLayoutEntry[] | null | undefined>(undefined);
  // Tags navLayoutRaw with the sessionId it was fetched under — see the derivation below and
  // lib/authGeneration.ts's currentGenerationValue. This is what lets a fetch response prove it
  // belongs to the *current* authenticated lifecycle, not merely the current user id.
  const [navLayoutRawSessionId, setNavLayoutRawSessionId] = useState<string | undefined>(undefined);
  // The current lifecycle's own getUserPreferences() outcome for PreferencesScope's four hooks
  // (Dashboard Layout, Appearance, Financial Preferences, Reporting Range) — undefined until the
  // first fetch for the current lifecycle *settles, one way or the other*. Tagged with
  // `preferencesOutcomeSessionId` for exactly the same reason navLayoutRaw is: see
  // `preferencesStatus`/`preferencesForCurrentSession`'s derivation below.
  const [preferencesOutcome, setPreferencesOutcome] = useState<PreferencesFetchOutcome | undefined>(undefined);
  const [preferencesOutcomeSessionId, setPreferencesOutcomeSessionId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const userId = session?.user.id ?? null;

  // Mirrors sessionId for reads from inside async closures (refreshAll's own capture below, and
  // NavLayoutScope's/PreferencesScope's isSessionCurrent) that must see the *latest* value at the
  // moment they actually run, not whatever was current when they were defined. Updated in
  // useLayoutEffect, not during render: a render-phase write here would be a mutation an
  // abandoned/superseded concurrent render could leave behind even though React never committed
  // it, letting the ref represent a lifecycle nothing on screen actually reflects.
  // useLayoutEffect only ever runs for a render React actually committed, and — because it runs
  // synchronously, before the browser can paint or any pending microtask (like an in-flight
  // authedFetch's session-lookup continuation) can resume — this write always completes before
  // anything async could possibly read a stale value past the commit that produced it. This is
  // deliberately kept as an *additional* check alongside each scope's direct, returned-session
  // comparison (see their own doc comments) — never the only one.
  const sessionIdRef = useRef(sessionId);
  useLayoutEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const isSessionCurrent = useCallback((id: string) => sessionIdRef.current === id, []);

  // Mirrors PreferencesScope's own useReportingRange for the handful of App-level call sites
  // (refreshAll's initial fetch of range-dependent data, and the account/transaction handlers
  // further down) that need "whatever range is current" without themselves living inside that
  // scope. Written only by applyReportingRange below, itself only ever called from
  // PreferencesScope's onReportingRangeReady — see that function's own comment for why refreshAll
  // no longer reads or fetches by range at all.
  const reportingRangeRef = useRef<ReportingRangeId>(DEFAULT_REPORTING_RANGE);

  // A single tab-wide monotonically increasing counter — the ownership tag for the three
  // reporting-range-parameterized datasets (summary/netWorthHistory/monthlyBreakdown). Every call
  // to applyReportingRange (a lifecycle's first hydration, a user's range change, a post-Plaid-link
  // refresh, or a preferences Retry that leads to one) mints a new, strictly higher id and hands it
  // to that call's three fetches; each fetch's own `.then` only commits its result if its id is
  // still the *latest* one issued at the moment it resolves (see refreshSummary et al. below). This
  // one comparison subsumes both session and range ownership: a response tagged with an id that's
  // been superseded by ANY later call — whether that call came from a new lifecycle, a new range,
  // or simply a newer same-range retry — can never win, regardless of network arrival order. Never
  // reset per lifecycle (doesn't need to be — "still the latest" is well-defined across lifecycle
  // boundaries too, and resetting would only reintroduce a coordination question this design
  // otherwise avoids entirely).
  const rangeDataRequestIdRef = useRef(0);

  // Only usable if it was actually fetched under the sessionId that's current *right now* — a
  // pure, per-render derivation (no mutation, no effect-ordering dependency) rather than a
  // separate "clear the old value" step, which would need to run before NavLayoutScope's own
  // first render for the new lifecycle to avoid a stale hydration, and effect ordering (children
  // fire before parents) can't guarantee that. See lib/authGeneration.ts's currentGenerationValue.
  const navLayoutRawForCurrentSession = currentGenerationValue(navLayoutRaw, navLayoutRawSessionId, sessionId);
  // Same mechanism, applied to the current lifecycle's own preferences-fetch *outcome* rather than
  // just its payload — this is what lets App distinguish "no outcome tagged with the current
  // sessionId yet" (still loading) from "tagged, and it was a failure" (error) from "tagged, and it
  // succeeded" (ready), instead of collapsing the first two into one undifferentiated `undefined`
  // the way a plain payload-only tag would. A stale outcome tagged with an old sessionId — success
  // or failure — reads as `undefined` here exactly like navLayoutRaw's equivalent does, so it can
  // never mark a newer lifecycle "ready" or "errored" on its behalf.
  const preferencesOutcomeForCurrentSession = currentGenerationValue(
    preferencesOutcome,
    preferencesOutcomeSessionId,
    sessionId
  );
  const preferencesStatus: 'loading' | 'ready' | 'error' = preferencesOutcomeForCurrentSession?.status ?? 'loading';
  const preferencesForCurrentSession =
    preferencesOutcomeForCurrentSession?.status === 'ready' ? preferencesOutcomeForCurrentSession.payload : undefined;

  const refreshAll = useCallback(async () => {
    // Tags this fetch with the sessionId it was made under — see the setNavLayoutRawSessionId/
    // setPreferencesRawSessionId calls below and lib/authGeneration.ts's currentGenerationValue,
    // which is what actually decides whether the result is ever usable. Comparing bare user ids
    // here would not be enough: "A1 -> logout -> A3" must still reject A1's late response, even
    // though its user id matches A3's just as well.
    const requestedForSessionId = sessionIdRef.current;
    setLoading(true);
    // allSettled rather than all — one endpoint failing (e.g. a pending migration) shouldn't
    // blank the entire dashboard when the other calls succeeded fine. Deliberately excludes the
    // three reporting-range-parameterized calls (spending summary, net worth history, monthly
    // breakdown) — those are owned by applyReportingRange below, driven by PreferencesScope's own
    // useReportingRange, so a plain lifecycle refresh here never has to guess at a range before
    // that scope has had a chance to hydrate it.
    const [
      itemsRes,
      transactionsRes,
      categoriesRes,
      recurringRes,
      loansRes,
      assetsRes,
      manualLoansRes,
      categoryMappingsRes,
      plaidCategoriesRes,
      userPreferencesRes,
    ] = await Promise.allSettled([
      getLinkedItems(),
      getTransactions(TRANSACTIONS_FETCH_LIMIT),
      getBudgetCategories(),
      getRecurringStreams(),
      getLoans(),
      getAssetsSummary(),
      getManualLoans(),
      getCategoryMappings(),
      getPlaidCategories(),
      getUserPreferences(),
    ]);

    if (itemsRes.status === 'fulfilled') {
      setItems(itemsRes.value.items);
      setIsSandbox(itemsRes.value.is_sandbox);
    }
    if (transactionsRes.status === 'fulfilled') setTransactions(transactionsRes.value.transactions);
    if (categoriesRes.status === 'fulfilled') setBudgetCategories(categoriesRes.value.categories);
    if (recurringRes.status === 'fulfilled') {
      setRecurringStreams(recurringRes.value.streams);
      setTotalMonthlyOutflow(recurringRes.value.total_monthly_outflow);
      setTotalMonthlyInflow(recurringRes.value.total_monthly_inflow);
    }
    if (loansRes.status === 'fulfilled') {
      setLoans(loansRes.value.loans);
      setTotalDebt(loansRes.value.total_debt);
      setTotalMinimumPayment(loansRes.value.total_minimum_payment);
    }
    if (assetsRes.status === 'fulfilled') {
      setAssetGroups(assetsRes.value.groups);
      setTotalAssets(assetsRes.value.total_assets);
    }
    if (manualLoansRes.status === 'fulfilled') setManualLoans(manualLoansRes.value.loans);
    if (categoryMappingsRes.status === 'fulfilled') setCategoryMappings(categoryMappingsRes.value.mappings);
    if (plaidCategoriesRes.status === 'fulfilled') setPlaidCategories(plaidCategoriesRes.value.categories);
    // Tagged, not gated: writing this unconditionally is safe because nothing ever *reads*
    // navLayoutRaw/preferencesOutcome directly — only navLayoutRawForCurrentSession's and
    // preferencesOutcomeForCurrentSession's derivations do, and both already refuse any value
    // whose tagged sessionId doesn't match whatever is current by the time it's read, regardless
    // of how this write is timed relative to that (including a genuinely stale fetch — "A starts,
    // logout, B logs in, A resolves last" — resolving after this point). Written for BOTH outcomes
    // (not just success) — an explicit 'error' outcome is what lets preferencesStatus distinguish
    // "still loading" from "this lifecycle's fetch actually failed," which a payload-only tag
    // (undefined either way on failure) could not.
    if (requestedForSessionId) {
      setPreferencesOutcome(
        userPreferencesRes.status === 'fulfilled'
          ? { status: 'ready', payload: userPreferencesRes.value }
          : { status: 'error' }
      );
      setPreferencesOutcomeSessionId(requestedForSessionId);
    }
    if (userPreferencesRes.status === 'fulfilled') {
      setNavLayoutRaw(userPreferencesRes.value.nav_layout?.tabs ?? null);
      if (requestedForSessionId) setNavLayoutRawSessionId(requestedForSessionId);
    }

    // Whether THIS call's own lifecycle is still the one currently active — checked once, here,
    // right after the shared await, and used to gate the two remaining state writes below that
    // aren't already self-tagged the way preferencesOutcome/navLayoutRaw are: `loading` and
    // `actionError`. An old, now-superseded lifecycle's completion — success OR failure — must
    // never mark a newer lifecycle "finished loading," surface an old error into it, or clobber
    // whatever loading/error state that newer lifecycle's own, still-in-flight call is about to
    // establish. (The other per-dataset setters above — items, transactions, budgetCategories, and
    // so on — are intentionally left as they were: gating those too is a real, adjacent concern,
    // but it's outside this remediation's declared scope, same as the original audit's own
    // boundary around Categories/Accounts/Budgets/Plaid.)
    const stillCurrent = requestedForSessionId === sessionIdRef.current;

    const failures = [
      itemsRes,
      transactionsRes,
      categoriesRes,
      recurringRes,
      loansRes,
      assetsRes,
      manualLoansRes,
      categoryMappingsRes,
      plaidCategoriesRes,
      userPreferencesRes,
    ].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0 && stillCurrent) {
      console.error('Some dashboard data failed to load:', failures.map((f) => f.reason));
      setActionError('Some dashboard data failed to load — see console for details.');
    }

    if (stillCurrent) setLoading(false);
  }, []);

  useEffect(() => {
    // Keyed on `sessionId`, not `userId` and not `session` object identity. `session` gets a new
    // object reference on every auth event, including a duplicate re-emission of the same signed-
    // in user (e.g. on tab focus) or a routine token refresh — `sessionId` is unchanged by either,
    // so this doesn't spuriously re-fire for them. Keying on `userId` alone would miss a batched
    // same-user logout/login (A1 -> SIGNED_OUT -> SIGNED_IN A3): the *final* committed userId is
    // unchanged (still A), so a userId-keyed effect would never re-fire and Navigation/Preferences
    // would stay hydrated from A1's stale data — sessionId genuinely changes across that exact
    // transition, so this effect correctly re-fires and refetches for A3's own data.
    if (!sessionId) return;
    // Clears the three range-dependent display datasets the instant the lifecycle changes —
    // synchronously, in this same effect, before refreshAll's first async gap and therefore before
    // ANY of this new lifecycle's own data can possibly have arrived yet. Without this, the render
    // immediately after a lifecycle change (until preferencesStatus reaches 'ready' and this
    // scope's own useReportingRange hydrates and fires applyReportingRange — itself a couple of
    // renders further on) could otherwise still be holding the *previous* lifecycle's summary/
    // netWorthHistory/monthlyBreakdown values. `preferencesOutcome`/`navLayoutRaw`'s tagged derivations
    // don't need this (a stale tag simply reads as unusable) because their consumers only ever
    // render *derived* values; these three are plain, untagged state read directly by several
    // components, so the safe equivalent is to clear them outright rather than thread a tag through
    // every read site.
    setSummary(null);
    setNetWorthHistory([]);
    setMonthlyBreakdown([]);
    refreshAll();
  }, [sessionId, refreshAll]);

  // Best-effort — account/transaction refresh already succeeded by the time this runs, so a
  // failure here shouldn't surface as an error for an action the user didn't take. `range`
  // defaults to whatever PreferencesScope's useReportingRange last reported (see
  // applyReportingRange); `requestId` defaults to the current rangeDataRequestIdRef value, so
  // every existing caller below (which calls these with no arguments — an ordinary, non-range-
  // change refresh like "an account just synced") keeps working exactly as before while still
  // going through the same ownership check as an explicit applyReportingRange call. Only a commit
  // whose `requestId` is still the *latest* one issued (see rangeDataRequestIdRef's own comment) is
  // ever applied — this is what stops a late response for an old user, an old session, or an
  // already-superseded range/attempt from ever overwriting what's currently displayed.
  async function refreshSummary(
    range: ReportingRangeId = reportingRangeRef.current,
    requestId: number = rangeDataRequestIdRef.current
  ) {
    try {
      const res = await getSpendingSummary(range);
      if (requestId === rangeDataRequestIdRef.current) setSummary(res);
    } catch {
      // ignore — see rangeDataRequestIdRef's comment: a failed request for what is still the
      // current attempt leaves summary at whatever it already was (cleared on the last lifecycle
      // change, or a still-valid earlier value for this same lifecycle/range) rather than any
      // other lifecycle's data, so there is nothing unsafe to surface here.
    }
  }

  async function refreshNetWorthHistory(
    range: ReportingRangeId = reportingRangeRef.current,
    requestId: number = rangeDataRequestIdRef.current
  ) {
    try {
      const res = await getNetWorthHistory(range);
      if (requestId === rangeDataRequestIdRef.current) setNetWorthHistory(res.history);
    } catch {
      // ignore
    }
  }

  async function refreshMonthlyBreakdown(
    range: ReportingRangeId = reportingRangeRef.current,
    requestId: number = rangeDataRequestIdRef.current
  ) {
    try {
      const res = await getMonthlyBreakdown(range);
      if (requestId === rangeDataRequestIdRef.current) setMonthlyBreakdown(res.months);
    } catch {
      // ignore
    }
  }

  // The sole entry point for the three reporting-range-parameterized fetches (spending summary,
  // net worth history, monthly breakdown) — called from PreferencesScope's useReportingRange, via
  // its onReportingRangeReady prop, once when that scope's range first hydrates for this
  // lifecycle and again every time the user picks a new range; also called directly after a
  // successful Plaid link (see handlePlaidLinked) to refresh these three for the currently
  // selected range without re-running the range-hydration path. Deliberately *not* routed through
  // refreshAll: refreshAll now fires only on a genuine lifecycle change and fetches everything
  // range-independent, so a plain reporting-range change refreshes exactly these three datasets —
  // it never re-fetches (and, via the tagged preferencesOutcome, never re-hydrates) Dashboard
  // Layout, Appearance, or Financial Preferences, and a lifecycle change never has to fetch these
  // three twice (once at a stale/default range, once at the real one).
  function applyReportingRange(range: ReportingRangeId) {
    reportingRangeRef.current = range;
    const requestId = ++rangeDataRequestIdRef.current;
    refreshSummary(range, requestId);
    refreshNetWorthHistory(range, requestId);
    refreshMonthlyBreakdown(range, requestId);
  }

  async function refreshRecurringStreams() {
    try {
      const res = await getRecurringStreams();
      setRecurringStreams(res.streams);
      setTotalMonthlyOutflow(res.total_monthly_outflow);
      setTotalMonthlyInflow(res.total_monthly_inflow);
    } catch {
      // ignore
    }
  }

  async function refreshLoans() {
    try {
      const res = await getLoans();
      setLoans(res.loans);
      setTotalDebt(res.total_debt);
      setTotalMinimumPayment(res.total_minimum_payment);
    } catch {
      // ignore
    }
  }

  async function refreshAssetsSummary() {
    try {
      const res = await getAssetsSummary();
      setAssetGroups(res.groups);
      setTotalAssets(res.total_assets);
    } catch {
      // ignore
    }
  }

  // `spent`/`recent_avg_spent` are only computed on the list endpoint, not returned by the
  // create/update/categorize endpoints — anything that can change a category's spend needs to
  // refetch the list to stay accurate, rather than trying to patch the values in locally.
  async function refreshBudgetCategories() {
    try {
      const res = await getBudgetCategories();
      setBudgetCategories(res.categories);
    } catch {
      // ignore
    }
  }

  async function handleAccountsRefreshed(newItems: LinkedItem[]) {
    setItems(newItems);
    refreshSummary();
    // The backend records a net worth snapshot, refreshes loan/liability details, and this
    // view's grouping all depend on the same freshly-fetched balances — refetch all three.
    refreshNetWorthHistory();
    refreshLoans();
    refreshAssetsSummary();
  }

  async function handleUpdateCreditLimit(accountId: string, creditLimit: number | null) {
    setActionError(null);
    try {
      const res = await updateAccountCreditLimit(accountId, creditLimit);
      setItems((prev) =>
        prev.map((item) => ({
          ...item,
          accounts: item.accounts.map((a) => (a.id === accountId ? res.account : a)),
        }))
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update credit limit');
    }
  }

  async function handleUpdateSavingsGoal(accountId: string, savingsGoal: number | null) {
    setActionError(null);
    try {
      const res = await updateAccountSavingsGoal(accountId, savingsGoal);
      setAssetGroups((prev) =>
        prev.map((group) => ({
          ...group,
          accounts: group.accounts.map((a) =>
            a.id === accountId ? { ...a, savings_goal: res.account.savings_goal } : a
          ),
        }))
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update savings goal');
    }
  }

  async function handleUpdateAccountCustomization(
    accountId: string,
    fields: Partial<{
      nickname: string | null;
      color: string | null;
      icon: string | null;
      sort_order: number;
      hidden: boolean;
      exclude_from_net_worth: boolean;
      exclude_from_cash_flow: boolean;
    }>
  ) {
    setActionError(null);
    try {
      const res = await updateAccountCustomization(accountId, fields);
      setItems((prev) =>
        prev.map((item) => ({
          ...item,
          accounts: item.accounts.map((a) => (a.id === accountId ? res.account : a)),
        }))
      );
      // hidden/exclude_from_net_worth change which accounts appear in or count toward
      // assets-summary's grouped totals — simplest to refetch rather than hand-patch a
      // filtered, grouped structure locally.
      refreshAssetsSummary();
      if (fields.exclude_from_net_worth !== undefined) {
        // The backend already re-snapshotted today's net worth on this change — refresh the
        // live stat and the chart so both reflect it immediately, not just at the next sync.
        refreshSummary();
        refreshNetWorthHistory();
      }
      if (fields.exclude_from_cash_flow !== undefined) {
        refreshSummary();
        refreshBudgetCategories();
        refreshMonthlyBreakdown();
        refreshRecurringStreams();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update account');
    }
  }

  async function handleSyncTransactions() {
    setSyncing(true);
    setActionError(null);
    try {
      await syncTransactionsRequest();
      const res = await getTransactions(TRANSACTIONS_FETCH_LIMIT);
      setTransactions(res.transactions);
      refreshSummary();
      refreshBudgetCategories();
      refreshMonthlyBreakdown();
      // Recurring-stream detection is also refreshed server-side as part of every sync
      // (manual or webhook-driven) — refetch here so this tab reflects that without a reload.
      refreshRecurringStreams();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to sync transactions');
    } finally {
      setSyncing(false);
    }
  }

  async function handleCategorize(transactionId: string, budgetCategoryId: string | null) {
    setActionError(null);
    try {
      // The PATCH response is a bare `transactions` row with no joined accounts/plaid_items,
      // unlike the list endpoint — merge just the changed field instead of replacing the item.
      await setTransactionCategory(transactionId, budgetCategoryId);
      setTransactions((prev) =>
        prev.map((t) => (t.id === transactionId ? { ...t, budget_category_id: budgetCategoryId } : t))
      );
      refreshBudgetCategories();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update category');
    }
  }

  async function handleApproveTransaction(transactionId: string) {
    setActionError(null);
    try {
      await approveTransaction(transactionId);
      setTransactions((prev) =>
        prev.map((t) => (t.id === transactionId ? { ...t, needs_review: false } : t))
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to approve transaction');
    }
  }

  // Left to throw rather than setting actionError — SplitEditor catches this itself and shows
  // the message inline next to the line items, which is more useful than a page-level banner.
  async function handleSaveTransactionSplits(
    transactionId: string,
    splits: { budget_category_id: string; amount: number }[]
  ) {
    const res = await saveTransactionSplits(transactionId, splits);
    setTransactions((prev) => prev.map((t) => (t.id === transactionId ? { ...t, splits: res.splits } : t)));
    refreshBudgetCategories();
  }

  async function handleClearTransactionSplits(transactionId: string) {
    await clearTransactionSplits(transactionId);
    setTransactions((prev) => prev.map((t) => (t.id === transactionId ? { ...t, splits: [] } : t)));
    refreshBudgetCategories();
  }

  async function handleCreateCategory(
    name: string,
    budgetAmount: number,
    emoji: string | null,
    color: string | null
  ) {
    setActionError(null);
    try {
      const res = await createBudgetCategory({ name, budget_amount: budgetAmount, emoji, color });
      // A brand-new category has no transactions assigned to it yet, so both derived fields
      // are always 0 — no need to refetch just to fill in values we already know.
      setBudgetCategories((prev) => [...prev, { ...res.category, spent: 0, recent_avg_spent: 0 }]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create category');
    }
  }

  async function handleUpdateCategory(id: string, budgetAmount: number) {
    setActionError(null);
    try {
      const res = await updateBudgetCategory(id, { budget_amount: budgetAmount });
      // Merge rather than replace — the response has no spent/recent_avg_spent, and changing
      // budget_amount doesn't change how much has actually been spent, so keep what's there.
      setBudgetCategories((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...res.category } : c))
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update category');
    }
  }

  async function handleUpdateCategoryEmoji(id: string, emoji: string | null) {
    setActionError(null);
    try {
      const res = await updateBudgetCategory(id, { emoji });
      setBudgetCategories((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...res.category } : c))
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update category emoji');
    }
  }

  async function handleUpdateCategoryColor(id: string, color: string | null) {
    setActionError(null);
    try {
      const res = await updateBudgetCategory(id, { color });
      setBudgetCategories((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...res.category } : c))
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update category color');
    }
  }

  async function handleReorderCategory(id: string, sortOrder: number) {
    setActionError(null);
    try {
      const res = await updateBudgetCategory(id, { sort_order: sortOrder });
      setBudgetCategories((prev) =>
        prev.map((c) => (c.id === id ? { ...c, ...res.category } : c))
      );
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to reorder categories');
    }
  }

  async function handleArchiveCategory(id: string) {
    setActionError(null);
    try {
      const res = await updateBudgetCategory(id, { archived: true });
      setBudgetCategories((prev) => prev.map((c) => (c.id === id ? { ...c, ...res.category } : c)));
      // Archiving removes any mapping that targeted this category server-side (so future synced
      // transactions stop landing here) — drop those from local state too, without a refetch.
      if (res.removed_mapping_ids && res.removed_mapping_ids.length > 0) {
        const removed = new Set(res.removed_mapping_ids);
        setCategoryMappings((prev) => prev.filter((m) => !removed.has(m.id)));
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to archive category');
    }
  }

  async function handleUnarchiveCategory(id: string) {
    setActionError(null);
    try {
      const res = await updateBudgetCategory(id, { archived: false });
      setBudgetCategories((prev) => prev.map((c) => (c.id === id ? { ...c, ...res.category } : c)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to unarchive category');
    }
  }

  async function handleSaveCategoryMapping(
    plaidCategory: string,
    budgetCategoryId: string,
    backfill: boolean
  ): Promise<number> {
    setActionError(null);
    try {
      const res = await saveCategoryMapping(plaidCategory, budgetCategoryId, backfill);
      setCategoryMappings((prev) => [...prev.filter((m) => m.plaid_category !== plaidCategory), res.mapping]);
      if (backfill && res.backfilled_count > 0) {
        // Backfilling updates transaction rows directly in the database — refetch so the
        // Accounts and Budget tabs reflect the newly-assigned categories.
        const transactionsRes = await getTransactions(TRANSACTIONS_FETCH_LIMIT);
        setTransactions(transactionsRes.transactions);
        refreshBudgetCategories();
      }
      return res.backfilled_count;
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to save category mapping');
      throw err;
    }
  }

  async function handleDeleteCategoryMapping(id: string) {
    setActionError(null);
    try {
      await deleteCategoryMapping(id);
      setCategoryMappings((prev) => prev.filter((m) => m.id !== id));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to remove category mapping');
    }
  }

  async function handleCreateManualLoan(input: ManualLoanInput) {
    setActionError(null);
    try {
      const res = await createManualLoan(input);
      setManualLoans((prev) => [...prev, res.loan]);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add loan');
    }
  }

  async function handleUpdateManualLoan(id: string, input: ManualLoanInput) {
    setActionError(null);
    try {
      const res = await updateManualLoan(id, input);
      setManualLoans((prev) => prev.map((l) => (l.id === id ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update loan');
    }
  }

  async function handleDeleteManualLoan(id: string) {
    setActionError(null);
    try {
      await deleteManualLoan(id);
      setManualLoans((prev) => prev.filter((l) => l.id !== id));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete loan');
    }
  }

  async function handleFetchPayments(loanId: string): Promise<LoanPayment[]> {
    const res = await getLoanPayments(loanId);
    return res.payments;
  }

  async function handleUpdateLinkedPayment(loanId: string, transactionId: string, principalPortion: number) {
    setActionError(null);
    try {
      const res = await updateLinkedLoanPayment(loanId, transactionId, principalPortion);
      setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update payment');
      throw err;
    }
  }

  async function handleUnlinkPayment(loanId: string, transactionId: string) {
    setActionError(null);
    try {
      const res = await unlinkLoanPayment(loanId, transactionId);
      setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to unlink payment');
      throw err;
    }
  }

  async function handleCreateManualPayment(loanId: string, input: ManualPaymentInput) {
    setActionError(null);
    try {
      const res = await createManualPayment(loanId, input);
      setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to log payment');
      throw err;
    }
  }

  async function handleUpdateManualPayment(loanId: string, paymentId: string, input: ManualPaymentInput) {
    setActionError(null);
    try {
      const res = await updateManualPayment(loanId, paymentId, input);
      setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update payment');
      throw err;
    }
  }

  async function handleDeleteManualPayment(loanId: string, paymentId: string) {
    setActionError(null);
    try {
      const res = await deleteManualPayment(loanId, paymentId);
      setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete payment');
      throw err;
    }
  }

  // Active-only view for anything that budgets/selects going forward (remaining-budget math, the
  // mapping target list) — components that need to resolve or offer an already-archived category
  // (transaction/split editing, the Budget tab's own archived section) keep receiving the full
  // budgetCategories array and decide per-row whether to surface it.
  const activeBudgetCategories = budgetCategories.filter((c) => c.archived_at === null);

  // A successful Plaid link changes account balances, which can change every one of the three
  // range-dependent datasets (spending summary, net worth history, monthly breakdown) — refreshAll
  // alone no longer covers them (see applyReportingRange's own comment for why they were split
  // out), so this refreshes both halves explicitly: the ordinary account/transaction/preferences
  // batch refreshAll already owns, and the three range-dependent datasets for whatever range is
  // currently selected, via the same applyReportingRange pathway a user's own range change uses —
  // no duplicated fetch/calculation logic, and the same request-id ownership protection applies
  // automatically (a fresh id is minted for this call, so it can never be overtaken by, or
  // overtake, an unrelated in-flight range fetch). Fired without awaiting refreshAll first:
  // applyReportingRange only needs reportingRangeRef.current, which is already whatever this
  // lifecycle's own useReportingRange last reported — it doesn't depend on this particular
  // refreshAll call's own results.
  function handlePlaidLinked() {
    refreshAll();
    applyReportingRange(reportingRangeRef.current);
  }

  if (!session) {
    return <Auth />;
  }

  return (
    <div className="dashboard">
      <header className="app-header">
        <h1>My Finances</h1>
        <div className="app-header-actions">
          <PlaidLink onLinked={handlePlaidLinked} />
          <button className="link-button" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {actionError && <p className="error">{actionError}</p>}

      {/* NavLayoutScope/PreferencesScope both sit outside the loading check deliberately: loading
          is a general "some data fetch is in flight" flag (set by every refreshAll() call,
          including ones with nothing to do with authentication, e.g. PlaidLink's onLinked) — it
          must only ever affect what's rendered *inside* each authenticated scope, never whether
          those scopes exist. Only `key={sessionId}` controls that. sessionId! below: this JSX
          only renders once the earlier `!session` early return has already confirmed we're
          authenticated, and `session`/`sessionId` are always set together, atomically, by the
          same reducer action — TypeScript just can't see that correlation across two destructured
          fields. */}
      <NavLayoutScope
        key={sessionId!}
        userId={userId}
        sessionId={sessionId!}
        isSessionCurrent={isSessionCurrent}
        coordinator={navigationWriteCoordinator}
        saved={navLayoutRawForCurrentSession}
      >
        {(navLayout) => (
          <PreferencesScope
            key={sessionId!}
            userId={userId}
            sessionId={sessionId!}
            isSessionCurrent={isSessionCurrent}
            status={preferencesStatus}
            saved={preferencesForCurrentSession}
            onReportingRangeReady={applyReportingRange}
          >
            {({ status: prefsStatus, dashboardLayout, appearance, financialPreferences, reportingRange }) => {
              // `loading` covers the ordinary account/transaction/etc batch; `prefsStatus ===
              // 'loading'` covers this lifecycle's own preferences fetch specifically — the two
              // together should overlap in the common case (refreshAll sets both `loading` and
              // preferencesOutcome from the same batch), but checking both directly is what keeps
              // this correct even if that overlap were ever imperfect, rather than relying on it.
              // Nothing preference-dependent (or otherwise, since this gates the whole authenticated
              // content area) renders while either is true — see PreferencesScope's own doc comment
              // for why this, not merely ownership-checked saves, is what actually prevents editing
              // a default/cached value as if it were this lifecycle's real, authoritative one.
              if (loading || prefsStatus === 'loading') return <p className="hint">Loading...</p>;
              if (prefsStatus === 'error') {
                return (
                  <p className="error">
                    Couldn't load your preferences.{' '}
                    <button type="button" className="link-button" onClick={() => refreshAll()}>
                      Retry
                    </button>
                  </p>
                );
              }
              // The current web/PWA's own decision about primary-tab-bar order (Overview first,
              // Settings last) — see lib/webTabNav.ts. Recomputed on every render of this
              // render-prop; cheap, and avoids a second piece of state that could drift from
              // navLayout.layout.
              const TABS = buildWebTabList(getVisibleOrderedTabIds(navLayout.layout));

              // Card components know nothing about customization — this is the one place that
              // maps a card id to what it actually renders, preserving each card's existing
              // data-availability guard (e.g. `stats` needs `summary`) exactly as it worked
              // before dashboard customization existed. Defined inside this render-prop (rather
              // than at App's top level) purely so it can close over `financialPreferences`,
              // which now lives in PreferencesScope; every other value it uses (summary,
              // netWorthHistory, assetGroups, ...) is unchanged App-level state.
              function renderOverviewCard(id: CardId) {
                switch (id) {
                  case 'stats':
                    return summary ? (
                      <OverviewStats
                        netWorth={summary.net_worth}
                        netWorthHistory={netWorthHistory}
                        assetGroups={assetGroups}
                        monthlySpending={summary.monthly_spending}
                      />
                    ) : null;
                  case 'safe_to_spend':
                    return (
                      <SafeToSpend
                        assetGroups={assetGroups}
                        recurringStreams={recurringStreams}
                        loans={loans}
                        manualLoans={manualLoans}
                        budgetCategories={activeBudgetCategories}
                        upcomingBillsDays={financialPreferences.upcomingBillsDays}
                        minimumCashBuffer={financialPreferences.minimumCashBuffer}
                        includeUpcomingBills={financialPreferences.includeUpcomingBills}
                        includeRemainingBudget={financialPreferences.includeRemainingBudget}
                      />
                    );
                  case 'cash_flow_pace':
                    return summary ? (
                      <CashFlowPace
                        budgetCategories={activeBudgetCategories}
                        currentMonthIncome={summary.current_month.income}
                        currentMonthSpent={summary.current_month.spent}
                      />
                    ) : null;
                  case 'accounts_quick_view':
                    return <AccountQuickView assetGroups={assetGroups} />;
                  case 'upcoming_bills':
                    return (
                      <UpcomingBills
                        recurringStreams={recurringStreams}
                        loans={loans}
                        manualLoans={manualLoans}
                        daysAhead={financialPreferences.upcomingBillsDays}
                      />
                    );
                  case 'recent_activity':
                    return (
                      <RecentActivity
                        transactions={transactions}
                        budgetCategories={budgetCategories}
                        onViewAll={() => setActiveTab('accounts')}
                      />
                    );
                  case 'monthly_spending_chart':
                    return summary ? <MonthlySpendingChart summary={summary} /> : null;
                  case 'net_worth_chart':
                    return <NetWorthChart history={netWorthHistory} />;
                  default:
                    return null;
                }
              }

              return (
                <>
                  <TabNav tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

                  {activeTab === 'overview' && (
                    <div className="tab-panel">
                      <div className="section-header overview-header">
                        <span className="hint">Overview</span>
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => dashboardLayout.setCustomizing(true)}
                        >
                          Customize dashboard
                        </button>
                      </div>

                      {!dashboardLayout.customizing &&
                        dashboardLayout.layout.some(
                          (c) => c.visible && (c.id === 'monthly_spending_chart' || c.id === 'net_worth_chart')
                        ) && (
                          <ReportingRangeSelector range={reportingRange.range} onChange={reportingRange.setRange} />
                        )}

                      {dashboardLayout.customizing ? (
                        <DashboardCustomizer
                          layout={dashboardLayout.layout}
                          onToggleVisibility={dashboardLayout.toggleVisibility}
                          onMove={dashboardLayout.move}
                          onApplyPreset={dashboardLayout.applyPreset}
                          onDone={() => dashboardLayout.setCustomizing(false)}
                        />
                      ) : (
                        groupCardsIntoRows(
                          dashboardLayout.layout.filter((c) => c.visible).map((c) => c.id)
                        ).map((row) =>
                          row.length === 2 ? (
                            <div className="dashboard-grid" key={row.join('+')}>
                              <div>{renderOverviewCard(row[0])}</div>
                              <div>{renderOverviewCard(row[1])}</div>
                            </div>
                          ) : (
                            <div key={row[0]}>{renderOverviewCard(row[0])}</div>
                          )
                        )
                      )}
                    </div>
                  )}

                  {activeTab === 'monthly' && (
                    <MonthlyBreakdown
                      months={monthlyBreakdown}
                      transactions={transactions}
                      reportingRange={reportingRange.range}
                      onSetReportingRange={reportingRange.setRange}
                    />
                  )}

                  {activeTab === 'budget' && (
                    <BudgetCategories
                      categories={budgetCategories}
                      transactions={transactions}
                      recentAvgMonths={financialPreferences.recentAvgMonths}
                      onCreate={handleCreateCategory}
                      onUpdate={handleUpdateCategory}
                      onUpdateEmoji={handleUpdateCategoryEmoji}
                      onUpdateColor={handleUpdateCategoryColor}
                      onReorder={handleReorderCategory}
                      onArchive={handleArchiveCategory}
                      onUnarchive={handleUnarchiveCategory}
                    />
                  )}

                  {activeTab === 'recurring' && (
                    <SubscriptionsRecurring
                      streams={recurringStreams}
                      totalMonthlyOutflow={totalMonthlyOutflow}
                      totalMonthlyInflow={totalMonthlyInflow}
                    />
                  )}

                  {activeTab === 'loans' && (
                    <LoanProgress
                      loans={loans}
                      manualLoans={manualLoans}
                      totalDebt={totalDebt}
                      totalMinimumPayment={totalMinimumPayment}
                      onCreateManualLoan={handleCreateManualLoan}
                      onUpdateManualLoan={handleUpdateManualLoan}
                      onDeleteManualLoan={handleDeleteManualLoan}
                      onFetchPayments={handleFetchPayments}
                      onUpdateLinkedPayment={handleUpdateLinkedPayment}
                      onUnlinkPayment={handleUnlinkPayment}
                      onCreateManualPayment={handleCreateManualPayment}
                      onUpdateManualPayment={handleUpdateManualPayment}
                      onDeleteManualPayment={handleDeleteManualPayment}
                    />
                  )}

                  {activeTab === 'income' && (
                    <IncomeSavings
                      groups={assetGroups}
                      totalAssets={totalAssets}
                      recurringStreams={recurringStreams}
                      currentMonthIncome={summary?.current_month.income ?? 0}
                      currentMonthSpent={summary?.current_month.spent ?? 0}
                      savingsRateTarget={financialPreferences.savingsRateTarget}
                      onUpdateSavingsGoal={handleUpdateSavingsGoal}
                    />
                  )}

                  {activeTab === 'accounts' && (
                    <div className="tab-panel">
                      <LinkedAccounts
                        items={items}
                        isSandbox={isSandbox}
                        onRefreshed={handleAccountsRefreshed}
                        onUpdateCreditLimit={handleUpdateCreditLimit}
                        onUpdateCustomization={handleUpdateAccountCustomization}
                      />
                      <TransactionsFeed
                        transactions={transactions}
                        budgetCategories={budgetCategories}
                        syncing={syncing}
                        onSync={handleSyncTransactions}
                        onCategorize={handleCategorize}
                        onApprove={handleApproveTransaction}
                        onSaveSplits={handleSaveTransactionSplits}
                        onClearSplits={handleClearTransactionSplits}
                      />
                    </div>
                  )}

                  {activeTab === 'settings' && (
                    <Settings
                      appearance={appearance}
                      financialPreferences={financialPreferences}
                      navLayout={navLayout}
                      categoryMappings={{
                        plaidCategories,
                        mappings: categoryMappings,
                        budgetCategories: activeBudgetCategories,
                        onSave: handleSaveCategoryMapping,
                        onDelete: handleDeleteCategoryMapping,
                      }}
                    />
                  )}
                </>
              );
            }}
          </PreferencesScope>
        )}
      </NavLayoutScope>
    </div>
  );
}
