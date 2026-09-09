import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from 'react';
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
  type DashboardCardEntry,
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
} from './lib/api';
import { authReducer, currentGenerationValue, initialAuthState, shouldApplyAuthEvent } from './lib/authGeneration';
import { groupCardsIntoRows, type CardId } from './lib/dashboardLayout';
import { decodeSessionId } from './lib/jwt';
import { getVisibleOrderedTabIds } from './lib/navLayout';
import { NavigationWriteCoordinator } from './lib/navigationWriteCoordinator';
import { buildWebTabList } from './lib/webTabNav';
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
 * transactions, appearance, financial preferences, etc.) intentionally keeps living in the outer,
 * unkeyed App component, exactly as it did before. A render-prop (`children`) is used instead of
 * threading the rest of App's local state through as a long, separate prop list — the function
 * passed as `children` is defined inline inside App's own render body, so it already has ordinary
 * closure access to everything else App owns (activeTab, items, handlers, ...) without this
 * component needing to know about any of it.
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

export default function App() {
  // `{ session, sessionId }` as one atomic unit — see lib/authGeneration.ts's authReducer.
  // `sessionId` is Supabase's own `session_id` JWT claim, the authoritative identity for one
  // continuous login lifecycle (stable across that login's own token refreshes, distinct for every
  // actual sign-in) — not a client-side reconstruction. Every AUTH_EVENT is reduced against the
  // true previous state, so session and sessionId can never be observed out of step with each
  // other in a committed render, even when two events (e.g. a same-user sign-out immediately
  // followed by a re-login) are dispatched back-to-back before React has a chance to paint an
  // intermediate frame — React still applies a useReducer's queued actions sequentially against
  // the real prior state before rendering the batched result.
  const [auth, dispatchAuth] = useReducer(authReducer, initialAuthState);
  const { session, sessionId } = auth;
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
  // undefined = not fetched yet, null = fetched but the user has never customized anything —
  // useDashboardLayout treats both as "use the default layout," it only matters for hydration timing.
  const [dashboardLayoutRaw, setDashboardLayoutRaw] = useState<DashboardCardEntry[] | null | undefined>(undefined);
  const [navLayoutRaw, setNavLayoutRaw] = useState<NavLayoutEntry[] | null | undefined>(undefined);
  // Tags navLayoutRaw with the sessionId it was fetched under — see the derivation below and
  // lib/authGeneration.ts's currentGenerationValue. This is what lets a fetch response prove it
  // belongs to the *current* authenticated lifecycle, not merely the current user id.
  const [navLayoutRawSessionId, setNavLayoutRawSessionId] = useState<string | undefined>(undefined);
  const [appearanceRaw, setAppearanceRaw] = useState<
    { theme: string; accent_color: string } | null | undefined
  >(undefined);
  const [financialPreferencesRaw, setFinancialPreferencesRaw] = useState<
    | {
        minimum_cash_buffer: number;
        upcoming_bills_days: number;
        recent_avg_months: number;
        savings_rate_target: number;
        safe_to_spend_include_upcoming_bills: boolean;
        safe_to_spend_include_remaining_budget: boolean;
      }
    | null
    | undefined
  >(undefined);
  const [reportingRangeRaw, setReportingRangeRaw] = useState<string | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const userId = session?.user.id ?? null;

  // Mirrors sessionId for reads from inside async closures (refreshAll's own capture below, and
  // NavLayoutScope's isSessionCurrent) that must see the *latest* value at the moment they
  // actually run, not whatever was current when they were defined. Updated in useLayoutEffect, not
  // during render: a render-phase write here would be a mutation an abandoned/superseded
  // concurrent render could leave behind even though React never committed it, letting the ref
  // represent a lifecycle nothing on screen actually reflects. useLayoutEffect only ever runs for
  // a render React actually committed, and — because it runs synchronously, before the browser can
  // paint or any pending microtask (like an in-flight authedFetch's session-lookup continuation)
  // can resume — this write always completes before anything async could possibly read a stale
  // value past the commit that produced it. This is deliberately kept as an *additional* check
  // alongside NavLayoutScope's direct, returned-session comparison (see its own doc comment) —
  // never the only one.
  const sessionIdRef = useRef(sessionId);
  useLayoutEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);
  const isSessionCurrent = useCallback((id: string) => sessionIdRef.current === id, []);

  // Constructed once, lazily, and never disposed — App itself never remounts within a session, so
  // there's no paired cleanup the way NavLayoutScope's own useLayoutEffect has one. Passed down so
  // every NavLayoutScope mount attaches to the *same* coordinator instead of constructing its own
  // — see lib/navigationWriteCoordinator.ts's own doc comment for why this (not a fresh queue per
  // mount) is what actually closes the cross-lifecycle write-ordering gap.
  const coordinatorRef = useRef<NavigationWriteCoordinator | null>(null);
  if (!coordinatorRef.current) {
    coordinatorRef.current = new NavigationWriteCoordinator({
      save: (layout, verify) => updateNavLayout({ tabs: layout }, verify),
    });
  }

  // Only usable if it was actually fetched under the sessionId that's current *right now* — a
  // pure, per-render derivation (no mutation, no effect-ordering dependency) rather than a
  // separate "clear the old value" step, which would need to run before NavLayoutScope's own
  // first render for the new lifecycle to avoid a stale hydration, and effect ordering (children
  // fire before parents) can't guarantee that. See lib/authGeneration.ts's currentGenerationValue.
  const navLayoutRawForCurrentSession = currentGenerationValue(navLayoutRaw, navLayoutRawSessionId, sessionId);

  const dashboardLayout = useDashboardLayout(dashboardLayoutRaw);
  const appearance = useAppearance(appearanceRaw);
  const financialPreferences = useFinancialPreferences(financialPreferencesRaw);
  const reportingRange = useReportingRange(reportingRangeRaw);

  useEffect(() => {
    // sawLiveEvent guards a real ordering hazard: the bootstrap getSession() call and a live
    // onAuthStateChange event are two independent async sources, and a live event can fire *and
    // resolve* before the slower bootstrap snapshot does, even though the bootstrap represents
    // strictly older information (whatever was true at page load). Once any live event has been
    // observed, a later-resolving bootstrap result must never be allowed to overwrite it, no
    // matter which one's own promise/callback happens to settle later. See
    // lib/authGeneration.ts's shouldApplyAuthEvent.
    let sawLiveEvent = false;

    function applyEvent(newSession: Session | null, isBootstrap: boolean) {
      if (!shouldApplyAuthEvent(isBootstrap, sawLiveEvent)) return;
      if (!isBootstrap) sawLiveEvent = true;
      // Decoded synchronously (see lib/jwt.ts) — no async gap between observing an event and
      // including its session_id in the same atomic dispatch. A decode failure (should not happen
      // — session_id is a required Supabase claim — but never assumed impossible) falls back to a
      // freshly generated id, guaranteeing this is still always treated as a new lifecycle rather
      // than silently trusting a guess that it's a continuation of the previous one.
      const newSessionId = newSession ? (decodeSessionId(newSession.access_token) ?? crypto.randomUUID()) : null;
      dispatchAuth({ type: 'AUTH_EVENT', session: newSession, sessionId: newSessionId });
    }

    // Registered before initiating the bootstrap call, so a live event that fires before
    // getSession() even resolves is never missed.
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, newSession) => {
      applyEvent(newSession, false);
    });
    supabase.auth.getSession().then(({ data }) => applyEvent(data.session, true));

    return () => subscription.subscription.unsubscribe();
  }, []);

  const refreshAll = useCallback(async () => {
    // Tags this fetch with the sessionId it was made under — see the setNavLayoutRawSessionId call
    // below and lib/authGeneration.ts's currentGenerationValue, which is what actually decides
    // whether the result is ever usable. Comparing bare user ids here would not be enough: "A1 ->
    // logout -> A3" must still reject A1's late response, even though its user id matches A3's
    // just as well.
    const requestedForSessionId = sessionIdRef.current;
    setLoading(true);
    // allSettled rather than all — one endpoint failing (e.g. a pending migration) shouldn't
    // blank the entire dashboard when the other calls succeeded fine.
    const [
      itemsRes,
      transactionsRes,
      categoriesRes,
      summaryRes,
      netWorthRes,
      breakdownRes,
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
      getSpendingSummary(reportingRange.range),
      getNetWorthHistory(reportingRange.range),
      getMonthlyBreakdown(reportingRange.range),
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
    if (summaryRes.status === 'fulfilled') setSummary(summaryRes.value);
    if (netWorthRes.status === 'fulfilled') setNetWorthHistory(netWorthRes.value.history);
    if (breakdownRes.status === 'fulfilled') setMonthlyBreakdown(breakdownRes.value.months);
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
    if (userPreferencesRes.status === 'fulfilled') {
      setDashboardLayoutRaw(userPreferencesRes.value.dashboard_layout?.cards ?? null);
      // Tagged, not gated: writing this unconditionally is safe because nothing ever *reads*
      // navLayoutRaw directly — only navLayoutRawForCurrentSession's derivation does, and it
      // already refuses any value whose tagged sessionId doesn't match whatever is current by
      // the time it's read, regardless of how this write is timed relative to that.
      setNavLayoutRaw(userPreferencesRes.value.nav_layout?.tabs ?? null);
      if (requestedForSessionId) setNavLayoutRawSessionId(requestedForSessionId);
      setAppearanceRaw({
        theme: userPreferencesRes.value.theme,
        accent_color: userPreferencesRes.value.accent_color,
      });
      setFinancialPreferencesRaw({
        minimum_cash_buffer: userPreferencesRes.value.minimum_cash_buffer,
        upcoming_bills_days: userPreferencesRes.value.upcoming_bills_days,
        recent_avg_months: userPreferencesRes.value.recent_avg_months,
        savings_rate_target: userPreferencesRes.value.savings_rate_target,
        safe_to_spend_include_upcoming_bills: userPreferencesRes.value.safe_to_spend_include_upcoming_bills,
        safe_to_spend_include_remaining_budget: userPreferencesRes.value.safe_to_spend_include_remaining_budget,
      });
      setReportingRangeRaw(userPreferencesRes.value.reporting_range);
    }

    const failures = [
      itemsRes,
      transactionsRes,
      categoriesRes,
      summaryRes,
      netWorthRes,
      breakdownRes,
      recurringRes,
      loansRes,
      assetsRes,
      manualLoansRes,
      categoryMappingsRes,
      plaidCategoriesRes,
      userPreferencesRes,
    ].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length > 0) {
      console.error('Some dashboard data failed to load:', failures.map((f) => f.reason));
      setActionError('Some dashboard data failed to load — see console for details.');
    }

    setLoading(false);
  }, [reportingRange.range]);

  useEffect(() => {
    // Keyed on `sessionId`, not `userId` and not `session` object identity. `session` gets a new
    // object reference on every auth event, including a duplicate re-emission of the same signed-
    // in user (e.g. on tab focus) or a routine token refresh — `sessionId` is unchanged by either,
    // so this doesn't spuriously re-fire for them. Keying on `userId` alone would miss a batched
    // same-user logout/login (A1 -> SIGNED_OUT -> SIGNED_IN A3): the *final* committed userId is
    // unchanged (still A), so a userId-keyed effect would never re-fire and Navigation would stay
    // hydrated from A1's stale preferences — sessionId genuinely changes across that exact
    // transition, so this effect correctly re-fires and refetches for A3's own data.
    if (sessionId) refreshAll();
  }, [sessionId, refreshAll]);

  // Best-effort — account/transaction refresh already succeeded by the time this runs,
  // so a failure here shouldn't surface as an error for an action the user didn't take.
  async function refreshSummary() {
    try {
      setSummary(await getSpendingSummary(reportingRange.range));
    } catch {
      // ignore
    }
  }

  async function refreshNetWorthHistory() {
    try {
      const res = await getNetWorthHistory(reportingRange.range);
      setNetWorthHistory(res.history);
    } catch {
      // ignore
    }
  }

  async function refreshMonthlyBreakdown() {
    try {
      const res = await getMonthlyBreakdown(reportingRange.range);
      setMonthlyBreakdown(res.months);
    } catch {
      // ignore
    }
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

  // Card components know nothing about customization — this is the one place that maps a card
  // id to what it actually renders, preserving each card's existing data-availability guard
  // (e.g. `stats` needs `summary`) exactly as it worked before dashboard customization existed.
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

  if (!session) {
    return <Auth />;
  }

  return (
    <div className="dashboard">
      <header className="app-header">
        <h1>My Finances</h1>
        <div className="app-header-actions">
          <PlaidLink onLinked={refreshAll} />
          <button className="link-button" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {actionError && <p className="error">{actionError}</p>}

      {/* NavLayoutScope sits outside the loading check deliberately: loading is a general
          "some data fetch is in flight" flag (set by every refreshAll() call, including ones with
          nothing to do with authentication, e.g. PlaidLink's onLinked) — it must only ever affect
          what's rendered *inside* Navigation's authenticated scope, never whether that scope
          exists. Only `key={sessionId}` controls that. sessionId! below: this JSX only renders
          once the earlier `!session` early return has already confirmed we're authenticated, and
          `session`/`sessionId` are always set together, atomically, by the same reducer action —
          TypeScript just can't see that correlation across two destructured fields. */}
      <NavLayoutScope
        key={sessionId!}
        userId={userId}
        sessionId={sessionId!}
        isSessionCurrent={isSessionCurrent}
        coordinator={coordinatorRef.current}
        saved={navLayoutRawForCurrentSession}
      >
        {(navLayout) => {
          if (loading) return <p className="hint">Loading...</p>;
          // The current web/PWA's own decision about primary-tab-bar order (Overview first,
          // Settings last) — see lib/webTabNav.ts. Recomputed on every render of this render-prop;
          // cheap, and avoids a second piece of state that could drift from navLayout.layout.
          const TABS = buildWebTabList(getVisibleOrderedTabIds(navLayout.layout));
          return (
            <>
              <TabNav tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

              {activeTab === 'overview' && (
                <div className="tab-panel">
                  <div className="section-header overview-header">
                    <span className="hint">Overview</span>
                    <button type="button" className="link-button" onClick={() => dashboardLayout.setCustomizing(true)}>
                      Customize dashboard
                    </button>
                  </div>

                  {!dashboardLayout.customizing &&
                    dashboardLayout.layout.some(
                      (c) => c.visible && (c.id === 'monthly_spending_chart' || c.id === 'net_worth_chart')
                    ) && <ReportingRangeSelector range={reportingRange.range} onChange={reportingRange.setRange} />}

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
      </NavLayoutScope>
    </div>
  );
}
