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
 * The current lifecycle's own preference-bootstrap outcome — produced only by `bootstrapPreferences`
 * below, never by `refreshFinancialData` (the general account/transaction/dashboard-data refresh
 * that also runs on every Plaid link and other background activity). Distinct from `loading`, which
 * `refreshFinancialData` sets/clears and which has no bearing on whether PreferencesScope exists —
 * see the render body's own comment for why background loading must never re-show the bootstrap
 * "Loading..."/"Retry" gate once this has reached 'ready'. Tagged with the sessionId it was fetched
 * under (see `preferencesStatus`'s derivation in App) using the same currentGenerationValue
 * mechanism as navLayoutRaw already uses — a pure, per-render derivation, so a lifecycle change is
 * reflected the instant sessionId itself changes, with no effect-timing gap where a stale outcome
 * could still read as current for even one render. That tag alone isn't enough to protect the write
 * itself against two overlapping same-session invocations (e.g. two overlapping Retry clicks) — see
 * `preferencesRequestIdRef`'s own comment for the additional latest-invocation ownership that closes
 * that gap.
 */
export type PreferencesFetchOutcome = { status: 'ready'; payload: UserPreferences } | { status: 'error' };

/**
 * The current lifecycle's own INITIAL financial-batch outcome — the nine ordinary account/
 * transaction/dashboard-data reads `refreshFinancialData` below fetches (everything except
 * preferences and the three reporting-range-parameterized datasets). Distinct from `loading`
 * exactly the way `PreferencesFetchOutcome` is distinct from it: `loading` is set/cleared by
 * *every* `refreshFinancialData` call, but this outcome is written only by whichever invocation is
 * "readiness-producing" for the current lifecycle — see `financialReadySessionIdRef`'s and
 * `refreshFinancialData`'s own comments for exactly what that means and why it's determined by the
 * invocation itself, not by a caller-supplied flag. No unrelated activity can ever regress this
 * back to 'loading' or 'error' once the current lifecycle's own initial batch has actually
 * succeeded — see the render body's own comment for why that matters (the financial-dependent
 * content gate must distinguish "this lifecycle has never successfully loaded its own financial
 * data yet" from "a later, unrelated background refresh happened to fail").
 */
export type FinancialFetchOutcome = { status: 'ready' } | { status: 'error' };

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
 * A1 -> A3, or a plain logout/login) — so each hook's own hydration only ever ran once *ever* per
 * page load, and a later `getUserPreferences()` fetch for a different user, or the same user's new
 * session, was silently ignored, leaving the previous lifecycle's dashboard layout, theme,
 * financial preferences, and reporting range visible — and, on the next edit, persisted — under
 * the new one. Once this scope itself remounts per lifecycle (keyed by `sessionId`), each hook's
 * state naturally starts fresh, initialized directly from the new mount's own `saved` payload —
 * see each hook's own doc comment for why they no longer need a `hydrated` ref or a passive
 * hydration effect at all now that mounting is gated on the payload already being present.
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
 * `saved` is the current lifecycle's *already-arrived* `getUserPreferences()` payload — never
 * `undefined`, never a placeholder. App.tsx only ever renders this component once its own
 * `preferencesStatus` derivation is `'ready'` (see App's render body); while status is `'loading'`
 * or `'error'`, App renders a Loading/Retry placeholder *instead of* this component, so this
 * component and its four hooks simply don't exist yet. That is what closes the "ready content
 * renders before the hooks have actually hydrated" gap a purely-internal hydration flag could
 * not: the four hooks below use `saved` as their `useState` *lazy initializer* — not a default
 * that a later passive effect copies real data into — so a freshly mounted instance's very first
 * render already reflects the real, current-lifecycle server values. There is no intermediate
 * committed frame, visible or not, containing an editable default/cached value: the render that
 * mounts these hooks is the render that already has the real payload, because mounting only ever
 * happens after the payload exists.
 */
export function PreferencesScope({
  userId,
  sessionId,
  isSessionCurrent,
  saved,
  onReportingRangeReady,
  children,
}: {
  userId: string | null;
  sessionId: string;
  isSessionCurrent: (sessionId: string) => boolean;
  saved: UserPreferences;
  onReportingRangeReady: (range: ReportingRangeId) => void;
  children: (prefs: {
    dashboardLayout: ReturnType<typeof useDashboardLayout>;
    appearance: ReturnType<typeof useAppearance>;
    financialPreferences: ReturnType<typeof useFinancialPreferences>;
    reportingRange: ReturnType<typeof useReportingRange>;
  }) => ReactNode;
}) {
  const verifyOwnership = (session: Session) =>
    session.user.id === userId && decodeSessionId(session.access_token) === sessionId && isSessionCurrent(sessionId);

  const dashboardLayout = useDashboardLayout(saved.dashboard_layout?.cards ?? null, verifyOwnership);
  const appearance = useAppearance({ theme: saved.theme, accent_color: saved.accent_color }, verifyOwnership);
  const financialPreferences = useFinancialPreferences(
    {
      minimum_cash_buffer: saved.minimum_cash_buffer,
      upcoming_bills_days: saved.upcoming_bills_days,
      recent_avg_months: saved.recent_avg_months,
      savings_rate_target: saved.savings_rate_target,
      safe_to_spend_include_upcoming_bills: saved.safe_to_spend_include_upcoming_bills,
      safe_to_spend_include_remaining_budget: saved.safe_to_spend_include_remaining_budget,
    },
    verifyOwnership
  );
  const reportingRange = useReportingRange(saved.reporting_range, verifyOwnership, onReportingRangeReady);

  return <>{children({ dashboardLayout, appearance, financialPreferences, reportingRange })}</>;
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
  // The current lifecycle's own INITIAL financial-batch outcome — see FinancialFetchOutcome's own
  // doc comment above, and `financialLifecycleStatus`'s derivation below.
  const [financialOutcome, setFinancialOutcome] = useState<FinancialFetchOutcome | undefined>(undefined);
  const [financialOutcomeSessionId, setFinancialOutcomeSessionId] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const userId = session?.user.id ?? null;

  // Mirrors sessionId for reads from inside async closures (bootstrapPreferences'/
  // refreshFinancialData's own captures below, and NavLayoutScope's/PreferencesScope's
  // isSessionCurrent) that must see the *latest* value at the
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

  // Every mutation handler below (createManualLoan, categorize a transaction, archive a category,
  // ...) applies its successful server response via a functional state updater (`setX(prev =>
  // ...)`), never `setX(newFullArray)` — an incremental, keyed patch against whatever the CURRENT
  // state actually is, not a snapshot captured when the mutation started. That already makes a
  // mutation's own commit safe against ordering relative to OTHER same-session readers/writers of
  // the same resource (see resourceVersionsRef's own comment for why grouped/targeted READS need
  // that shared version instead: they overwrite the whole array, so they need to know whose data is
  // newest; a mutation's patch composes correctly against whatever's there without needing to ask).
  // The one thing a functional updater can't protect against on its own is a stale LIFECYCLE: if
  // the session has changed since the mutation started, `prev` at commit time is some OTHER
  // lifecycle's current state, and blindly patching it is exactly the "A creates a loan, switches
  // to B, A's create later succeeds and appends to B's loans" failure Codex found. This one check —
  // used by every mutation handler that writes ordinary financial state — closes that: if the
  // session has moved on, the handler skips its setState entirely, leaving the new lifecycle's own
  // state untouched.
  function isStillCurrentSession(expectedSessionId: string | null): boolean {
    return expectedSessionId === sessionIdRef.current;
  }

  // Mirrors PreferencesScope's own useReportingRange for the handful of App-level call sites
  // (handlePlaidLinked's own range refresh, and the account/transaction handlers further down)
  // that need "whatever range is current" without themselves living inside that scope. Written
  // only by applyReportingRange below, itself only ever called from PreferencesScope's
  // onReportingRangeReady — see that function's own comment for why neither refreshFinancialData
  // nor bootstrapPreferences reads or fetches by range at all.
  const reportingRangeRef = useRef<ReportingRangeId>(DEFAULT_REPORTING_RANGE);

  // A single tab-wide monotonically increasing counter — the ownership tag for the three
  // reporting-range-parameterized datasets (summary/netWorthHistory/monthlyBreakdown), minted by
  // `applyReportingRange` below, the *only* function that ever fetches any of these three. Every
  // call — a lifecycle's first hydration, a user's range change, a post-Plaid-link refresh, a
  // preferences Retry that leads to one, or any other "please refresh these" call site (account
  // sync, account customization, ...) — mints a new, strictly higher id and hands it to that
  // call's three sibling fetches; each fetch's own `.then` only commits its result if its id is
  // still the *latest* one issued at the moment it resolves. This one comparison subsumes session,
  // range, and same-range-retry ownership together: a response tagged with an id that's been
  // superseded by ANY later call — a new lifecycle, a new range, or simply a newer same-range
  // refresh — can never win, regardless of network arrival order. Also bumped directly by the
  // session-change effect below (not only by applyReportingRange), which is what closes the
  // specific gap where an old lifecycle's already-in-flight request could otherwise still hold the
  // *current* id — and therefore still be accepted — for the entire window between a lifecycle
  // change and that new lifecycle's own first applyReportingRange call.
  const rangeDataRequestIdRef = useRef(0);

  // A single tab-wide monotonically increasing counter — the ownership tag for preference-
  // bootstrap/refetch invocations specifically (bootstrapPreferences below), distinct from
  // rangeDataRequestIdRef above. sessionId-tagging (preferencesOutcomeSessionId, checked via
  // preferencesOutcomeForCurrentSession's derivation below) already protects against a *different*
  // lifecycle's stale outcome winning, but two invocations that both belong to the *same* session —
  // e.g. two overlapping Retry clicks after an initial bootstrap failure — share that same tag, so
  // an older one settling after a newer one would otherwise still pass the session check and
  // incorrectly replace an already-'ready' (or already-newer-'error') outcome with its own. This
  // ref closes that gap: bootstrapPreferences mints a fresh id on every call and only ever commits
  // its preferencesOutcome/preferencesOutcomeSessionId write if its own id is still the latest one
  // issued at the moment it resolves. Unlike rangeDataRequestIdRef, this does not need a separate
  // bump from the session-change effect below — bootstrapPreferences is always called
  // synchronously, in that same effect tick, whenever sessionId changes, so the bump its own first
  // line performs already happens before any previous lifecycle's in-flight request could resolve.
  const preferencesRequestIdRef = useRef(0);

  // A single tab-wide monotonically increasing counter — the ownership tag for the nine ordinary
  // account/transaction/dashboard-data reads (refreshFinancialData below), mirroring
  // rangeDataRequestIdRef's exact mechanism. Every refreshFinancialData call — the current
  // lifecycle's own initial batch, a Plaid-triggered background refresh, or the financial-error
  // gate's own Retry — mints a new, strictly higher id and hands it to all nine sibling reads;
  // each read's own commit only applies if its id is still the *latest* one issued at the moment
  // it resolves AND it was requested under the sessionId that's still current. This is what
  // prevents a slow-to-resolve older invocation (a previous lifecycle's still-in-flight initial
  // batch, or an older same-session refresh) from overwriting a newer invocation's already-
  // committed results, regardless of network arrival order — see refreshFinancialData's own
  // comment. Like preferencesRequestIdRef (and unlike rangeDataRequestIdRef), this does not need a
  // separate bump from the session-change effect below: refreshFinancialData is always called
  // synchronously, in that same effect tick, whenever sessionId changes, so the bump its own first
  // line performs already happens before any previous lifecycle's in-flight request could resolve.
  const financialRequestIdRef = useRef(0);

  // Tracks, for the CURRENT session only, whether financial lifecycle readiness has EVER actually
  // been *committed* — the sessionId this holds is the one it was last set FOR, so comparing it
  // against `sessionIdRef.current` at any later moment answers "has THIS session's initial
  // financial batch already succeeded once?" Read (not written) at the very start of every
  // refreshFinancialData call — see that function's own comment for why "readiness-producing" must
  // be decided there, from this ref, rather than from a caller-supplied flag or from reading
  // `financialLifecycleStatus` itself (a derived render value refreshFinancialData, a stable
  // useCallback, has no safe way to read fresh — this ref is the lifecycle-safe substitute, kept
  // in sync at the exact moment 'ready' is actually committed). Needs no explicit reset on a
  // lifecycle change: a new session's id can never equal whatever this ref holds from the previous
  // one (or `undefined`, before any session has ever reached ready), so every new lifecycle's first
  // invocation is automatically readiness-producing again without any extra bookkeeping.
  const financialReadySessionIdRef = useRef<string | undefined>(undefined);

  // One shared latest-write generation counter PER ORDINARY FINANCIAL RESOURCE — the ownership
  // domain every asynchronous READ of that resource participates in, regardless of whether it's
  // part of the grouped refreshFinancialData batch, a targeted single-resource refresh
  // (refreshRecurringStreams, refreshLoans, refreshAssetsSummary, refreshBudgetCategories), the two
  // direct post-action transaction refetches (handleSyncTransactions/handleSaveCategoryMapping), or
  // handleAccountsRefreshed's own items commit. Round 6 gave the grouped batch its own counter
  // (financialRequestIdRef) and every targeted refresh its own separate one — Codex found that
  // split lets a same-session grouped read and a targeted read of the SAME resource race each
  // other with no shared ownership at all: whichever happened to reserve ITS OWN counter most
  // recently would consider itself "latest" even after the OTHER kind of read, for the very same
  // resource, had already committed something newer. Resource-centric ownership closes that: every
  // reader of `assets`, for instance — grouped or targeted — reserves its own version from
  // `resourceVersionsRef.current.assets` at its own start (before any await) and only commits if
  // that version is still current when it resolves, so "latest write STARTED for this resource
  // wins" holds regardless of which kind of reader started it or which one's network response
  // happens to arrive first. Deliberately per-resource, not one single shared counter for
  // everything: a Loans-tab refresh has nothing to do with a Budget-tab refresh, and forcing them
  // through one counter would let an unrelated resource's newer read spuriously invalidate this
  // one's still-legitimate in-flight request (see each read site's own comment). Mutation-response
  // handlers (handleCreateManualLoan and friends) deliberately do NOT reserve a version here — see
  // isStillCurrentSession's own comment for why a plain cross-lifecycle session check is the
  // correct, smaller mechanism for those instead.
  const resourceVersionsRef = useRef({
    items: 0,
    transactions: 0,
    recurringStreams: 0,
    loans: 0,
    manualLoans: 0,
    assets: 0,
    budgets: 0,
    categoryMappings: 0,
  });

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
  // Same mechanism again, applied to the current lifecycle's own INITIAL financial-batch outcome.
  // This is what lets the render body distinguish "this lifecycle has never successfully completed
  // its own initial financial load" (loading — including the entire window before a genuine
  // lifecycle change's own new invocation has even settled once) from "settled, and it failed"
  // from "settled, and it succeeded" — a stale outcome tagged with an old sessionId reads as
  // `undefined` here exactly like preferencesOutcomeForCurrentSession's equivalent does, so a
  // previous lifecycle's already-'ready' status can never read as the new lifecycle's own.
  const financialOutcomeForCurrentSession = currentGenerationValue(
    financialOutcome,
    financialOutcomeSessionId,
    sessionId
  );
  const financialLifecycleStatus: 'loading' | 'ready' | 'error' = financialOutcomeForCurrentSession?.status ?? 'loading';

  // Fetches the current lifecycle's own preferences payload — Dashboard Layout, Appearance,
  // Financial Preferences (incl. the Safe-to-Spend toggles), Reporting Range, and nav_layout — and
  // is the ONLY function that ever writes preferencesOutcome/preferencesOutcomeSessionId. Called
  // once on every genuine lifecycle change (the session-change effect below) and again by the
  // user's own Retry click; deliberately never called by refreshFinancialData or by any
  // background/Plaid refresh — see refreshFinancialData's own comment for why those two concerns
  // are kept apart. `preferencesStatus` depends only on this function's outcome, never on
  // `loading`, so an ordinary background refresh can never send an already-'ready' lifecycle back
  // through the bootstrap "Loading..."/"Retry" gate.
  const bootstrapPreferences = useCallback(async () => {
    // See preferencesRequestIdRef's own comment above: sessionId-tagging alone
    // (requestedForSessionId, used below exactly like refreshFinancialData's stillCurrent)
    // protects against a *different* lifecycle's stale outcome, but not two overlapping
    // invocations within the *same* one — the requestId captured here closes that second gap.
    const requestedForSessionId = sessionIdRef.current;
    const requestId = ++preferencesRequestIdRef.current;
    const isLatest = () =>
      requestId === preferencesRequestIdRef.current && requestedForSessionId === sessionIdRef.current;
    try {
      const preferences = await getUserPreferences();
      // Every piece of state this one response can produce — navLayoutRaw/navLayoutRawSessionId
      // *and* preferencesOutcome/preferencesOutcomeSessionId — is treated as ONE atomic ownership
      // domain, gated by the SAME isLatest() check, before ANY of it is written. Previously
      // navLayoutRaw was written unconditionally ("tagged, not gated," relying solely on its own
      // derivation to exclude a stale response at read time) while preferencesOutcome was gated —
      // that let an older same-session response, arriving after a newer one had already been
      // accepted, still overwrite Navigation's payload (a mismatched *session* tag would have
      // caught a different lifecycle's stale response, but two overlapping same-session
      // invocations share the identical tag, so only this requestId check catches it). Since a
      // single getUserPreferences() call is the source of both, they must stand or fall together.
      if (isLatest() && requestedForSessionId) {
        setNavLayoutRaw(preferences.nav_layout?.tabs ?? null);
        setNavLayoutRawSessionId(requestedForSessionId);
        setPreferencesOutcome({ status: 'ready', payload: preferences });
        setPreferencesOutcomeSessionId(requestedForSessionId);
      }
    } catch {
      if (isLatest() && requestedForSessionId) {
        setPreferencesOutcome({ status: 'error' });
        setPreferencesOutcomeSessionId(requestedForSessionId);
      }
    }
  }, []);

  // Fetches every OTHER account/transaction/dashboard-data collection — deliberately excludes
  // getUserPreferences (see bootstrapPreferences above) and the three reporting-range-parameterized
  // calls (owned by applyReportingRange below). This is what runs on ordinary background refreshes
  // — a successful Plaid link (handlePlaidLinked), account sync, account customization — in
  // addition to every genuine lifecycle change. Splitting this from bootstrapPreferences is what
  // lets `loading` (set/cleared here) stay a purely general, background-activity flag with no
  // bearing on preferencesStatus or on whether PreferencesScope exists: a Plaid-triggered refresh
  // still sets `loading` exactly as before (see the small header indicator), but nothing that reads
  // `loading` any longer decides whether to unmount the authenticated preference scope — see the
  // render body's own comment.
  //
  // Whether THIS invocation is "readiness-producing" — i.e. eligible to write
  // financialOutcome/financialOutcomeSessionId, the state financialLifecycleStatus (and therefore
  // the render body's financial-content gate) depends on — is no longer decided by a caller-
  // supplied flag (a previous design's `isInitial` parameter). Codex found that design could
  // strand the lifecycle forever: if a background call (e.g. Plaid) started and became the LATEST
  // invocation before the original initial call had finished, the background call — not marked
  // initial — would commit all nine datasets but be forbidden from ever setting financialOutcome,
  // while the original initial call, now superseded, could no longer commit anything either
  // (isLatest() false) — leaving financialLifecycleStatus stuck at 'loading' with nothing left in
  // flight that could ever resolve it. Instead: "background" vs. "initial" describes UX behavior
  // *after* lifecycle readiness exists, not something knowable in advance by the caller. Every
  // invocation reads `financialReadySessionIdRef` (see its own comment) at ITS OWN start, BEFORE
  // any await: if the current session hasn't reached readiness yet, THIS invocation is
  // readiness-producing, fixed for its own whole lifetime — regardless of whether it's the
  // original session-change-effect call, a Retry, or a same-window Plaid/background call that
  // happens to overtake it. Once some invocation actually commits readiness for this session (via
  // isLatest() below), every later call for the same session reads the ref as already-ready and
  // behaves as an ordinary background refresh instead.
  //
  // Every one of the nine sibling reads below now commits its result only if `isLatest()` still
  // holds at the moment it resolves — the same monotonic-id-plus-session ownership pattern
  // applyReportingRange already uses for the three range-dependent datasets. This is what prevents
  // a slow-to-resolve PREVIOUS lifecycle's still-in-flight initial batch (or an older same-session
  // invocation) from landing its account/transaction/budget/etc. values into CURRENT state after a
  // newer invocation has already committed its own — the concrete "A's accounts render under B" /
  // "an overlapping older financial refresh overwrites a newer one" failures this closes. Combined
  // with the render body's own financialLifecycleStatus gate (which hides all financial-dependent
  // content — including Safe to Spend — until the CURRENT lifecycle's own initial batch has
  // actually succeeded), a previous lifecycle's retained state can never be shown as the current
  // one's, even in the window before this gate's own fetch has resolved: nothing reads these nine
  // pieces of state outside that gated area.
  const refreshFinancialData = useCallback(async () => {
    // Tags this call with the sessionId it was made under, exactly like bootstrapPreferences — see
    // that function's own comment. Comparing bare user ids here would not be enough: "A1 -> logout
    // -> A3" must still reject A1's late response, even though its user id matches A3's just as
    // well.
    const requestedForSessionId = sessionIdRef.current;
    // Captured HERE, synchronously, before any await — see this function's own leading comment and
    // financialReadySessionIdRef's for why this must be decided at invocation start rather than
    // re-derived later (which would let a still-not-ready invocation "steal" readiness
    // responsibility mid-flight from whichever invocation actually turns out to be latest).
    const isReadinessProducing = financialReadySessionIdRef.current !== requestedForSessionId;
    const requestId = ++financialRequestIdRef.current;
    const isLatest = () =>
      requestId === financialRequestIdRef.current && requestedForSessionId === sessionIdRef.current;
    // Reserves THIS invocation's own version for every resource it's about to write — see
    // resourceVersionsRef's own comment. Reserved synchronously, all together, before any await:
    // any same-session targeted refresh (or another grouped call) that reserves its resource's
    // version AFTER this point always wins against this invocation for that resource specifically,
    // and this invocation always wins against anything that reserved earlier — "latest write
    // STARTED for a resource wins," independent of which kind of reader it was or network arrival
    // order. Each is checked individually, right before that one resource's own commit below (not
    // gated behind the grouped `isLatest()` above): a resource-specific staleness — a newer
    // TARGETED refresh of just that one resource having started after this grouped call — must not
    // block this invocation's OTHER, still-currently-owned resources from committing.
    const itemsVersion = ++resourceVersionsRef.current.items;
    const transactionsVersion = ++resourceVersionsRef.current.transactions;
    const budgetsVersion = ++resourceVersionsRef.current.budgets;
    const recurringVersion = ++resourceVersionsRef.current.recurringStreams;
    const loansVersion = ++resourceVersionsRef.current.loans;
    const assetsVersion = ++resourceVersionsRef.current.assets;
    const manualLoansVersion = ++resourceVersionsRef.current.manualLoans;
    const categoryMappingsVersion = ++resourceVersionsRef.current.categoryMappings;
    setLoading(true);
    // allSettled rather than all — one endpoint failing (e.g. a pending migration) shouldn't
    // blank the entire dashboard when the other calls succeeded fine.
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
    ]);

    // Whether THIS call's own lifecycle is still the one currently active — reused below for the
    // per-resource commits, `loading`, and background `actionError`. A cross-lifecycle staleness
    // check every resource commit needs in addition to its own resource-version check (a new
    // lifecycle's own session-change effect reserves fresh versions for every resource
    // immediately, so the version check alone would already catch most cases — this stays an
    // explicit, independent check too, the same defense-in-depth every other ownership check in
    // this file uses).
    const stillCurrent = requestedForSessionId === sessionIdRef.current;

    if (itemsRes.status === 'fulfilled' && stillCurrent && itemsVersion === resourceVersionsRef.current.items) {
      setItems(itemsRes.value.items);
      setIsSandbox(itemsRes.value.is_sandbox);
    }
    if (
      transactionsRes.status === 'fulfilled' &&
      stillCurrent &&
      transactionsVersion === resourceVersionsRef.current.transactions
    ) {
      setTransactions(transactionsRes.value.transactions);
    }
    if (categoriesRes.status === 'fulfilled' && stillCurrent && budgetsVersion === resourceVersionsRef.current.budgets) {
      setBudgetCategories(categoriesRes.value.categories);
    }
    if (
      recurringRes.status === 'fulfilled' &&
      stillCurrent &&
      recurringVersion === resourceVersionsRef.current.recurringStreams
    ) {
      setRecurringStreams(recurringRes.value.streams);
      setTotalMonthlyOutflow(recurringRes.value.total_monthly_outflow);
      setTotalMonthlyInflow(recurringRes.value.total_monthly_inflow);
    }
    if (loansRes.status === 'fulfilled' && stillCurrent && loansVersion === resourceVersionsRef.current.loans) {
      setLoans(loansRes.value.loans);
      setTotalDebt(loansRes.value.total_debt);
      setTotalMinimumPayment(loansRes.value.total_minimum_payment);
    }
    if (assetsRes.status === 'fulfilled' && stillCurrent && assetsVersion === resourceVersionsRef.current.assets) {
      setAssetGroups(assetsRes.value.groups);
      setTotalAssets(assetsRes.value.total_assets);
    }
    if (
      manualLoansRes.status === 'fulfilled' &&
      stillCurrent &&
      manualLoansVersion === resourceVersionsRef.current.manualLoans
    ) {
      setManualLoans(manualLoansRes.value.loans);
    }
    if (
      categoryMappingsRes.status === 'fulfilled' &&
      stillCurrent &&
      categoryMappingsVersion === resourceVersionsRef.current.categoryMappings
    ) {
      setCategoryMappings(categoryMappingsRes.value.mappings);
    }
    // No competing writer exists for plaidCategories (no targeted refresh, no mutation touches it)
    // — the session check alone matches its previous protection exactly.
    if (plaidCategoriesRes.status === 'fulfilled' && stillCurrent) {
      setPlaidCategories(plaidCategoriesRes.value.categories);
    }

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
    ].filter((r): r is PromiseRejectedResult => r.status === 'rejected');

    if (isReadinessProducing) {
      // The ONLY writer of financialOutcome/financialOutcomeSessionId — gated by the strict
      // isLatest() check (session AND invocation), exactly like preferencesOutcome, since this
      // drives a value re-derived and gated on every render (financialLifecycleStatus), not a
      // one-shot hydration read. ANY failure among the nine is treated as "not ready": partial,
      // failed-bootstrap financial state is exactly what must never be treated as authoritative —
      // see this function's own comment above. `financialReadySessionIdRef` is updated in the same
      // breath as a successful outcome — the only place it's ever written — so every later
      // invocation for this session correctly reads readiness as already established.
      if (isLatest() && requestedForSessionId) {
        if (failures.length > 0) {
          setFinancialOutcome({ status: 'error' });
        } else {
          setFinancialOutcome({ status: 'ready' });
          financialReadySessionIdRef.current = requestedForSessionId;
        }
        setFinancialOutcomeSessionId(requestedForSessionId);
      }
    } else if (failures.length > 0 && stillCurrent) {
      // Background-refresh failure path — unchanged from before: surfaces via the existing
      // actionError banner, never touches financialOutcome, so an already-'ready' lifecycle's
      // financial content gate stays open and its last-valid data stays visible (see this
      // function's own comment for why background failures must not re-hide already-ready
      // content).
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
    // Invalidates any range-data request still in flight from the *previous* lifecycle — bumped
    // synchronously here, immediately on the lifecycle change, before ANY async gap. Without this,
    // an old lifecycle's already-issued request could still resolve holding what was, until this
    // exact moment, the *current* id — reportingRangeRef/rangeDataRequestIdRef don't otherwise
    // change again until the NEW lifecycle's own first applyReportingRange call (which only
    // happens once its useReportingRange hydrates, itself gated behind preferencesStatus ===
    // 'ready' — a real, multi-render-wide window) — and would therefore still pass the ownership
    // check and repopulate the just-cleared datasets with the old lifecycle's data.
    rangeDataRequestIdRef.current += 1;
    // Clears the three range-dependent display datasets the instant the lifecycle changes —
    // synchronously, in this same effect, before either call below's first async gap and therefore
    // before ANY of this new lifecycle's own data can possibly have arrived yet. Without this, the
    // render immediately after a lifecycle change (until preferencesStatus reaches 'ready' and this
    // scope's own useReportingRange hydrates and fires applyReportingRange) could otherwise still
    // be holding the *previous* lifecycle's summary/netWorthHistory/monthlyBreakdown values.
    // `preferencesOutcome`/`navLayoutRaw`'s tagged derivations don't need this (a stale tag simply
    // reads as unusable) because their consumers only ever render *derived* values; these three are
    // plain, untagged state read directly by several components, so the safe equivalent is to clear
    // them outright rather than thread a tag through every read site.
    setSummary(null);
    setNetWorthHistory([]);
    setMonthlyBreakdown([]);
    // Two independent calls, not one combined fetch — see bootstrapPreferences' and
    // refreshFinancialData's own comments for why they're kept separate. Both are still fired
    // together here, unconditionally, on every genuine lifecycle change. This call is automatically
    // readiness-producing for the new session (financialReadySessionIdRef can't yet hold its id) —
    // see refreshFinancialData's own comment for why that's now determined by the invocation
    // itself rather than by a flag passed here.
    bootstrapPreferences();
    refreshFinancialData();
  }, [sessionId, bootstrapPreferences, refreshFinancialData]);

  // The ONE production function that ever fetches any of the three reporting-range-parameterized
  // datasets (spending summary, net worth history, monthly breakdown) — used uniformly for the
  // current lifecycle's initial hydration (via PreferencesScope's useReportingRange, through its
  // onReportingRangeReady prop), a user's own range change (the same prop), a successful Plaid
  // link (handlePlaidLinked), a preferences Retry's eventual recovery (the normal hydration path,
  // once bootstrapPreferences succeeds again), and every other "please refresh these three" call
  // site below (account sync, account customization, ...) — no caller manually threads or reuses
  // a request id; every call mints its own fresh one via rangeDataRequestIdRef and gives it to all
  // three sibling requests, so a single invocation's three requests share ownership with each
  // other but are always superseded, as one group, by whatever the next call to this function
  // turns out to be, from anywhere, for any reason (a newer range, a newer lifecycle, or simply a
  // newer same-range refresh). Deliberately *not* routed through refreshFinancialData or
  // bootstrapPreferences: refreshFinancialData fires on both a genuine lifecycle change and
  // ordinary background refreshes and fetches everything range- and preference-independent;
  // bootstrapPreferences fires only on a genuine lifecycle change or a Retry and only ever touches
  // preferences. This stays the single, separate place range-dependent data is ever fetched — never
  // re-fetching (and never re-hydrating) Dashboard Layout, Appearance, or Financial Preferences,
  // never fetching these three twice on a lifecycle change (once at a stale/default range, once at
  // the real one), and — now that ordinary background/Plaid refreshes no longer remount
  // PreferencesScope (see the render body's own comment) — never a second, redundant time merely
  // because that remount used to re-fire useReportingRange's own mount-time onReady call.
  function applyReportingRange(range: ReportingRangeId) {
    reportingRangeRef.current = range;
    const requestId = ++rangeDataRequestIdRef.current;
    // Clear immediately, before any of the three requests below resolve — a request that ends up
    // failing, or that belongs to an attempt this very call has already superseded (e.g. this is
    // the second of two calls issued back-to-back), must never leave stale data — a different
    // range's, or a stale attempt's — masquerading as current under the new selection. Showing
    // nothing is preferable to showing something wrong.
    setSummary(null);
    setNetWorthHistory([]);
    setMonthlyBreakdown([]);

    getSpendingSummary(range).then(
      (res) => {
        if (requestId === rangeDataRequestIdRef.current) setSummary(res);
      },
      () => {
        // ignore — a failed request for what is still the current attempt leaves summary cleared
        // (see above), never any other lifecycle's or range's data.
      }
    );
    getNetWorthHistory(range).then(
      (res) => {
        if (requestId === rangeDataRequestIdRef.current) setNetWorthHistory(res.history);
      },
      () => {}
    );
    getMonthlyBreakdown(range).then(
      (res) => {
        if (requestId === rangeDataRequestIdRef.current) setMonthlyBreakdown(res.months);
      },
      () => {}
    );
  }

  // These four targeted, single-resource refreshes (plus the two direct transaction refetches in
  // handleSyncTransactions/handleSaveCategoryMapping further down, and handleAccountsRefreshed's
  // own items commit) each independently capture `sessionIdRef.current` AND reserve a version from
  // their resource's own counter in `resourceVersionsRef` (see its own comment) at their own start,
  // then check both again before committing. Sharing that counter with refreshFinancialData's own
  // per-resource reservations for the SAME resources is what makes a same-session grouped read and
  // a targeted read of one resource race safely against each other regardless of which kind
  // started or resolved first — a split, function-private counter (as an earlier round had) cannot
  // do that, since two independently-numbered counters have no way to compare "which is newer" at
  // all. The session check independently closes the cross-lifecycle case: once a new lifecycle has
  // already reached financialLifecycleStatus === 'ready', its content is no longer behind any gate
  // that could hide a previous lifecycle's stale response — a slow-to-resolve A-initiated call
  // landing here well after B is fully ready would otherwise silently render A's data under B.
  async function refreshRecurringStreams() {
    const expectedSessionId = sessionIdRef.current;
    const version = ++resourceVersionsRef.current.recurringStreams;
    try {
      const res = await getRecurringStreams();
      if (expectedSessionId !== sessionIdRef.current || version !== resourceVersionsRef.current.recurringStreams) {
        return;
      }
      setRecurringStreams(res.streams);
      setTotalMonthlyOutflow(res.total_monthly_outflow);
      setTotalMonthlyInflow(res.total_monthly_inflow);
    } catch {
      // ignore
    }
  }

  async function refreshLoans() {
    const expectedSessionId = sessionIdRef.current;
    const version = ++resourceVersionsRef.current.loans;
    try {
      const res = await getLoans();
      if (expectedSessionId !== sessionIdRef.current || version !== resourceVersionsRef.current.loans) return;
      setLoans(res.loans);
      setTotalDebt(res.total_debt);
      setTotalMinimumPayment(res.total_minimum_payment);
    } catch {
      // ignore
    }
  }

  async function refreshAssetsSummary() {
    const expectedSessionId = sessionIdRef.current;
    const version = ++resourceVersionsRef.current.assets;
    try {
      const res = await getAssetsSummary();
      if (expectedSessionId !== sessionIdRef.current || version !== resourceVersionsRef.current.assets) {
        return;
      }
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
    const expectedSessionId = sessionIdRef.current;
    const version = ++resourceVersionsRef.current.budgets;
    try {
      const res = await getBudgetCategories();
      if (expectedSessionId !== sessionIdRef.current || version !== resourceVersionsRef.current.budgets) {
        return;
      }
      setBudgetCategories(res.categories);
    } catch {
      // ignore
    }
  }

  // `newItems` arrives as a plain argument, not from a fetch this function itself makes — the
  // async work already happened inside LinkedAccounts (a child this callback was handed to as a
  // prop), on its own schedule, unrelated to React's render/commit cycle. Reading
  // `sessionIdRef.current` at the moment this function actually runs would only ever say "whatever
  // session is current right now" — useless for detecting staleness, since there's no `await`
  // inside this function itself to create a "before/after" gap to check across. What must be
  // compared instead is the session that was active when THIS SPECIFIC callback instance was
  // created and handed to LinkedAccounts (a closure over `sessionId`, the plain render-scoped
  // value — fixed for the lifetime of this exact function instance, unlike sessionIdRef.current)
  // against whatever session is current by the time it's actually invoked. If LinkedAccounts holds
  // onto this instance across a lifecycle change (its own async refresh resolving after the
  // component tree it lived in has already been replaced by a new lifecycle's — deliberately not
  // relied upon as the ownership mechanism, since an unmounted component's own already-in-flight
  // promise chain still runs and can still call a prop function it captured), this catches it.
  //
  // `itemsVersionAtRender` closes the SAME-session gap the session check alone can't: if a newer
  // grouped or targeted items read has already committed since this callback instance was created
  // (handed to LinkedAccounts as the `onRefreshed` prop), this callback's own — now stale — items
  // must not overwrite it, even though nothing about the lifecycle itself changed. It's captured
  // the same way `sessionId` is (a plain render-scoped read, not `resourceVersionsRef.current.items`
  // read fresh at call time, which would trivially always match itself and protect nothing): every
  // render reads whatever `resourceVersionsRef.current.items` is at that moment, and the specific
  // function instance LinkedAccounts ends up holding when the user actually clicks "Refresh
  // balances" is whichever render most recently produced one, i.e. the version that was current
  // when this refresh effectively began. On success this bumps the counter itself before writing,
  // so it correctly supersedes anything reserved even earlier than that in turn.
  const itemsVersionAtRender = resourceVersionsRef.current.items;
  async function handleAccountsRefreshed(newItems: LinkedItem[]) {
    const expectedSessionId = sessionId;
    if (expectedSessionId !== sessionIdRef.current) return;
    if (itemsVersionAtRender !== resourceVersionsRef.current.items) return;
    resourceVersionsRef.current.items += 1;
    setItems(newItems);
    // The backend records a net worth snapshot, refreshes loan/liability details, and this view's
    // grouping all depend on the same freshly-fetched balances — refetch all four. Each of these
    // independently re-verifies session/resource ownership at its own commit — see their own
    // comments.
    applyReportingRange(reportingRangeRef.current);
    refreshLoans();
    refreshAssetsSummary();
  }

  async function handleUpdateCreditLimit(accountId: string, creditLimit: number | null) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateAccountCreditLimit(accountId, creditLimit);
      if (isStillCurrentSession(expectedSessionId)) {
        setItems((prev) =>
          prev.map((item) => ({
            ...item,
            accounts: item.accounts.map((a) => (a.id === accountId ? res.account : a)),
          }))
        );
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to update credit limit');
      }
    }
  }

  async function handleUpdateSavingsGoal(accountId: string, savingsGoal: number | null) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateAccountSavingsGoal(accountId, savingsGoal);
      if (isStillCurrentSession(expectedSessionId)) {
        setAssetGroups((prev) =>
          prev.map((group) => ({
            ...group,
            accounts: group.accounts.map((a) =>
              a.id === accountId ? { ...a, savings_goal: res.account.savings_goal } : a
            ),
          }))
        );
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to update savings goal');
      }
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
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateAccountCustomization(accountId, fields);
      if (!isStillCurrentSession(expectedSessionId)) return;
      setItems((prev) =>
        prev.map((item) => ({
          ...item,
          accounts: item.accounts.map((a) => (a.id === accountId ? res.account : a)),
        }))
      );
      // hidden/exclude_from_net_worth change which accounts appear in or count toward
      // assets-summary's grouped totals — simplest to refetch rather than hand-patch a
      // filtered, grouped structure locally. Each of these independently re-verifies
      // session/resource ownership at its own commit — see their own comments.
      refreshAssetsSummary();
      if (fields.exclude_from_net_worth !== undefined) {
        // The backend already re-snapshotted today's net worth on this change — refresh the
        // live stat and the chart so both reflect it immediately, not just at the next sync.
        applyReportingRange(reportingRangeRef.current);
      }
      if (fields.exclude_from_cash_flow !== undefined) {
        applyReportingRange(reportingRangeRef.current);
        refreshBudgetCategories();
        refreshRecurringStreams();
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to update account');
      }
    }
  }

  async function handleSyncTransactions() {
    setSyncing(true);
    setActionError(null);
    // See resourceVersionsRef's own comment — shared with handleSaveCategoryMapping's own backfill
    // refetch below, since both refetch the same `transactions` resource.
    const expectedSessionId = sessionIdRef.current;
    const version = ++resourceVersionsRef.current.transactions;
    try {
      await syncTransactionsRequest();
      const res = await getTransactions(TRANSACTIONS_FETCH_LIMIT);
      if (expectedSessionId !== sessionIdRef.current || version !== resourceVersionsRef.current.transactions) {
        return;
      }
      setTransactions(res.transactions);
      applyReportingRange(reportingRangeRef.current);
      refreshBudgetCategories();
      // Recurring-stream detection is also refreshed server-side as part of every sync
      // (manual or webhook-driven) — refetch here so this tab reflects that without a reload.
      refreshRecurringStreams();
    } catch (err) {
      if (expectedSessionId === sessionIdRef.current) {
        setActionError(err instanceof Error ? err.message : 'Failed to sync transactions');
      }
    } finally {
      setSyncing(false);
    }
  }

  async function handleCategorize(transactionId: string, budgetCategoryId: string | null) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      // The PATCH response is a bare `transactions` row with no joined accounts/plaid_items,
      // unlike the list endpoint — merge just the changed field instead of replacing the item.
      await setTransactionCategory(transactionId, budgetCategoryId);
      if (isStillCurrentSession(expectedSessionId)) {
        setTransactions((prev) =>
          prev.map((t) => (t.id === transactionId ? { ...t, budget_category_id: budgetCategoryId } : t))
        );
        refreshBudgetCategories();
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to update category');
      }
    }
  }

  async function handleApproveTransaction(transactionId: string) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      await approveTransaction(transactionId);
      if (isStillCurrentSession(expectedSessionId)) {
        setTransactions((prev) =>
          prev.map((t) => (t.id === transactionId ? { ...t, needs_review: false } : t))
        );
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to approve transaction');
      }
    }
  }

  // Left to throw rather than setting actionError — SplitEditor catches this itself and shows
  // the message inline next to the line items, which is more useful than a page-level banner. The
  // session check below still applies — a stale lifecycle's own error handling is SplitEditor's
  // business, but its successful response must not mutate a NEWER lifecycle's transactions.
  async function handleSaveTransactionSplits(
    transactionId: string,
    splits: { budget_category_id: string; amount: number }[]
  ) {
    const expectedSessionId = sessionIdRef.current;
    const res = await saveTransactionSplits(transactionId, splits);
    if (isStillCurrentSession(expectedSessionId)) {
      setTransactions((prev) => prev.map((t) => (t.id === transactionId ? { ...t, splits: res.splits } : t)));
      refreshBudgetCategories();
    }
  }

  async function handleClearTransactionSplits(transactionId: string) {
    const expectedSessionId = sessionIdRef.current;
    await clearTransactionSplits(transactionId);
    if (isStillCurrentSession(expectedSessionId)) {
      setTransactions((prev) => prev.map((t) => (t.id === transactionId ? { ...t, splits: [] } : t)));
      refreshBudgetCategories();
    }
  }

  async function handleCreateCategory(
    name: string,
    budgetAmount: number,
    emoji: string | null,
    color: string | null
  ) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await createBudgetCategory({ name, budget_amount: budgetAmount, emoji, color });
      // A brand-new category has no transactions assigned to it yet, so both derived fields
      // are always 0 — no need to refetch just to fill in values we already know.
      if (isStillCurrentSession(expectedSessionId)) {
        setBudgetCategories((prev) => [...prev, { ...res.category, spent: 0, recent_avg_spent: 0 }]);
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to create category');
      }
    }
  }

  async function handleUpdateCategory(id: string, budgetAmount: number) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateBudgetCategory(id, { budget_amount: budgetAmount });
      // Merge rather than replace — the response has no spent/recent_avg_spent, and changing
      // budget_amount doesn't change how much has actually been spent, so keep what's there.
      if (isStillCurrentSession(expectedSessionId)) {
        setBudgetCategories((prev) => prev.map((c) => (c.id === id ? { ...c, ...res.category } : c)));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to update category');
      }
    }
  }

  async function handleUpdateCategoryEmoji(id: string, emoji: string | null) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateBudgetCategory(id, { emoji });
      if (isStillCurrentSession(expectedSessionId)) {
        setBudgetCategories((prev) => prev.map((c) => (c.id === id ? { ...c, ...res.category } : c)));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to update category emoji');
      }
    }
  }

  async function handleUpdateCategoryColor(id: string, color: string | null) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateBudgetCategory(id, { color });
      if (isStillCurrentSession(expectedSessionId)) {
        setBudgetCategories((prev) => prev.map((c) => (c.id === id ? { ...c, ...res.category } : c)));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to update category color');
      }
    }
  }

  async function handleReorderCategory(id: string, sortOrder: number) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateBudgetCategory(id, { sort_order: sortOrder });
      if (isStillCurrentSession(expectedSessionId)) {
        setBudgetCategories((prev) => prev.map((c) => (c.id === id ? { ...c, ...res.category } : c)));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to reorder categories');
      }
    }
  }

  async function handleArchiveCategory(id: string) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateBudgetCategory(id, { archived: true });
      if (isStillCurrentSession(expectedSessionId)) {
        setBudgetCategories((prev) => prev.map((c) => (c.id === id ? { ...c, ...res.category } : c)));
        // Archiving removes any mapping that targeted this category server-side (so future synced
        // transactions stop landing here) — drop those from local state too, without a refetch.
        // Same session check: both writes represent ONE mutation response, so they stand or fall
        // together.
        if (res.removed_mapping_ids && res.removed_mapping_ids.length > 0) {
          const removed = new Set(res.removed_mapping_ids);
          setCategoryMappings((prev) => prev.filter((m) => !removed.has(m.id)));
        }
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to archive category');
      }
    }
  }

  async function handleUnarchiveCategory(id: string) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateBudgetCategory(id, { archived: false });
      if (isStillCurrentSession(expectedSessionId)) {
        setBudgetCategories((prev) => prev.map((c) => (c.id === id ? { ...c, ...res.category } : c)));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to unarchive category');
      }
    }
  }

  async function handleSaveCategoryMapping(
    plaidCategory: string,
    budgetCategoryId: string,
    backfill: boolean
  ): Promise<number> {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await saveCategoryMapping(plaidCategory, budgetCategoryId, backfill);
      if (isStillCurrentSession(expectedSessionId)) {
        setCategoryMappings((prev) => [...prev.filter((m) => m.plaid_category !== plaidCategory), res.mapping]);
      }
      if (backfill && res.backfilled_count > 0) {
        // Backfilling updates transaction rows directly in the database — refetch so the
        // Accounts and Budget tabs reflect the newly-assigned categories. Shares the
        // `transactions` bucket in resourceVersionsRef with handleSyncTransactions's own
        // refetch — see that function's own comment.
        const version = ++resourceVersionsRef.current.transactions;
        const transactionsRes = await getTransactions(TRANSACTIONS_FETCH_LIMIT);
        if (isStillCurrentSession(expectedSessionId) && version === resourceVersionsRef.current.transactions) {
          setTransactions(transactionsRes.transactions);
        }
        refreshBudgetCategories();
      }
      return res.backfilled_count;
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to save category mapping');
      }
      throw err;
    }
  }

  async function handleDeleteCategoryMapping(id: string) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      await deleteCategoryMapping(id);
      if (isStillCurrentSession(expectedSessionId)) {
        setCategoryMappings((prev) => prev.filter((m) => m.id !== id));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to remove category mapping');
      }
    }
  }

  async function handleCreateManualLoan(input: ManualLoanInput) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await createManualLoan(input);
      if (isStillCurrentSession(expectedSessionId)) {
        setManualLoans((prev) => [...prev, res.loan]);
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to add loan');
      }
    }
  }

  async function handleUpdateManualLoan(id: string, input: ManualLoanInput) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateManualLoan(id, input);
      if (isStillCurrentSession(expectedSessionId)) {
        setManualLoans((prev) => prev.map((l) => (l.id === id ? res.loan : l)));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to update loan');
      }
    }
  }

  async function handleDeleteManualLoan(id: string) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      await deleteManualLoan(id);
      if (isStillCurrentSession(expectedSessionId)) {
        setManualLoans((prev) => prev.filter((l) => l.id !== id));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to delete loan');
      }
    }
  }

  async function handleFetchPayments(loanId: string): Promise<LoanPayment[]> {
    const res = await getLoanPayments(loanId);
    return res.payments;
  }

  async function handleUpdateLinkedPayment(loanId: string, transactionId: string, principalPortion: number) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateLinkedLoanPayment(loanId, transactionId, principalPortion);
      if (isStillCurrentSession(expectedSessionId)) {
        setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to update payment');
      }
      throw err;
    }
  }

  async function handleUnlinkPayment(loanId: string, transactionId: string) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await unlinkLoanPayment(loanId, transactionId);
      if (isStillCurrentSession(expectedSessionId)) {
        setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to unlink payment');
      }
      throw err;
    }
  }

  async function handleCreateManualPayment(loanId: string, input: ManualPaymentInput) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await createManualPayment(loanId, input);
      if (isStillCurrentSession(expectedSessionId)) {
        setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to log payment');
      }
      throw err;
    }
  }

  async function handleUpdateManualPayment(loanId: string, paymentId: string, input: ManualPaymentInput) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await updateManualPayment(loanId, paymentId, input);
      if (isStillCurrentSession(expectedSessionId)) {
        setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to update payment');
      }
      throw err;
    }
  }

  async function handleDeleteManualPayment(loanId: string, paymentId: string) {
    setActionError(null);
    const expectedSessionId = sessionIdRef.current;
    try {
      const res = await deleteManualPayment(loanId, paymentId);
      if (isStillCurrentSession(expectedSessionId)) {
        setManualLoans((prev) => prev.map((l) => (l.id === loanId ? res.loan : l)));
      }
    } catch (err) {
      if (isStillCurrentSession(expectedSessionId)) {
        setActionError(err instanceof Error ? err.message : 'Failed to delete payment');
      }
      throw err;
    }
  }

  // Active-only view for anything that budgets/selects going forward (remaining-budget math, the
  // mapping target list) — components that need to resolve or offer an already-archived category
  // (transaction/split editing, the Budget tab's own archived section) keep receiving the full
  // budgetCategories array and decide per-row whether to surface it.
  const activeBudgetCategories = budgetCategories.filter((c) => c.archived_at === null);

  // A successful Plaid link changes account balances, which can change every one of the three
  // range-dependent datasets (spending summary, net worth history, monthly breakdown) —
  // refreshFinancialData alone doesn't cover them (see applyReportingRange's own comment for why
  // they were split out), so this refreshes both halves explicitly: the ordinary account/
  // transaction batch refreshFinancialData owns, and the three range-dependent datasets for
  // whatever range is currently selected, via the same applyReportingRange pathway a user's own
  // range change uses — no duplicated fetch/calculation logic, and the same request-id ownership
  // protection applies automatically (a fresh id is minted for this call, so it can never be
  // overtaken by, or overtake, an unrelated in-flight range fetch). Deliberately does NOT call
  // bootstrapPreferences — a successful Plaid link has nothing to do with the user's preferences,
  // and re-bootstrapping them here would risk an in-flight preference save's not-yet-persisted
  // server state getting silently clobbered the next time that hook's local edit round-trips (see
  // refreshFinancialData's own comment for the fuller failure story this avoids). Fired without
  // awaiting refreshFinancialData first: applyReportingRange only needs reportingRangeRef.current,
  // which is already whatever this lifecycle's own useReportingRange last reported — it doesn't
  // depend on this particular refreshFinancialData call's own results.
  //
  // If a Plaid link succeeds before the current lifecycle's own financial data has ever loaded
  // (financialLifecycleStatus still 'loading' or 'error'), this call's own refreshFinancialData()
  // invocation is automatically readiness-producing (see that function's own comment) — it isn't a
  // special case here at all, just the same self-determining behavior every invocation gets.
  function handlePlaidLinked() {
    refreshFinancialData();
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
          {loading && <span className="hint">Refreshing…</span>}
          <PlaidLink onLinked={handlePlaidLinked} />
          <button className="link-button" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        </div>
      </header>

      {actionError && <p className="error">{actionError}</p>}

      {/* NavLayoutScope sits outside any preference-bootstrap check deliberately: `loading` is a
          general "some background data fetch is in flight" flag (set by refreshFinancialData,
          including calls with nothing to do with authentication, e.g. PlaidLink's onLinked) — it
          must only ever affect what's rendered *inside* the authenticated scope (see the small
          "Refreshing…" indicator in the header above), never whether NavLayoutScope or
          PreferencesScope themselves exist. Only `key={sessionId}` controls that. sessionId!
          below: this JSX only renders once the earlier `!session` early return has already
          confirmed we're authenticated, and `session`/`sessionId` are always set together,
          atomically, by the same reducer action — TypeScript just can't see that correlation
          across two destructured fields.

          PreferencesScope, by contrast, is deliberately NOT rendered at all — not even with an
          undefined `saved` — until `preferencesStatus === 'ready'`. `preferencesStatus` is driven
          *only* by bootstrapPreferences (see that function's own comment), never by
          refreshFinancialData/`loading` — this is what makes the distinction above load-bearing:
          once a lifecycle's bootstrap has actually succeeded once, no amount of ordinary
          background loading can ever send this back through the "Loading..."/"Retry" branches
          and re-mount (and thereby reset) PreferencesScope's four hooks or any in-flight save
          they're tracking. This is also what actually closes the "ready content renders before
          the hooks have hydrated" gap: PreferencesScope's four hooks initialize their state
          directly from `saved` (a `useState` lazy initializer, not a later passive-effect copy —
          see that component's own doc comment), so the very first render of a freshly mounted
          instance already has the real values. The only way that's true is if mounting itself
          waits until the real payload exists — so `preferencesStatus === 'loading'`/`'error'` are
          checked and returned from *before* PreferencesScope is ever reached, not passed into it
          as a prop for it to react to.

          A THIRD, independent gate lives just inside PreferencesScope's own children (see the
          financialLifecycleStatus check there) for the current lifecycle's own INITIAL financial
          batch — the nine ordinary account/transaction/dashboard-data reads refreshFinancialData
          fetches. Preferences and that initial financial batch are kicked off in parallel (the
          session-change effect below fires both), so preferencesStatus can reach 'ready' — and
          PreferencesScope can mount — before the financial batch has finished. Without a separate
          gate for that, the tab content below (which reads items/transactions/budgetCategories/
          Safe-to-Spend's other inputs directly, not through any lifecycle-tagged derivation) could
          render whatever those pieces of App state already happened to hold — for a genuine new
          lifecycle, that's either misleading empty defaults or, worse, a still-retained previous
          lifecycle's financial data. financialLifecycleStatus is tagged by sessionId exactly like
          preferencesStatus (see its own derivation), so a stale prior lifecycle's 'ready' can never
          read as the new one's; unlike preferencesStatus, an ordinary background refresh (Plaid, an
          account sync, ...) never touches it at all (see refreshFinancialData's own comment), so —
          just like the preferences gate — it can only ever move away from 'ready' for a genuine new
          lifecycle, never for background activity mid-session. This is nested inside
          PreferencesScope, not layered alongside it at this level, specifically so that a still-
          loading or failed initial financial batch can never cause PreferencesScope itself (and the
          four hooks/save-status it owns) to be replaced or reset. */}
      <NavLayoutScope
        key={sessionId!}
        userId={userId}
        sessionId={sessionId!}
        isSessionCurrent={isSessionCurrent}
        coordinator={navigationWriteCoordinator}
        saved={navLayoutRawForCurrentSession}
      >
        {(navLayout) => {
          if (preferencesStatus === 'loading') return <p className="hint">Loading...</p>;
          if (preferencesStatus === 'error') {
            return (
              <p className="error">
                Couldn't load your preferences.{' '}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    bootstrapPreferences();
                    // A full-backend-outage recovery: if the current lifecycle's initial financial
                    // batch also hasn't succeeded yet, this one Retry click resolves both, rather
                    // than requiring a second click once this gate finally lets the user reach the
                    // financial-error gate's own Retry below. Skipped when financial data is
                    // already 'ready' (e.g. only preferences failed) — never refetch something
                    // that already succeeded merely because a sibling bootstrap failed.
                    if (financialLifecycleStatus !== 'ready') refreshFinancialData();
                  }}
                >
                  Retry
                </button>
              </p>
            );
          }
          // preferencesStatus === 'ready' here — preferencesForCurrentSession is guaranteed
          // defined by construction (both are derived together from the same
          // preferencesOutcomeForCurrentSession value above); TypeScript can't see that
          // correlation across two separately-named derived values, hence the assertion — mirrors
          // the existing `sessionId!` pattern used above for the same reason.
          const currentPreferences = preferencesForCurrentSession!;

          return (
            <PreferencesScope
              key={sessionId!}
              userId={userId}
              sessionId={sessionId!}
              isSessionCurrent={isSessionCurrent}
              saved={currentPreferences}
              onReportingRangeReady={applyReportingRange}
            >
              {({ dashboardLayout, appearance, financialPreferences, reportingRange }) => {
              // A second, independent gate nested *inside* PreferencesScope — deliberately not
              // merged with the preferencesStatus gate above. Preferences and the initial
              // financial batch are fetched in parallel from the same session-change effect (see
              // that effect's own comment); if the current lifecycle's financial batch hasn't
              // finished (or failed) yet, financial-dependent content — every tab below, including
              // Safe to Spend — must stay hidden even though PreferencesScope itself is already
              // mounted and its four hooks are already hydrated. Being nested here rather than
              // replacing PreferencesScope (the way the OLD combined `loading` gate incorrectly
              // did — see Round 4's own history) means this can never unmount PreferencesScope: a
              // background refresh (Plaid, account sync, ...) that starts *after* this session has
              // already reached readiness never touches financialOutcome (see refreshFinancialData's
              // own comment on isReadinessProducing), so financialLifecycleStatus only ever leaves
              // 'ready' for a genuine new lifecycle, never for such background activity mid-session.
              if (financialLifecycleStatus === 'loading') {
                return <p className="hint">Loading your financial data...</p>;
              }
              if (financialLifecycleStatus === 'error') {
                return (
                  <p className="error">
                    Couldn't load your financial data.{' '}
                    <button type="button" className="link-button" onClick={() => refreshFinancialData()}>
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
          );
        }}
      </NavLayoutScope>
    </div>
  );
}
