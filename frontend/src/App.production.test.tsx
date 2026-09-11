// @vitest-environment jsdom
//
// Renders the real, default-exported `<App>` end to end for the specific guarantees Codex found
// PreferencesHarness insufficient to prove (App.integration.test.tsx's own comments there explain
// why, and what remains covered there instead): stale preference-outcome protection, "ready means
// actually hydrated," full lifecycle/range ownership for the three reporting-range datasets, and
// Plaid-link refresh. Nothing here re-implements any of App.tsx's own preferencesOutcome/
// preferencesStatus/applyReportingRange/handlePlaidLinked logic — this file only supplies fake
// auth events and controls the handful of lib/api.ts data functions App actually depends on,
// exactly the way a real browser's network layer would, and then asserts on what the real
// component actually renders.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import type { UserPreferences } from './lib/api';

const mockGetSession = vi.hoisted(() => vi.fn());
const mockOnAuthStateChange = vi.hoisted(() => vi.fn());
vi.mock('./lib/supabaseClient', () => ({
  supabase: {
    auth: { getSession: mockGetSession, onAuthStateChange: mockOnAuthStateChange, signOut: vi.fn() },
  },
}));

// The four data functions this file actually controls per-test (deferred/sequenced responses).
// Everything else lib/api.ts exports is either passed through unchanged (types, and any function
// no test here ever calls) or stubbed to resolve trivially (see the mock factory below) so
// refreshAll()'s Promise.allSettled settles quickly and cleanly without every test having to wire
// up 9 out-of-scope datasets it doesn't care about.
const mockGetUserPreferences = vi.hoisted(() => vi.fn());
const mockGetSpendingSummary = vi.hoisted(() => vi.fn());
const mockGetNetWorthHistory = vi.hoisted(() => vi.fn());
const mockGetMonthlyBreakdown = vi.hoisted(() => vi.fn());
// Controlled (rather than trivially stubbed) so Round 4's in-flight-save regression tests can hold
// a Financial Preferences PUT open and inspect exactly what payload a later save actually sends.
const mockUpdateFinancialPreferences = vi.hoisted(() => vi.fn());
// Controlled so the background-loading-indicator test can hold `loading` true on demand — one of
// refreshFinancialData's 9 out-of-scope datasets, otherwise trivially stubbed like its siblings.
const mockGetLinkedItems = vi.hoisted(() => vi.fn());
// Controlled so Round 5's financial-lifecycle tests can hold this one of the nine ordinary
// datasets open/reject it on demand, and distinguish "whose" financial data is currently rendered
// (via a distinctive account name in AccountQuickView, always visible on Overview by default).
const mockGetAssetsSummary = vi.hoisted(() => vi.fn());
// Controlled so the Navigation ownership regression test can inspect exactly what layout a save
// actually persists.
const mockUpdateNavLayout = vi.hoisted(() => vi.fn());
// Controlled so Round 6's ad-hoc-ownership regression tests can hold each of these single-resource
// refreshes open/reject them on demand and distinguish "whose" data landed.
const mockGetRecurringStreams = vi.hoisted(() => vi.fn());
const mockGetLoans = vi.hoisted(() => vi.fn());
const mockGetBudgetCategories = vi.hoisted(() => vi.fn());
const mockGetTransactions = vi.hoisted(() => vi.fn());
const mockSyncTransactions = vi.hoisted(() => vi.fn());
const mockRefreshAccountBalances = vi.hoisted(() => vi.fn());
// Controlled so Round 8's Accounts per-operation-ownership tests can drive a SECOND, independent
// account child operation (LinkedAccounts's sandbox "Simulate reauth" button) concurrently with
// "Refresh balances" — the "Refresh balances" button itself disables while its own request is in
// flight, so a distinct operation is needed to exercise two overlapping child operations from the
// same render.
const mockSandboxResetLogin = vi.hoisted(() => vi.fn());
// Controlled so Round 7's mutation-lifecycle-leakage regression tests can hold each mutation's own
// response open/reject it on demand.
const mockCreateManualLoan = vi.hoisted(() => vi.fn());
const mockApproveTransaction = vi.hoisted(() => vi.fn());
const mockCreateBudgetCategory = vi.hoisted(() => vi.fn());
const mockSaveCategoryMapping = vi.hoisted(() => vi.fn());
const mockGetPlaidCategories = vi.hoisted(() => vi.fn());
const mockGetCategoryMappings = vi.hoisted(() => vi.fn());

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>();
  return {
    ...actual,
    // Out-of-scope datasets (declared out of this remediation's boundary, same as the original
    // audit's own scope) — trivial, instantly-resolved stubs; their content is irrelevant here.
    getLinkedItems: mockGetLinkedItems,
    getTransactions: mockGetTransactions,
    getBudgetCategories: mockGetBudgetCategories,
    getRecurringStreams: mockGetRecurringStreams,
    getLoans: mockGetLoans,
    getAssetsSummary: mockGetAssetsSummary,
    getManualLoans: vi.fn().mockResolvedValue({ loans: [] }),
    getCategoryMappings: mockGetCategoryMappings,
    getPlaidCategories: mockGetPlaidCategories,
    syncTransactions: mockSyncTransactions,
    refreshAccountBalances: mockRefreshAccountBalances,
    sandboxResetLogin: mockSandboxResetLogin,
    sandboxFireWebhook: vi.fn().mockResolvedValue({}),
    createManualLoan: mockCreateManualLoan,
    approveTransaction: mockApproveTransaction,
    createBudgetCategory: mockCreateBudgetCategory,
    saveCategoryMapping: mockSaveCategoryMapping,
    // Not otherwise controlled — only used by the same-session ad-hoc-ordering test (toggling an
    // account checkbox), which just needs a well-formed account back so LinkedAccounts keeps
    // rendering correctly; the specific fields returned are irrelevant to what that test asserts.
    updateAccountCustomization: vi.fn().mockImplementation((accountId: string, fields: Record<string, unknown>) =>
      Promise.resolve({
        account: {
          id: accountId,
          name: 'Checking',
          official_name: null,
          type: 'depository',
          subtype: 'checking',
          mask: null,
          current_balance: 100,
          available_balance: 100,
          iso_currency_code: 'USD',
          credit_limit: null,
          savings_goal: null,
          nickname: null,
          color: null,
          icon: null,
          sort_order: 0,
          hidden: false,
          exclude_from_net_worth: false,
          exclude_from_cash_flow: false,
          ...fields,
        },
      })
    ),
    // Saves — not exercised by any case in this file (no test here clicks an edit control); stubbed
    // so nothing throws if a hook's own internal wiring ever reaches one.
    updateDashboardLayout: vi.fn().mockResolvedValue({ dashboard_layout: { cards: [] } }),
    updateAppearance: vi.fn().mockResolvedValue({ theme: 'system', accent_color: 'green' }),
    updateFinancialPreferences: mockUpdateFinancialPreferences,
    updateReportingRange: vi.fn().mockResolvedValue({ reporting_range: 'last_6_months' }),
    updateNavLayout: mockUpdateNavLayout,
    // PlaidLink's own two direct dependencies — PlaidLink calls createLinkToken() on mount; the
    // Plaid-link test in this file drives the rest through the mocked react-plaid-link hook below.
    createLinkToken: vi.fn().mockResolvedValue({ link_token: 'fake-link-token' }),
    exchangePublicToken: vi.fn().mockResolvedValue({}),
    // The four datasets this file actually controls.
    getUserPreferences: mockGetUserPreferences,
    getSpendingSummary: mockGetSpendingSummary,
    getNetWorthHistory: mockGetNetWorthHistory,
    getMonthlyBreakdown: mockGetMonthlyBreakdown,
  };
});

// react-plaid-link renders real Plaid UI/scripts in a browser — mocked so it never tries to do
// that in jsdom, and so the Plaid-link test can trigger a "successful link" by capturing and
// calling PlaidLink's own onSuccess callback directly, exactly as Plaid's real widget would.
let capturedPlaidOnSuccess: ((publicToken: string) => void) | null = null;
vi.mock('react-plaid-link', () => ({
  usePlaidLink: ({ onSuccess }: { onSuccess: (token: string) => void }) => {
    capturedPlaidOnSuccess = onSuccess;
    return { open: vi.fn(), ready: true };
  },
}));

interface FakeSession {
  user: { id: string };
  access_token: string;
}

/** Builds a session whose access_token is a real (unsigned) decodable JWT carrying the given
 *  session_id claim, so useAuthSession's real decodeSessionId pipeline is exercised end to end. */
function fakeSession(userId: string, sessionId: string): FakeSession {
  const base64url = (obj: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url({ sub: userId, session_id: sessionId });
  return { user: { id: userId }, access_token: `${header}.${payload}.fake-signature` };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type LiveCallback = (event: string, session: FakeSession | null) => void;
let currentFakeSession: FakeSession | null = null;
let latestLiveCallback: LiveCallback | null = null;

/** Simulates a live `onAuthStateChange` push — the only way any test here drives auth state, so
 *  every test exercises the real, exported `useAuthSession` hook App.tsx itself uses. */
function emitAuthEvent(session: FakeSession | null) {
  currentFakeSession = session;
  latestLiveCallback!('AUTH_EVENT', session);
}

/** Builds a full UserPreferences payload with sensible defaults, so each test only has to override
 *  the field(s) it actually cares about. */
function fakePreferences(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    dashboard_layout: null,
    nav_layout: null,
    theme: 'system',
    accent_color: 'green',
    minimum_cash_buffer: 0,
    upcoming_bills_days: 14,
    recent_avg_months: 2,
    savings_rate_target: 15,
    safe_to_spend_include_upcoming_bills: true,
    safe_to_spend_include_remaining_budget: true,
    reporting_range: 'last_6_months',
    ...overrides,
  };
}

/** Builds a getAssetsSummary() payload with one checking account whose name is the given,
 *  distinctive string — rendered directly by AccountQuickView (visible on Overview by default),
 *  giving Round 5's financial-lifecycle tests an easy, unambiguous "whose financial data is this"
 *  signal, independent of the range-dependent `summary`/net-worth state (which already has its own
 *  ownership coverage in the Round 3 tests above). */
function fakeAssetsSummary(accountName: string, balance = 1000) {
  return {
    groups: [
      {
        category: 'checking' as const,
        label: 'Checking',
        total: balance,
        accounts: [
          {
            id: `acct-${accountName}`,
            name: accountName,
            official_name: null,
            type: 'depository',
            subtype: 'checking',
            current_balance: balance,
            iso_currency_code: 'USD',
            institution_name: null,
            savings_goal: null,
            nickname: null,
            color: null,
            icon: null,
            sort_order: 0,
            hidden: false,
            exclude_from_net_worth: false,
          },
        ],
      },
    ],
    total_assets: balance,
  };
}

/** Builds a getLinkedItems() payload with one item whose institution name is the given,
 *  distinctive string — rendered directly by LinkedAccounts (Accounts tab). Used alongside
 *  fakeAssetsSummary to prove two sibling reads from the same refreshFinancialData invocation
 *  commit together. */
function fakeLinkedItems(institutionName: string) {
  return {
    items: [{ id: `item-${institutionName}`, institution_id: null, institution_name: institutionName, status: 'active' as const, accounts: [] }],
    is_sandbox: true,
  };
}

/** Builds a getLoans() payload with one loan whose name is the given, distinctive string —
 *  rendered directly by LoanProgress (Loans tab). */
function fakeLoans(name: string) {
  return {
    loans: [
      {
        id: `loan-${name}`,
        loan_type: 'credit' as const,
        name,
        account_name: null,
        current_balance: 100,
        iso_currency_code: 'USD',
        interest_rate_percentage: null,
        origination_principal_amount: null,
        origination_date: null,
        minimum_payment_amount: 10,
        next_payment_due_date: null,
        last_payment_amount: null,
        last_payment_date: null,
        is_overdue: false,
        payoff_progress_pct: null,
      },
    ],
    total_debt: 100,
    total_minimum_payment: 10,
  };
}

/** Builds a getRecurringStreams() payload with one stream whose description is the given,
 *  distinctive string — rendered directly by SubscriptionsRecurring (Subscriptions & Recurring
 *  tab). */
function fakeRecurringStreams(description: string) {
  return {
    streams: [
      {
        id: `stream-${description}`,
        description,
        merchant_name: null,
        direction: 'outflow' as const,
        frequency: 'monthly',
        average_amount: 50,
        last_amount: 50,
        iso_currency_code: 'USD',
        first_date: '2026-01-01',
        last_date: '2026-09-01',
        is_active: true,
        status: 'active',
        category: null,
        monthly_amount: 50,
      },
    ],
    total_monthly_outflow: 50,
    total_monthly_inflow: 0,
  };
}

/** Builds a getBudgetCategories() payload with one category whose name is the given, distinctive
 *  string — rendered directly by BudgetCategories (Budget tab). */
function fakeBudgetCategories(name: string) {
  return {
    categories: [
      { id: `cat-${name}`, name, budget_amount: 100, color: null, sort_order: 0, emoji: null, archived_at: null, spent: 0, recent_avg_spent: 0 },
    ],
  };
}

/** Builds a getTransactions() payload with one transaction whose name is the given, distinctive
 *  string — rendered directly by TransactionsFeed (Accounts tab). */
function fakeTransactions(name: string) {
  return {
    transactions: [
      {
        id: `txn-${name}`,
        amount: 10,
        iso_currency_code: 'USD',
        date: '2026-09-01',
        name,
        merchant_name: null,
        category: null,
        plaid_category: null,
        pending: false,
        budget_category_id: null,
        needs_review: false,
        splits: [],
        accounts: { name: 'Checking', nickname: null, plaid_items: { institution_name: null } },
      },
    ],
  };
}

/** A transaction fixture that takes an explicit id (rather than deriving one from `name`) and a
 *  `needsReview` flag — used by the mutation-lifecycle tests, which deliberately give A's and B's
 *  transaction the SAME id (simulating the coincidental-collision case a keyed functional-updater
 *  patch would otherwise still silently apply across) to prove the session guard, not just the
 *  (already-guaranteed-safe-by-id-mismatch) common case. */
function fakeTransactionNeedingReview(id: string, name: string, needsReview: boolean) {
  return {
    transactions: [
      {
        id,
        amount: 10,
        iso_currency_code: 'USD',
        date: '2026-09-01',
        name,
        merchant_name: null,
        category: null,
        plaid_category: null,
        pending: false,
        budget_category_id: null,
        needs_review: needsReview,
        splits: [],
        accounts: { name: 'Checking', nickname: null, plaid_items: { institution_name: null } },
      },
    ],
  };
}

/** Builds a createManualLoan()-shaped `{ loan }` response with a distinctive name — rendered
 *  directly by LoanProgress (Loans tab). */
function fakeManualLoan(name: string) {
  return {
    loan: {
      id: `loan-${name}`,
      name,
      loan_type: 'personal' as const,
      current_balance: 500,
      origination_principal_amount: null,
      interest_rate_percentage: null,
      origination_date: null,
      term_months: null,
      minimum_payment_amount: null,
      next_payment_due_date: null,
      notes: null,
      match_text: null,
      payoff_progress_pct: null,
      lifetime_principal_paid: 0,
      lifetime_interest_paid: 0,
    },
  };
}

/** Builds a getLinkedItems() payload with one item that has one real, full-shaped account —
 *  needed (unlike fakeLinkedItems) for the LinkedAccounts UI controls (the "Exclude from net
 *  worth" checkbox) that only render per-account. */
function fakeLinkedItemsWithAccount(institutionName: string, accountId: string) {
  return {
    items: [
      {
        id: `item-${institutionName}`,
        institution_id: null,
        institution_name: institutionName,
        status: 'active' as const,
        accounts: [
          {
            id: accountId,
            name: 'Checking',
            official_name: null,
            type: 'depository',
            subtype: 'checking',
            mask: null,
            current_balance: 100,
            available_balance: 100,
            iso_currency_code: 'USD',
            credit_limit: null,
            savings_goal: null,
            nickname: null,
            color: null,
            icon: null,
            sort_order: 0,
            hidden: false,
            exclude_from_net_worth: false,
            exclude_from_cash_flow: false,
          },
        ],
      },
    ],
    is_sandbox: true,
  };
}

const emptySummary = {
  net_worth: 0,
  total_assets: 0,
  total_liabilities: 0,
  monthly_spending: [] as { month: string; spent: number; income: number }[],
  current_month: { income: 0, spent: 0 },
};
const emptyNetWorthHistory = { history: [] };
const emptyMonthlyBreakdown = { months: [] };

/** Configures the three range-dependent datasets to resolve immediately with trivial/empty data —
 *  the default for tests that don't care about their content, only about preferences/hydration. */
function stubRangeDataTrivially() {
  mockGetSpendingSummary.mockResolvedValue(emptySummary);
  mockGetNetWorthHistory.mockResolvedValue(emptyNetWorthHistory);
  mockGetMonthlyBreakdown.mockResolvedValue(emptyMonthlyBreakdown);
}

async function waitForReady() {
  await waitFor(() => expect(screen.getByText('Customize dashboard')).toBeTruthy());
}

async function waitForLoading() {
  await waitFor(() => expect(screen.getByText('Loading...')).toBeTruthy());
}

async function waitForPreferencesError() {
  await waitFor(() => expect(screen.getByText(/Couldn't load your preferences/)).toBeTruthy());
}

/** Proves preferences are ready (PreferencesScope mounted) while the current lifecycle's initial
 *  financial batch is still pending — this text only ever renders from inside PreferencesScope's
 *  own children, so its presence is itself the signal, not just an absence check. */
async function waitForFinancialLoading() {
  await waitFor(() => expect(screen.getByText('Loading your financial data...')).toBeTruthy());
}

async function waitForFinancialError() {
  await waitFor(() => expect(screen.getByText(/Couldn't load your financial data/)).toBeTruthy());
}

/** Reads the Overview "Net worth" stat card's displayed value — `null` if the card isn't rendered
 *  at all (OverviewStats only renders once `summary` is non-null; App.tsx's applyReportingRange
 *  clears `summary` to `null` on every lifecycle change and at the start of every range attempt —
 *  see its own doc comment — so "the card disappears" is the clean, unambiguous signal for "no
 *  range data is currently being shown," never a stale or wrong-owner value lingering instead). */
function readNetWorth(): string | null {
  const label = screen.queryByText('Net worth');
  if (!label) return null;
  const card = label.closest('.stat-card');
  return card?.querySelector('.stat-value')?.textContent ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  currentFakeSession = null;
  latestLiveCallback = null;
  capturedPlaidOnSuccess = null;
  mockOnAuthStateChange.mockImplementation((cb: LiveCallback) => {
    latestLiveCallback = cb;
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  mockGetSession.mockImplementation(() => Promise.resolve({ data: { session: currentFakeSession } }));
  stubRangeDataTrivially();
  mockUpdateFinancialPreferences.mockResolvedValue({});
  mockGetLinkedItems.mockResolvedValue({ items: [], is_sandbox: true });
  mockGetAssetsSummary.mockResolvedValue({ groups: [], total_assets: 0 });
  mockUpdateNavLayout.mockResolvedValue({ nav_layout: { tabs: [] } });
  mockGetRecurringStreams.mockResolvedValue({ streams: [], total_monthly_outflow: 0, total_monthly_inflow: 0 });
  mockGetLoans.mockResolvedValue({ loans: [], total_debt: 0, total_minimum_payment: 0 });
  mockGetBudgetCategories.mockResolvedValue({ categories: [] });
  mockGetTransactions.mockResolvedValue({ transactions: [] });
  mockSyncTransactions.mockResolvedValue({});
  mockRefreshAccountBalances.mockResolvedValue({ items: [], is_sandbox: true });
  mockGetPlaidCategories.mockResolvedValue({ categories: [] });
  mockGetCategoryMappings.mockResolvedValue({ mappings: [] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('1-3. stale preference outcome cannot replace a newer current outcome (Blocker 1)', () => {
  it('A pending -> B ready -> A succeeds last: B remains ready', async () => {
    const aPrefs = deferred<UserPreferences>();
    mockGetUserPreferences.mockReturnValueOnce(aPrefs.promise);
    render(<App />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForLoading();

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences({ theme: 'dark' }));
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await waitForReady();
    expect(document.documentElement.dataset.theme).toBe('dark');

    // A's stale fetch finally resolves, after B is already ready.
    await act(async () => {
      aPrefs.resolve(fakePreferences({ theme: 'light' }));
      await aPrefs.promise.catch(() => {});
    });

    // B must remain fully ready and usable — not reverted to Loading, and not showing A's theme.
    expect(screen.getByText('Customize dashboard')).toBeTruthy();
    expect(screen.queryByText('Loading...')).toBeNull();
    expect(screen.queryByText(/Couldn't load your preferences/)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('A pending -> B ready -> A fails last: B remains ready', async () => {
    const aPrefs = deferred<UserPreferences>();
    mockGetUserPreferences.mockReturnValueOnce(aPrefs.promise);
    render(<App />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForLoading();

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences({ theme: 'dark' }));
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await waitForReady();

    // A's stale fetch finally rejects, after B is already ready.
    await act(async () => {
      aPrefs.reject(new Error('network down'));
      await aPrefs.promise.catch(() => {});
    });

    expect(screen.getByText('Customize dashboard')).toBeTruthy();
    expect(screen.queryByText(/Couldn't load your preferences/)).toBeNull();
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('A1 pending -> A3 ready (same user) -> A1 settles last: A3 remains ready', async () => {
    const a1Prefs = deferred<UserPreferences>();
    mockGetUserPreferences.mockReturnValueOnce(a1Prefs.promise);
    render(<App />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForLoading();

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences({ savings_rate_target: 25 }));
    act(() => emitAuthEvent(null));
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a3')));
    await waitForReady();

    await act(async () => {
      a1Prefs.resolve(fakePreferences({ savings_rate_target: 10 }));
      await a1Prefs.promise.catch(() => {});
    });

    expect(screen.getByText('Customize dashboard')).toBeTruthy();
    expect(screen.queryByText(/Couldn't load your preferences/)).toBeNull();
  });
});

describe('4-5. ready means the hooks are actually hydrated — no committed default frame (Blocker 2)', () => {
  it("B's first interactive render already contains B's hydrated Dashboard/Appearance/Reporting-Range values", async () => {
    mockGetUserPreferences.mockResolvedValue(
      fakePreferences({
        dashboard_layout: { cards: [{ id: 'safe_to_spend', visible: false }] },
        theme: 'dark',
        accent_color: 'blue',
        reporting_range: 'last_12_months',
      })
    );
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await waitForReady();

    // Appearance: applied to the document the instant this scope mounted.
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.accent).toBe('blue');

    // Reporting Range: the selector's first render already shows the saved range as selected.
    // Checked before opening the Dashboard Customizer below — ReportingRangeSelector is only
    // rendered while NOT customizing.
    const checkedRange = screen.getByRole('radio', { checked: true });
    expect(checkedRange.textContent).toBe('12 months');

    // Dashboard: the customizer's first render already reflects the saved (non-default) layout.
    act(() => screen.getByText('Customize dashboard').click());
    const safeToSpendRow = screen.getByText('Safe to spend').closest('.dashboard-customizer-row') as HTMLElement;
    expect(within(safeToSpendRow).getByText('Show')).toBeTruthy(); // hidden -> "Show" is offered
  });

  it('A3 Financial Preferences first render contains the server target 25, never the default 15', async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences({ savings_rate_target: 25 }));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a3')));
    await waitForReady();

    act(() => screen.getByText('Settings').click());
    act(() => screen.getByText('Financial Preferences').click());
    const savingsRow = screen.getByText('Savings-rate target').closest('.financial-prefs-row') as HTMLElement;
    const input = within(savingsRow).getByRole('spinbutton') as HTMLInputElement;
    expect(input.value).toBe('25'); // never the hook's own internal default (15)
  });
});

describe('6-7. range-dataset invalidation on lifecycle change (Blocker 3.A)', () => {
  it("A's range request, still in flight when B's lifecycle-change clear runs, cannot repopulate B", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    const aSummary = deferred<typeof emptySummary>();
    mockGetSpendingSummary.mockReturnValueOnce(aSummary.promise);
    render(<App />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady(); // A's preferences resolved; A's own summary request is still pending
    expect(readNetWorth()).toBeNull(); // not shown yet — still in flight

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetSpendingSummary.mockResolvedValueOnce({ ...emptySummary, net_worth: 222 });
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await waitFor(() => expect(readNetWorth()).toBe('$222')); // B's own request commits

    // A's stale summary request — issued before B's lifecycle-change clear invalidated it —
    // finally resolves, after B's own value is already showing.
    await act(async () => {
      aSummary.resolve({ ...emptySummary, net_worth: 999 });
      await aSummary.promise.catch(() => {});
    });

    expect(readNetWorth()).toBe('$222'); // never replaced by A's late 999
  });

  it('an old A1 range request cannot populate A3 (same user, different lifecycle)', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    const a1Summary = deferred<typeof emptySummary>();
    mockGetSpendingSummary.mockReturnValueOnce(a1Summary.promise);
    render(<App />);

    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    expect(readNetWorth()).toBeNull();

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetSpendingSummary.mockResolvedValueOnce({ ...emptySummary, net_worth: 333 });
    act(() => emitAuthEvent(null));
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a3')));
    await waitFor(() => expect(readNetWorth()).toBe('$333'));

    await act(async () => {
      a1Summary.resolve({ ...emptySummary, net_worth: 111 });
      await a1Summary.promise.catch(() => {});
    });

    expect(readNetWorth()).toBe('$333'); // never replaced by A1's late 111
  });
});

describe('8. a new range attempt must not display old-range data as current (Blocker 3.B)', () => {
  it('Range A -> Range B; B fails: A data is not shown underneath selector B', async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences()); // default range: last_6_months
    mockGetSpendingSummary.mockResolvedValueOnce({ ...emptySummary, net_worth: 100 });
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitFor(() => expect(readNetWorth()).toBe('$100'));

    // The user picks a new range; its own summary request fails.
    mockGetSpendingSummary.mockRejectedValueOnce(new Error('down'));
    const otherRangeButton = screen.getAllByRole('radio').find((btn) => btn.textContent !== '6 months')!;
    await act(async () => {
      otherRangeButton.click();
      await Promise.resolve().then(() => Promise.resolve()); // flush the rejected promise's microtask
    });

    // The old range's 100 must never still be showing under the new selection — cleared, not stale.
    expect(readNetWorth()).toBeNull();
  });
});

describe('9-10. every refresh group gets a fresh ownership id; siblings within one group still commit together (Blocker 3.C)', () => {
  it('two same-range refreshes overlap; the newer invocation wins regardless of resolution order', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    const firstSummary = deferred<typeof emptySummary>();
    mockGetSpendingSummary.mockReturnValueOnce(firstSummary.promise);
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    expect(readNetWorth()).toBeNull(); // hydration's own request still in flight

    // The user re-selects the already-current range before the first request ever resolves —
    // ReportingRangeSelector's onClick fires unconditionally, so this mints a second invocation
    // for the identical range while the first is still outstanding.
    const secondSummary = deferred<typeof emptySummary>();
    mockGetSpendingSummary.mockReturnValueOnce(secondSummary.promise);
    act(() => screen.getByRole('radio', { checked: true }).click());

    // The newer (second) invocation resolves first.
    await act(async () => {
      secondSummary.resolve({ ...emptySummary, net_worth: 555 });
      await secondSummary.promise;
    });
    await waitFor(() => expect(readNetWorth()).toBe('$555'));

    // The older (first) invocation resolves last — must not overwrite the newer one.
    await act(async () => {
      firstSummary.resolve({ ...emptySummary, net_worth: 111 });
      await firstSummary.promise.catch(() => {});
    });
    expect(readNetWorth()).toBe('$555');
  });

  it("one invocation's summary and monthly-breakdown sibling requests both commit normally", async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences());
    mockGetSpendingSummary.mockResolvedValueOnce({ ...emptySummary, net_worth: 42 });
    mockGetMonthlyBreakdown.mockResolvedValueOnce({
      months: [{ month: '2026-09', total_spent: 500, total_income: 1000, by_category: [] }],
    });
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitFor(() => expect(readNetWorth()).toBe('$42'));

    act(() => screen.getByText('Monthly Breakdown').click());
    // MonthlyBreakdown renders one heading per month in `months` — its presence is what proves
    // this sibling request committed alongside summary's.
    await waitFor(() => expect(screen.getByText('September 2026')).toBeTruthy());
  });
});

describe('11. preference failure -> Retry -> synchronous hydration -> range-data recovery (Blocker 4)', () => {
  it('a full failure/Retry/recovery cycle works end to end', async () => {
    mockGetUserPreferences.mockRejectedValueOnce(new Error('down'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForPreferencesError();
    expect(screen.queryByText('Customize dashboard')).toBeNull();

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences({ savings_rate_target: 25 }));
    mockGetSpendingSummary.mockResolvedValueOnce({ ...emptySummary, net_worth: 777 });
    act(() => screen.getByText('Retry').click());

    await waitForReady();
    // Range-data recovery, checked on Overview first (readNetWorth only finds anything there).
    await waitFor(() => expect(readNetWorth()).toBe('$777'));

    // Hydration is synchronous (Blocker 2's fix) — the Settings panel, reached immediately after
    // Retry succeeded, already shows the recovered server value.
    act(() => screen.getByText('Settings').click());
    act(() => screen.getByText('Financial Preferences').click());
    const savingsRow = screen.getByText('Savings-rate target').closest('.financial-prefs-row') as HTMLElement;
    expect((within(savingsRow).getByRole('spinbutton') as HTMLInputElement).value).toBe('25');
  });
});

describe('12. successful Plaid link refreshes range data through the same fresh-id-owned pathway', () => {
  it('a successful link fetches and commits a fresh range-data result', async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences());
    mockGetSpendingSummary.mockResolvedValueOnce({ ...emptySummary, net_worth: 100 });
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitFor(() => expect(readNetWorth()).toBe('$100'));

    mockGetSpendingSummary.mockResolvedValueOnce({ ...emptySummary, net_worth: 400 });
    expect(capturedPlaidOnSuccess).not.toBeNull();
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    await waitFor(() => expect(readNetWorth()).toBe('$400'));
  });
});

// --- Round 4: preference-bootstrap / background-refresh isolation -------------------------------
// Codex found that a single combined refreshAll() meant ANY background refresh — including a
// successful Plaid link, which has nothing to do with authentication — set the same `loading` flag
// the render body used to gate PreferencesScope's very existence, unmounting (and losing any
// in-flight save from) all four preference hooks for the duration of that unrelated refresh. App.tsx
// now splits this into bootstrapPreferences (preferences only, the only thing preferencesStatus
// depends on) and refreshFinancialData (everything else, including `loading`) — see both functions'
// own doc comments. These tests exercise that split, plus the latest-invocation ownership
// bootstrapPreferences needed for two overlapping same-session invocations (sessionId tagging alone
// already covered a *different* lifecycle's stale outcome — see the Round 3 tests above).

describe('13. a successful Plaid link does not unmount PreferencesScope or re-bootstrap preferences', () => {
  it('local dashboard-customizer UI state (never persisted) survives a Plaid-triggered background refresh', async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences());
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();

    // Purely local, never-persisted UI state — this can only still be true after a background
    // refresh if useDashboardLayout's instance inside PreferencesScope is literally the same one,
    // i.e. PreferencesScope never unmounted.
    act(() => screen.getByText('Customize dashboard').click());
    expect(screen.getByText('Done')).toBeTruthy();

    const preferencesCallsBefore = mockGetUserPreferences.mock.calls.length;
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    expect(screen.getByText('Done')).toBeTruthy(); // still open — PreferencesScope never remounted
    // Plaid must not perform an unrelated preference re-bootstrap at all.
    expect(mockGetUserPreferences.mock.calls.length).toBe(preferencesCallsBefore);
  });
});

describe('14. an in-flight Financial Preferences save survives a same-session Plaid refresh (critical regression)', () => {
  it('a pending PUT is not clobbered by Plaid, and a later sibling edit does not resurrect the stale pre-edit bundle', async () => {
    mockGetUserPreferences.mockResolvedValue(
      fakePreferences({ savings_rate_target: 15, minimum_cash_buffer: 100 })
    );
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();

    act(() => screen.getByText('Settings').click());
    act(() => screen.getByText('Financial Preferences').click());
    const savingsRow = screen.getByText('Savings-rate target').closest('.financial-prefs-row') as HTMLElement;
    const savingsInput = within(savingsRow).getByRole('spinbutton') as HTMLInputElement;
    expect(savingsInput.value).toBe('15');

    // Hold this save's PUT open — still in flight when Plaid succeeds below.
    const pendingPut = deferred<Record<string, unknown>>();
    mockUpdateFinancialPreferences.mockReturnValueOnce(pendingPut.promise);
    fireEvent.change(savingsInput, { target: { value: '30' } });
    fireEvent.blur(savingsInput);
    expect(savingsInput.value).toBe('30'); // local edit applies immediately, independent of the PUT

    const preferencesCallsBefore = mockGetUserPreferences.mock.calls.length;
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    // No unrelated re-bootstrap happened, and the locally-edited value is still what's shown/
    // editable — never reverted to the pre-edit server value of 15.
    expect(mockGetUserPreferences.mock.calls.length).toBe(preferencesCallsBefore);
    expect(savingsInput.value).toBe('30');

    // The original PUT now finally succeeds.
    await act(async () => {
      pendingPut.resolve({});
      await pendingPut.promise;
    });
    expect(savingsInput.value).toBe('30');

    // A later, sibling-field edit persists the FULL current bundle — it must reflect the
    // already-applied 30, never the stale pre-edit 15 the old server payload still held.
    const cashBufferRow = screen.getByText('Minimum cash buffer').closest('.financial-prefs-row') as HTMLElement;
    const cashBufferInput = within(cashBufferRow).getByRole('spinbutton') as HTMLInputElement;
    mockUpdateFinancialPreferences.mockResolvedValueOnce({});
    fireEvent.change(cashBufferInput, { target: { value: '250' } });
    await act(async () => {
      fireEvent.blur(cashBufferInput);
    });

    const lastCall = mockUpdateFinancialPreferences.mock.calls.at(-1)!;
    expect(lastCall[0]).toMatchObject({ savings_rate_target: 30, minimum_cash_buffer: 250 });
  });
});

describe('15. SaveStatusTracker survives a same-session Plaid/background refresh', () => {
  it('a pending save keeps showing "Saving…" through a Plaid refresh, then resolves normally', async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences({ savings_rate_target: 15 }));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Settings').click());
    act(() => screen.getByText('Financial Preferences').click());
    const savingsRow = screen.getByText('Savings-rate target').closest('.financial-prefs-row') as HTMLElement;
    const savingsInput = within(savingsRow).getByRole('spinbutton') as HTMLInputElement;

    const pendingPut = deferred<Record<string, unknown>>();
    mockUpdateFinancialPreferences.mockReturnValueOnce(pendingPut.promise);
    fireEvent.change(savingsInput, { target: { value: '20' } });
    fireEvent.blur(savingsInput);
    await waitFor(() => expect(screen.getByText('Saving…')).toBeTruthy());

    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    // The same SaveStatusTracker instance is still active — still "Saving…", not reset to idle
    // (which renders nothing) by an unrelated background refresh.
    expect(screen.getByText('Saving…')).toBeTruthy();

    await act(async () => {
      pendingPut.resolve({});
      await pendingPut.promise;
    });
    await waitFor(() => expect(screen.getByText('Saved ✓')).toBeTruthy());
  });
});

describe('16. ordinary background loading no longer sends an already-ready lifecycle back through the bootstrap gate', () => {
  it('shows a "Refreshing…" indicator without unmounting preference-dependent UI', async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences());
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    expect(screen.queryByText('Refreshing…')).toBeNull();

    // Held open so `loading` reliably stays true for this assertion regardless of exactly how many
    // microtask hops PlaidLink's own onSuccess (which awaits exchangePublicToken before calling
    // onLinked) takes to actually reach refreshFinancialData's setLoading(true).
    const pendingItems = deferred<{ items: unknown[]; is_sandbox: boolean }>();
    mockGetLinkedItems.mockReturnValueOnce(pendingItems.promise);

    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    expect(screen.getByText('Refreshing…')).toBeTruthy();
    // Preference-dependent UI (gated behind preferencesStatus, not loading) stays mounted.
    expect(screen.getByText('Customize dashboard')).toBeTruthy();
    expect(screen.queryByText('Loading...')).toBeNull();

    await act(async () => {
      pendingItems.resolve({ items: [], is_sandbox: true });
      await pendingItems.promise;
    });
    expect(screen.queryByText('Refreshing…')).toBeNull();
  });
});

describe('17. same-session stale preference SUCCESS cannot replace a newer current outcome (Blocker 2)', () => {
  it('retry #1 pending -> retry #2 succeeds -> retry #1 succeeds last: retry #2 remains current (also covers overlapping Retry attempts)', async () => {
    mockGetUserPreferences.mockRejectedValueOnce(new Error('initial failure'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForPreferencesError();

    const retry1 = deferred<UserPreferences>();
    mockGetUserPreferences.mockReturnValueOnce(retry1.promise);
    act(() => screen.getByText('Retry').click());
    // Still 'error' (retry #1 hasn't settled) — nothing disables Retry while a request is pending,
    // so a second, overlapping same-session attempt is reachable through the real DOM.
    await waitForPreferencesError();

    const retry2 = deferred<UserPreferences>();
    mockGetUserPreferences.mockReturnValueOnce(retry2.promise);
    act(() => screen.getByText('Retry').click());

    // The newer invocation (retry #2) succeeds first.
    await act(async () => {
      retry2.resolve(fakePreferences({ savings_rate_target: 42 }));
      await retry2.promise;
    });
    await waitForReady();

    // The older invocation (retry #1) succeeds last, with a different value — must not win, even
    // though both share the exact same sessionId.
    await act(async () => {
      retry1.resolve(fakePreferences({ savings_rate_target: 7 }));
      await retry1.promise.catch(() => {});
    });

    expect(screen.getByText('Customize dashboard')).toBeTruthy();
    act(() => screen.getByText('Settings').click());
    act(() => screen.getByText('Financial Preferences').click());
    const savingsRow = screen.getByText('Savings-rate target').closest('.financial-prefs-row') as HTMLElement;
    expect((within(savingsRow).getByRole('spinbutton') as HTMLInputElement).value).toBe('42');
  });
});

describe('18. same-session stale preference FAILURE cannot regress a newer ready outcome (Blocker 2)', () => {
  it('retry #1 pending -> retry #2 succeeds -> retry #1 fails last: state remains ready from retry #2', async () => {
    mockGetUserPreferences.mockRejectedValueOnce(new Error('initial failure'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForPreferencesError();

    const retry1 = deferred<UserPreferences>();
    mockGetUserPreferences.mockReturnValueOnce(retry1.promise);
    act(() => screen.getByText('Retry').click());
    await waitForPreferencesError();

    const retry2 = deferred<UserPreferences>();
    mockGetUserPreferences.mockReturnValueOnce(retry2.promise);
    act(() => screen.getByText('Retry').click());

    await act(async () => {
      retry2.resolve(fakePreferences());
      await retry2.promise;
    });
    await waitForReady();

    // The older, now-superseded retry finally rejects — must not regress the UI back to the error
    // gate; no request remains in flight to ever recover it if it did.
    await act(async () => {
      retry1.reject(new Error('stale failure'));
      await retry1.promise.catch(() => {});
    });

    expect(screen.getByText('Customize dashboard')).toBeTruthy();
    expect(screen.queryByText(/Couldn't load your preferences/)).toBeNull();
  });
});

describe('19. a successful Plaid link issues exactly one range-data refresh', () => {
  it('each range-dependent endpoint is called exactly once, not twice from a redundant scope remount', async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences());
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();

    const summaryCallsBefore = mockGetSpendingSummary.mock.calls.length;
    const historyCallsBefore = mockGetNetWorthHistory.mock.calls.length;
    const breakdownCallsBefore = mockGetMonthlyBreakdown.mock.calls.length;

    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    expect(mockGetSpendingSummary.mock.calls.length).toBe(summaryCallsBefore + 1);
    expect(mockGetNetWorthHistory.mock.calls.length).toBe(historyCallsBefore + 1);
    expect(mockGetMonthlyBreakdown.mock.calls.length).toBe(breakdownCallsBefore + 1);
  });
});

describe('20. a genuine lifecycle change still remounts PreferencesScope (contrast with Blocker 1)', () => {
  it('A -> B resets local dashboard-customizer UI state, unlike a same-session background refresh', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();

    act(() => screen.getByText('Customize dashboard').click());
    expect(screen.getByText('Done')).toBeTruthy();

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await waitForReady();

    // A genuine lifecycle change DOES remount PreferencesScope — B starts with the customizer
    // closed, not carrying over A's local UI state.
    expect(screen.queryByText('Done')).toBeNull();
  });
});

// --- Round 5: financial lifecycle readiness + Navigation bootstrap ownership --------------------
// Codex found two remaining gaps after Round 4: (1) preferences and the nine ordinary financial
// datasets are bootstrapped in parallel, so preferencesStatus could reach 'ready' — mounting
// PreferencesScope — before the current lifecycle's own financial data had ever loaded, exposing
// either misleading empty defaults (a genuinely new lifecycle) or a previous lifecycle's still-
// retained financial state; and (2) bootstrapPreferences's latest-invocation ownership protected
// preferencesOutcome but not navLayoutRaw/navLayoutRawSessionId, which were still written
// unconditionally, so an older same-session bootstrap response could overwrite Navigation's payload
// after a newer one had already been accepted. App.tsx now adds a third, independent
// financialLifecycleStatus gate (nested inside PreferencesScope, never replacing it) plus
// financialRequestIdRef ownership for the nine datasets' own commits, and treats every piece of
// state one bootstrapPreferences response can produce (navLayoutRaw included) as one atomic
// ownership domain gated by the same isLatest() check.

describe('21. slow initial financial load does not expose default/empty results as authoritative (Blocker 1)', () => {
  it('financial content stays gated behind a loading state until the initial batch resolves', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    const pendingAssets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(pendingAssets.promise);
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));

    // Preferences ready (proven by this gate rendering at all), financial batch still pending.
    await waitForFinancialLoading();
    expect(screen.queryByText('Customize dashboard')).toBeNull();
    expect(screen.queryByText('Safe to spend')).toBeNull();

    await act(async () => {
      pendingAssets.resolve(fakeAssetsSummary('A-Bank Checking'));
      await pendingAssets.promise;
    });

    await waitForReady();
    expect(screen.getByText(/A-Bank Checking/)).toBeTruthy();
  });
});

describe('22. A -> B: A\'s financial data must not render for B while B\'s initial batch is pending (Blocker 1)', () => {
  it('A loads fully with distinctive values; B shows neither A\'s data nor fake defaults while pending', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('A-Bank Checking'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    expect(screen.getByText(/A-Bank Checking/)).toBeTruthy();

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    const bAssets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(bAssets.promise);
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));

    await waitForFinancialLoading();
    expect(screen.queryByText(/A-Bank Checking/)).toBeNull();
    expect(screen.queryByText('Customize dashboard')).toBeNull();

    await act(async () => {
      bAssets.resolve(fakeAssetsSummary('B-Bank Savings'));
      await bAssets.promise;
    });
    await waitForReady();
    expect(screen.getByText(/B-Bank Savings/)).toBeTruthy();
    expect(screen.queryByText(/A-Bank Checking/)).toBeNull();
  });
});

describe('23. A1 -> A3 (same user, new session): retained financial data is excluded the same way (Blocker 1)', () => {
  it('A1 loads fully; A3 shows neither A1\'s data nor fake defaults while its own batch is pending', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('A1-Bank Checking'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    expect(screen.getByText(/A1-Bank Checking/)).toBeTruthy();

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    const a3Assets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(a3Assets.promise);
    act(() => emitAuthEvent(null));
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a3')));

    await waitForFinancialLoading();
    expect(screen.queryByText(/A1-Bank Checking/)).toBeNull();

    await act(async () => {
      a3Assets.resolve(fakeAssetsSummary('A3-Bank Savings'));
      await a3Assets.promise;
    });
    await waitForReady();
    expect(screen.getByText(/A3-Bank Savings/)).toBeTruthy();
    expect(screen.queryByText(/A1-Bank Checking/)).toBeNull();
  });
});

describe('24. a late-resolving previous-lifecycle financial request cannot mutate the current lifecycle\'s state (Blocker 1)', () => {
  it('A\'s stale assets response resolving after B is ready does not overwrite B', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    const aAssets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(aAssets.promise);
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForFinancialLoading(); // A's own batch still pending

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('B-Bank Checking'));
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await waitForReady();
    expect(screen.getByText(/B-Bank Checking/)).toBeTruthy();

    await act(async () => {
      aAssets.resolve(fakeAssetsSummary('A-Bank Checking'));
      await aAssets.promise.catch(() => {});
    });

    expect(screen.getByText(/B-Bank Checking/)).toBeTruthy();
    expect(screen.queryByText(/A-Bank Checking/)).toBeNull();
  });
});

describe('25. initial financial failure shows an explicit error/retry gate, not fake empty content (Blocker 1)', () => {
  it('preferences succeed, financial batch fails -> error gate (PreferencesScope stays mounted) -> Retry -> success', async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences({ theme: 'dark' }));
    mockGetLinkedItems.mockRejectedValueOnce(new Error('down'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForFinancialError();
    expect(screen.queryByText('Customize dashboard')).toBeNull();
    expect(screen.queryByText('Safe to spend')).toBeNull();
    // PreferencesScope's own hooks are already mounted/hydrated, independent of the financial
    // gate — the four hooks are called in PreferencesScope's own body, not inside the children
    // callback the financial gate short-circuits — proven here by useAppearance's mount effect
    // having already applied the real (non-default) theme to the document.
    expect(document.documentElement.dataset.theme).toBe('dark');

    mockGetLinkedItems.mockResolvedValueOnce({ items: [], is_sandbox: true });
    act(() => screen.getByText('Retry').click());

    await waitForReady();
    expect(document.documentElement.dataset.theme).toBe('dark'); // same hook instance throughout
  });
});

describe('26. full backend outage: one preference Retry also recovers an unresolved financial bootstrap (Blocker 1)', () => {
  it('both preference bootstrap and the initial financial batch fail; Retry recovers both without a second click', async () => {
    mockGetUserPreferences.mockRejectedValueOnce(new Error('down'));
    mockGetLinkedItems.mockRejectedValueOnce(new Error('down'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForPreferencesError();
    // The financial-error gate is never even reached yet — preferencesStatus itself is 'error'.
    expect(screen.queryByText(/Couldn't load your financial data/)).toBeNull();

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce({ items: [], is_sandbox: true });
    act(() => screen.getByText('Retry').click());

    await waitForReady();
    expect(screen.queryByText(/Couldn't load your preferences/)).toBeNull();
    expect(screen.queryByText(/Couldn't load your financial data/)).toBeNull();
  });
});

describe('27. same-session background refresh does not revert financial lifecycle readiness (Blocker 1)', () => {
  it('a Plaid-triggered background refresh keeps existing financial content visible, never re-enters the initial loading gate', async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences());
    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('A-Bank Checking'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    expect(screen.getByText(/A-Bank Checking/)).toBeTruthy();

    const pendingAssets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(pendingAssets.promise);
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve());
    });

    // Even with the background refresh's own assets request still pending, the last-valid current
    // data stays visible — never replaced by the initial "Loading your financial data..." gate.
    expect(screen.queryByText('Loading your financial data...')).toBeNull();
    expect(screen.getByText(/A-Bank Checking/)).toBeTruthy();

    await act(async () => {
      pendingAssets.resolve(fakeAssetsSummary('A-Bank Checking'));
      await pendingAssets.promise;
    });
  });
});

describe('28. overlapping background financial refresh invocations: the newer wins regardless of resolution order (Blocker 1)', () => {
  it('two overlapping Plaid-triggered refreshes; the older settling last does not overwrite the newer', async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences());
    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('Initial-Bank'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();

    const firstRefresh = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(firstRefresh.promise);
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token-1');
      await Promise.resolve();
    });

    const secondRefresh = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(secondRefresh.promise);
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token-2');
      await Promise.resolve();
    });

    await act(async () => {
      secondRefresh.resolve(fakeAssetsSummary('Newer-Bank'));
      await secondRefresh.promise;
    });
    await waitFor(() => expect(screen.getByText(/Newer-Bank/)).toBeTruthy());

    await act(async () => {
      firstRefresh.resolve(fakeAssetsSummary('Older-Bank'));
      await firstRefresh.promise.catch(() => {});
    });
    expect(screen.getByText(/Newer-Bank/)).toBeTruthy();
    expect(screen.queryByText(/Older-Bank/)).toBeNull();
  });
});

describe('29. all nine sibling financial reads from one invocation commit together (Blocker 1)', () => {
  it('one successful initial invocation commits both assetGroups (Overview) and items (Accounts tab)', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('Sibling-Bank'));
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('Sibling Institution'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();

    expect(screen.getByText(/Sibling-Bank/)).toBeTruthy(); // from getAssetsSummary
    act(() => screen.getByText('Accounts').click());
    expect(screen.getByText(/Sibling Institution/)).toBeTruthy(); // from getLinkedItems, same invocation
  });
});

describe('30. same-session stale bootstrap response cannot replace newer Navigation data (Blocker 2)', () => {
  it('retry #1 pending with layout A -> retry #2 succeeds with layout B -> retry #1 resolves last with layout A: Navigation reflects B, and a later save persists based on B', async () => {
    mockGetUserPreferences.mockRejectedValueOnce(new Error('initial failure'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForPreferencesError();

    const retry1 = deferred<UserPreferences>();
    mockGetUserPreferences.mockReturnValueOnce(retry1.promise);
    act(() => screen.getByText('Retry').click());
    await waitForPreferencesError(); // retry #1 still pending — Retry remains clickable

    const retry2 = deferred<UserPreferences>();
    mockGetUserPreferences.mockReturnValueOnce(retry2.promise);
    act(() => screen.getByText('Retry').click());

    const layoutB = [
      { id: 'monthly', visible: true },
      { id: 'budget', visible: true },
      { id: 'recurring', visible: true },
      { id: 'loans', visible: true },
      { id: 'income', visible: true },
      { id: 'accounts', visible: false },
    ];
    const layoutA = [
      { id: 'monthly', visible: true },
      { id: 'budget', visible: true },
      { id: 'recurring', visible: true },
      { id: 'loans', visible: false },
      { id: 'income', visible: true },
      { id: 'accounts', visible: true },
    ];

    // Both settle within the SAME batch — #2 (newer, B) first, #1 (older, A) immediately after,
    // with no intervening render/effect flush between the two. This is deliberate, not
    // incidental: useNavLayout has its own one-shot hydration guard (hydratedRef) that hydrates
    // from whichever value of `saved` its effect *actually observes* — if React had a chance to
    // commit and run that effect after B alone (as two separate `act()` calls would allow), the
    // effect would already be hydrated-and-locked onto B before A could ever be written, masking
    // the exact write-level bug under test (an unguarded navLayoutRaw write from a stale
    // invocation). Resolving both before yielding back to `act()` means React's own automatic
    // batching coalesces both state updates into ONE commit, so the effect only ever sees
    // whichever value was *written last* — reproducing Codex's exact "#1 later returns older
    // payload A before Navigation has hydrated" sequence.
    await act(async () => {
      retry2.resolve(fakePreferences({ nav_layout: { tabs: layoutB } }));
      retry1.resolve(fakePreferences({ nav_layout: { tabs: layoutA } }));
      await Promise.all([retry2.promise, retry1.promise.catch(() => {})]);
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });
    await waitForReady();

    // Final rendered Navigation must reflect B — the latest invocation — never the stale A that
    // happened to be *written* last at the state level.
    expect(screen.queryByRole('tab', { name: 'Loans' })).toBeTruthy();
    expect(screen.queryByRole('tab', { name: 'Accounts' })).toBeNull();

    // Perform a Navigation change and verify persistence is based on B, not stale A: toggling
    // 'monthly' (visible in both A and B, so the toggle itself doesn't distinguish them) should
    // still send 'accounts: visible=false' (B's own value) in the same save, never A's
    // 'accounts: visible=true'.
    act(() => screen.getByText('Settings').click());
    act(() => screen.getByText('Navigation').click());
    // 'Monthly Breakdown' also matches TabNav's own (still-rendered) tab button — find the
    // Navigation-settings row specifically via its distinct label class.
    const monthlyLabel = screen
      .getAllByText('Monthly Breakdown')
      .find((el) => el.className === 'dashboard-customizer-label')!;
    const monthlyRow = monthlyLabel.closest('.dashboard-customizer-row') as HTMLElement;
    await act(async () => {
      within(monthlyRow).getByText('Hide').click();
      await Promise.resolve();
    });

    await waitFor(() => expect(mockUpdateNavLayout).toHaveBeenCalled());
    const lastCall = mockUpdateNavLayout.mock.calls.at(-1)!;
    const savedTabs = (lastCall[0] as { tabs: { id: string; visible: boolean }[] }).tabs;
    const savedAccounts = savedTabs.find((t) => t.id === 'accounts');
    const savedMonthly = savedTabs.find((t) => t.id === 'monthly');
    expect(savedAccounts?.visible).toBe(false); // B's value, not stale A's `true`
    expect(savedMonthly?.visible).toBe(false); // the just-toggled field
  });

  it('an older same-session bootstrap FAILURE resolving after a newer success remains inert for Navigation too', async () => {
    mockGetUserPreferences.mockRejectedValueOnce(new Error('initial failure'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForPreferencesError();

    const retry1 = deferred<UserPreferences>();
    mockGetUserPreferences.mockReturnValueOnce(retry1.promise);
    act(() => screen.getByText('Retry').click());
    await waitForPreferencesError();

    const retry2 = deferred<UserPreferences>();
    mockGetUserPreferences.mockReturnValueOnce(retry2.promise);
    act(() => screen.getByText('Retry').click());

    await act(async () => {
      retry2.resolve(fakePreferences({ nav_layout: { tabs: [{ id: 'accounts', visible: false }] } }));
      await retry2.promise;
    });
    await waitForReady();
    expect(screen.queryByRole('tab', { name: 'Accounts' })).toBeNull();

    await act(async () => {
      retry1.reject(new Error('stale failure'));
      await retry1.promise.catch(() => {});
    });

    expect(screen.getByText('Customize dashboard')).toBeTruthy();
    expect(screen.queryByText(/Couldn't load your preferences/)).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Accounts' })).toBeNull(); // still B's layout
  });
});

// --- Round 6: readiness-orphan race + ad-hoc financial-refresh ownership ------------------------
// Codex found two remaining gaps after Round 5. Blocker 1: refreshFinancialData's `isInitial`
// caller-supplied flag meant a background/Plaid invocation that superseded the still-pending
// original initial invocation could commit all nine datasets but was forbidden from ever setting
// financialOutcome — while the original initial invocation, now superseded, could no longer commit
// anything either — permanently stranding financialLifecycleStatus at 'loading'. Fixed by making
// "readiness-producing" a property every invocation determines for itself at its own start (via
// financialReadySessionIdRef), not something a caller declares in advance. Blocker 2: the ad-hoc,
// single-resource refresh functions (refreshRecurringStreams, refreshLoans, refreshAssetsSummary,
// refreshBudgetCategories, and the two direct post-action transaction refetches) and the
// handleAccountsRefreshed callback committed their results with no ownership check at all — a slow
// A-initiated call could still land its data in current state well after B was fully ready, since
// the financialLifecycleStatus gate only protects the window *before* readiness, not indefinitely.
// Fixed with a session check (sessionIdRef.current, or the render-scoped `sessionId` closure for
// the externally-held callback) plus a lightweight per-resource invocation counter
// (adHocRequestIdsRef) at each call site's own commit.

describe('31. a background/Plaid refresh that supersedes the pending initial invocation becomes readiness-producing (Blocker 1)', () => {
  it('initial batch #1 still pending -> Plaid triggers #2 -> #2 succeeds -> financial gate reaches ready; #1 settling after is inert', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    const initialAssets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(initialAssets.promise);
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForFinancialLoading(); // #1 (initial) still pending

    // A successful Plaid link triggers a SECOND grouped invocation, #2, while #1 is still in
    // flight — this becomes the latest invocation and, since readiness has not been reached yet,
    // is therefore also readiness-producing (this is the exact fix under test: this would have
    // been forbidden from setting financialOutcome under Round 5's caller-supplied isInitial flag).
    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('Plaid-Bank'));
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    await waitForReady();
    expect(screen.getByText(/Plaid-Bank/)).toBeTruthy();

    // #1 (the original initial invocation) finally resolves — it must be completely inert: no
    // longer latest, so it cannot commit data or touch financialOutcome, even though it itself
    // was ALSO marked readiness-producing at its own start.
    await act(async () => {
      initialAssets.resolve(fakeAssetsSummary('Stale-Initial-Bank'));
      await initialAssets.promise.catch(() => {});
    });

    expect(screen.getByText(/Plaid-Bank/)).toBeTruthy();
    expect(screen.queryByText(/Stale-Initial-Bank/)).toBeNull();
    expect(screen.queryByText('Loading your financial data...')).toBeNull();
  });
});

describe('32. a newer pre-readiness invocation failing establishes the financial error state, not stuck loading (Blocker 1)', () => {
  it('#1 pending -> Plaid triggers #2 -> #2 fails -> financial error gate with Retry; #1 settling after cannot replace it', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    const initialAssets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(initialAssets.promise);
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForFinancialLoading();

    mockGetLinkedItems.mockRejectedValueOnce(new Error('down'));
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    await waitForFinancialError();
    expect(screen.getByText('Retry')).toBeTruthy();

    await act(async () => {
      initialAssets.resolve(fakeAssetsSummary('Stale-Initial-Bank'));
      await initialAssets.promise.catch(() => {});
    });

    expect(screen.getByText(/Couldn't load your financial data/)).toBeTruthy();
    expect(screen.queryByText(/Stale-Initial-Bank/)).toBeNull();
  });
});

describe('33. background refresh failure after readiness uses actionError, not the financial error gate (Blocker 1)', () => {
  it('a background refresh that fails after the lifecycle is ready keeps existing data visible and never shows the financial-retry gate', async () => {
    mockGetUserPreferences.mockResolvedValue(fakePreferences());
    // Persistent (not Once) — the Plaid-triggered background refresh below re-fetches this same
    // dataset too, and it should keep returning A's own current value on that call as well (this
    // test is about `getLinkedItems` failing, not about assets changing).
    mockGetAssetsSummary.mockResolvedValue(fakeAssetsSummary('A-Bank Checking'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    expect(screen.getByText(/A-Bank Checking/)).toBeTruthy();

    mockGetLinkedItems.mockRejectedValueOnce(new Error('down'));
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    expect(screen.getByText(/A-Bank Checking/)).toBeTruthy();
    expect(screen.queryByText(/Couldn't load your financial data/)).toBeNull();
    await waitFor(() => expect(screen.getByText(/Some dashboard data failed to load/)).toBeTruthy());
  });
});

describe('34. refreshRecurringStreams cross-lifecycle ownership (Blocker 2)', () => {
  it("A syncs (holding the recurring-streams refetch open); B's own data is not overwritten by A's late response", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    const aRecurring = deferred<ReturnType<typeof fakeRecurringStreams>>();
    mockGetRecurringStreams.mockReturnValueOnce(aRecurring.promise);
    await act(async () => {
      screen.getByText('Sync transactions').click();
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetRecurringStreams.mockResolvedValueOnce(fakeRecurringStreams('B-Subscription'));
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    // activeTab persists across the lifecycle change — 'Sync transactions' only (re)renders once
    // B's own financial batch is ready, so its reappearance is itself the "B is ready" signal.
    await waitFor(() => expect(screen.getByText('Sync transactions')).toBeTruthy());

    await act(async () => {
      aRecurring.resolve(fakeRecurringStreams('A-Subscription'));
      await aRecurring.promise.catch(() => {});
    });

    act(() => screen.getByText('Subscriptions & Recurring').click());
    expect(screen.getByText(/B-Subscription/)).toBeTruthy();
    expect(screen.queryByText(/A-Subscription/)).toBeNull();
  });
});

describe('35. refreshLoans cross-lifecycle ownership (Blocker 2)', () => {
  it("A refreshes balances (holding the loans refetch open); B's own data is not overwritten by A's late response", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    // "Refresh balances" is disabled while `items` is empty — give A a real item so the button
    // is actually clickable.
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('A-Bank'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    const aLoans = deferred<ReturnType<typeof fakeLoans>>();
    mockGetLoans.mockReturnValueOnce(aLoans.promise);
    mockRefreshAccountBalances.mockResolvedValueOnce({ items: [], is_sandbox: true });
    await act(async () => {
      screen.getByText('Refresh balances').click();
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLoans.mockResolvedValueOnce(fakeLoans('B-Loan'));
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await waitFor(() => expect(screen.getByText('Sync transactions')).toBeTruthy());

    await act(async () => {
      aLoans.resolve(fakeLoans('A-Loan'));
      await aLoans.promise.catch(() => {});
    });

    act(() => screen.getByText('Loans').click());
    expect(screen.getByText(/B-Loan/)).toBeTruthy();
    expect(screen.queryByText(/A-Loan/)).toBeNull();
  });
});

describe('36. refreshAssetsSummary cross-lifecycle ownership (Blocker 2)', () => {
  it("A refreshes balances (holding the assets refetch open); B's own data is not overwritten by A's late response", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    // "Refresh balances" is disabled while `items` is empty — give A a real item so the button
    // is actually clickable.
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('A-Bank'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    const aAssets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(aAssets.promise);
    mockRefreshAccountBalances.mockResolvedValueOnce({ items: [], is_sandbox: true });
    await act(async () => {
      screen.getByText('Refresh balances').click();
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('B-Bank Checking'));
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    // 'Sync transactions' (Accounts tab) confirms B is financially ready; AccountQuickView (where
    // fakeAssetsSummary's account name renders) only appears on Overview.
    await waitFor(() => expect(screen.getByText('Sync transactions')).toBeTruthy());
    act(() => screen.getByText('Overview').click());
    expect(screen.getByText(/B-Bank Checking/)).toBeTruthy();

    await act(async () => {
      aAssets.resolve(fakeAssetsSummary('A-Bank Checking'));
      await aAssets.promise.catch(() => {});
    });

    expect(screen.getByText(/B-Bank Checking/)).toBeTruthy();
    expect(screen.queryByText(/A-Bank Checking/)).toBeNull();
  });
});

describe('37. refreshBudgetCategories cross-lifecycle ownership (Blocker 2)', () => {
  it("A syncs (holding the budget-categories refetch open); B's own data is not overwritten by A's late response", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    const aBudget = deferred<ReturnType<typeof fakeBudgetCategories>>();
    mockGetBudgetCategories.mockReturnValueOnce(aBudget.promise);
    await act(async () => {
      screen.getByText('Sync transactions').click();
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetBudgetCategories.mockResolvedValueOnce(fakeBudgetCategories('B-Category'));
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await waitFor(() => expect(screen.getByText('Sync transactions')).toBeTruthy());

    await act(async () => {
      aBudget.resolve(fakeBudgetCategories('A-Category'));
      await aBudget.promise.catch(() => {});
    });

    act(() => screen.getByText('Budget').click());
    expect(screen.getByText(/B-Category/)).toBeTruthy();
    expect(screen.queryByText(/A-Category/)).toBeNull();
  });
});

describe('38. handleSyncTransactions post-sync getTransactions cross-lifecycle ownership (Blocker 2)', () => {
  it("A syncs (holding the post-sync transactions refetch open); B's own transactions are not overwritten by A's late response", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    const aTransactions = deferred<ReturnType<typeof fakeTransactions>>();
    mockGetTransactions.mockReturnValueOnce(aTransactions.promise);
    await act(async () => {
      screen.getByText('Sync transactions').click();
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetTransactions.mockResolvedValueOnce(fakeTransactions('B-Transaction'));
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    // Not 'Sync transactions' here — `syncing` is plain, ungated App state (not session-scoped;
    // out of this round's declared UI-only scope), so it's still `true` from A's own still-pending
    // sync, leaving the button showing "Syncing..." even once B is otherwise fully ready. Wait for
    // B's own transaction directly instead.
    await waitFor(() => expect(screen.getByText(/B-Transaction/)).toBeTruthy());

    await act(async () => {
      aTransactions.resolve(fakeTransactions('A-Transaction'));
      await aTransactions.promise.catch(() => {});
    });

    expect(screen.getByText(/B-Transaction/)).toBeTruthy();
    expect(screen.queryByText(/A-Transaction/)).toBeNull();
  });
});

describe('39. account-refresh committer cross-lifecycle ownership (Blocker 2)', () => {
  it("A's in-flight balance-refresh callback resolving after B is ready does not commit A's items under B", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('A-Initial-Bank'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());
    expect(screen.getByText(/A-Initial-Bank/)).toBeTruthy();

    const aRefresh = deferred<ReturnType<typeof fakeLinkedItems>>();
    mockRefreshAccountBalances.mockReturnValueOnce(aRefresh.promise);
    await act(async () => {
      screen.getByText('Refresh balances').click();
      await Promise.resolve();
    });

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('B-Bank'));
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await waitFor(() => expect(screen.getByText('Sync transactions')).toBeTruthy());
    expect(screen.getByText(/B-Bank/)).toBeTruthy();

    // A's stale, already-in-flight balance-refresh callback resolves well after B is fully ready.
    // This is the REAL committer function A's LinkedAccounts instance received from
    // createAccountsRefreshCommitter() and captured as its own — invoked here exactly as
    // LinkedAccounts' own internal promise chain would, regardless of whether that component
    // instance is still mounted.
    await act(async () => {
      aRefresh.resolve(fakeLinkedItems('A-Stale-Bank'));
      await aRefresh.promise.catch(() => {});
    });

    expect(screen.getByText(/B-Bank/)).toBeTruthy();
    expect(screen.queryByText(/A-Stale-Bank/)).toBeNull();
  });
});

describe('40. same-session overlapping ad-hoc refreshes: the newer invocation wins regardless of resolution order (Blocker 2)', () => {
  it('two overlapping refreshAssetsSummary invocations within one session settle with the newer winning', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItemsWithAccount('A-Bank', 'acct-1'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    // First invocation, via "Refresh balances" — held open.
    const firstAssets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(firstAssets.promise);
    mockRefreshAccountBalances.mockResolvedValueOnce(fakeLinkedItemsWithAccount('A-Bank', 'acct-1'));
    await act(async () => {
      screen.getByText('Refresh balances').click();
      await Promise.resolve().then(() => Promise.resolve());
    });

    // Second, independent invocation of the SAME resource — toggling the account's "Exclude from
    // net worth" checkbox also calls refreshAssetsSummary (handleUpdateAccountCustomization) —
    // while the first is still in flight.
    const secondAssets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(secondAssets.promise);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Exclude from net worth'));
      await Promise.resolve().then(() => Promise.resolve());
    });

    // The newer (second) invocation resolves first.
    await act(async () => {
      secondAssets.resolve(fakeAssetsSummary('Newer-Assets'));
      await secondAssets.promise;
    });
    act(() => screen.getByText('Overview').click());
    await waitFor(() => expect(screen.getByText(/Newer-Assets/)).toBeTruthy());

    // The older (first) invocation resolves last — must not overwrite the newer one.
    await act(async () => {
      firstAssets.resolve(fakeAssetsSummary('Older-Assets'));
      await firstAssets.promise.catch(() => {});
    });
    expect(screen.getByText(/Newer-Assets/)).toBeTruthy();
    expect(screen.queryByText(/Older-Assets/)).toBeNull();
  });
});

describe('41. A1 -> A3 (same user, new session): ad-hoc ownership uses session_id, not user id (Blocker 2)', () => {
  it("A1's late refreshAssetsSummary response cannot land under A3", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    // "Refresh balances" is disabled while `items` is empty — give A1 a real item so the button
    // is actually clickable.
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('A1-Bank'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    const a1Assets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(a1Assets.promise);
    mockRefreshAccountBalances.mockResolvedValueOnce({ items: [], is_sandbox: true });
    await act(async () => {
      screen.getByText('Refresh balances').click();
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('A3-Bank'));
    act(() => emitAuthEvent(null));
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a3')));
    await waitFor(() => expect(screen.getByText('Sync transactions')).toBeTruthy());
    act(() => screen.getByText('Overview').click());
    expect(screen.getByText(/A3-Bank/)).toBeTruthy();

    await act(async () => {
      a1Assets.resolve(fakeAssetsSummary('A1-Bank'));
      await a1Assets.promise.catch(() => {});
    });

    expect(screen.getByText(/A3-Bank/)).toBeTruthy();
    expect(screen.queryByText(/A1-Bank/)).toBeNull();
  });
});

// --- Round 7: resource-centric ownership — mutation-response leakage + cross-writer ordering ----
// Codex found two remaining gaps after Round 6. Blocker 1: mutation-response handlers
// (createManualLoan, categorize/approve/split a transaction, create/update/archive a category,
// save/delete a category mapping, ...) applied their successful server responses with no
// auth-lifecycle ownership check at all — the concrete "A creates a manual loan, switches to B, A's
// create later succeeds and appends to B's loans" failure. Every one of these now captures
// `expectedSessionId` before its own await and checks `isStillCurrentSession` before applying its
// functional-updater patch — see that helper's own comment for why a plain session check (not a
// resource-version reservation) is the correct, smaller mechanism for mutations specifically.
// Blocker 2: the grouped batch and each targeted single-resource refresh used to own completely
// separate counters — a targeted assets read and a grouped read of the SAME resource had no shared
// way to compare "which is newer," so whichever kind of read settled last could win even after the
// other kind had already committed something newer. `resourceVersionsRef` (see its own comment) now
// gives every reader of a given resource — grouped or targeted — one shared counter to reserve from.

describe('42. createManualLoan mutation cross-lifecycle ownership: A -> B (Blocker 1)', () => {
  it("A's pending manual-loan create does not appear once B is ready", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Loans').click());

    act(() => screen.getByText('Add a loan').click());
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'A-Personal-Loan' } });
    fireEvent.change(screen.getByLabelText('Current balance'), { target: { value: '1000' } });

    const aCreate = deferred<ReturnType<typeof fakeManualLoan>>();
    mockCreateManualLoan.mockReturnValueOnce(aCreate.promise);
    await act(async () => {
      fireEvent.click(screen.getByText('Save loan'));
      await Promise.resolve();
    });

    // Switch to B; B reaches full readiness. activeTab persists as 'loans' across the lifecycle
    // change — 'Add a loan' only (re)renders once B's own financial batch is ready, so its
    // reappearance is itself the "B is ready" signal (waitForReady's own 'Customize dashboard'
    // text only ever renders on the Overview tab).
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('B-Bank'));
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await waitFor(() => expect(screen.getByText('Add a loan')).toBeTruthy());

    // A's create finally succeeds — must be completely inert under B.
    await act(async () => {
      aCreate.resolve(fakeManualLoan('A-Personal-Loan'));
      await aCreate.promise.catch(() => {});
    });

    act(() => screen.getByText('Loans').click());
    expect(screen.queryByText('A-Personal-Loan')).toBeNull();
  });
});

describe('43. approveTransaction mutation cross-lifecycle ownership: A -> B (Blocker 1)', () => {
  it("A's pending transaction-approve response does not flip B's same-id transaction", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetTransactions.mockResolvedValueOnce(fakeTransactionNeedingReview('txn-shared', 'A-Transaction', true));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());
    expect(screen.getByText('Approve')).toBeTruthy();

    const aApprove = deferred<{ transaction: unknown }>();
    mockApproveTransaction.mockReturnValueOnce(aApprove.promise);
    await act(async () => {
      fireEvent.click(screen.getByText('Approve'));
      await Promise.resolve();
    });

    // Switch to B — deliberately the SAME transaction id, simulating the coincidental-collision
    // case a keyed functional-updater patch alone would not protect against.
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetTransactions.mockResolvedValueOnce(fakeTransactionNeedingReview('txn-shared', 'B-Transaction', true));
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    // activeTab persists as 'accounts' across the lifecycle change — 'Customize dashboard'
    // (waitForReady's own signal) never appears there; wait for B's own transaction directly.
    await waitFor(() => expect(screen.getByText('B-Transaction')).toBeTruthy());
    expect(screen.getByText('Approve')).toBeTruthy(); // still needs review under B

    // A's approve finally succeeds — must not flip B's same-id transaction's needs_review.
    await act(async () => {
      aApprove.resolve({ transaction: {} });
      await aApprove.promise.catch(() => {});
    });

    expect(screen.getByText('B-Transaction')).toBeTruthy();
    expect(screen.getByText('Approve')).toBeTruthy(); // still present — not incorrectly cleared
  });
});

describe('44. createBudgetCategory mutation cross-lifecycle ownership: A1 -> A3 (Blocker 1)', () => {
  it("A1's pending category create does not appear once A3 is ready (same user, new session)", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Budget').click());

    act(() => screen.getByText('Add category').click());
    const form = screen.getByText('Add a budget category').closest('form') as HTMLElement;
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'A1-Category' } });
    fireEvent.change(within(form).getByLabelText('Monthly budget'), { target: { value: '200' } });

    const a1Create = deferred<{ category: unknown }>();
    mockCreateBudgetCategory.mockReturnValueOnce(a1Create.promise);
    await act(async () => {
      fireEvent.click(within(form).getByText('Add category'));
      await Promise.resolve();
    });

    // Same user, new session_id: A1 -> A3. activeTab persists as 'budget' across the lifecycle
    // change — 'Customize dashboard' (waitForReady's own signal) never appears there; wait for
    // A3's own category directly.
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetBudgetCategories.mockResolvedValueOnce(fakeBudgetCategories('A3-Category'));
    act(() => emitAuthEvent(null));
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a3')));
    await waitFor(() => expect(screen.getByText('A3-Category')).toBeTruthy());

    await act(async () => {
      a1Create.resolve({
        category: { id: 'cat-a1', name: 'A1-Category', budget_amount: 200, color: null, sort_order: 0, emoji: null, archived_at: null },
      });
      await a1Create.promise.catch(() => {});
    });

    expect(screen.getByText('A3-Category')).toBeTruthy();
    expect(screen.queryByText('A1-Category')).toBeNull();
  });
});

describe('45. saveCategoryMapping mutation cross-lifecycle ownership: A -> B (Blocker 1)', () => {
  it("A's pending mapping save does not apply under B, even when the same budget-category id would coincidentally exist", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetPlaidCategories.mockResolvedValue({ categories: ['FOOD_AND_DRINK'] });
    mockGetBudgetCategories.mockResolvedValueOnce({
      categories: [
        { id: 'cat-1', name: 'A-Groceries', budget_amount: 100, color: null, sort_order: 0, emoji: null, archived_at: null, spent: 0, recent_avg_spent: 0 },
      ],
    });
    mockGetCategoryMappings.mockResolvedValueOnce({ mappings: [] });
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Settings').click());
    act(() => screen.getByText('Categories').click());

    const select = screen.getByRole('combobox');
    expect((select as HTMLSelectElement).value).toBe('');

    const aSave = deferred<{ mapping: unknown; backfilled_count: number }>();
    mockSaveCategoryMapping.mockReturnValueOnce(aSave.promise);
    await act(async () => {
      fireEvent.change(select, { target: { value: 'cat-1' } });
      await Promise.resolve();
    });

    // Switch to B — deliberately reusing the SAME budget-category id ('cat-1', under a different
    // name), simulating the coincidental-collision case.
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetPlaidCategories.mockResolvedValue({ categories: ['FOOD_AND_DRINK'] });
    mockGetBudgetCategories.mockResolvedValueOnce({
      categories: [
        { id: 'cat-1', name: 'B-Category', budget_amount: 50, color: null, sort_order: 0, emoji: null, archived_at: null, spent: 0, recent_avg_spent: 0 },
      ],
    });
    mockGetCategoryMappings.mockResolvedValueOnce({ mappings: [] });
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    // activeTab persists as 'settings' across the lifecycle change, but the whole tab-content tree
    // (including the settings sidebar) still unmounts/remounts behind the financial-lifecycle
    // gate — wait for the 'Settings' tab button itself to reappear before navigating again.
    await waitFor(() => expect(screen.getByText('Settings')).toBeTruthy());
    act(() => screen.getByText('Settings').click());
    act(() => screen.getByText('Categories').click());
    const bSelect = screen.getByRole('combobox');
    expect((bSelect as HTMLSelectElement).value).toBe(''); // unmapped under B

    // A's save finally succeeds — must not apply under B.
    await act(async () => {
      aSave.resolve({ mapping: { id: 'mapping-a', plaid_category: 'FOOD_AND_DRINK', budget_category_id: 'cat-1' }, backfilled_count: 0 });
      await aSave.promise.catch(() => {});
    });

    expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('');
  });
});

describe('46. targeted assets refresh started BEFORE a grouped refresh: the later-started grouped read wins (Blocker 2)', () => {
  it('targeted #1 starts and is held; grouped #2 starts later and commits; #1 resolving after is inert', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItemsWithAccount('A-Bank', 'acct-1'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    const targetedAssets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(targetedAssets.promise);
    mockRefreshAccountBalances.mockResolvedValueOnce(fakeLinkedItemsWithAccount('A-Bank', 'acct-1'));
    await act(async () => {
      screen.getByText('Refresh balances').click();
      await Promise.resolve().then(() => Promise.resolve());
    });

    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('Grouped-Bank'));
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });
    act(() => screen.getByText('Overview').click());
    await waitFor(() => expect(screen.getByText(/Grouped-Bank/)).toBeTruthy());

    await act(async () => {
      targetedAssets.resolve(fakeAssetsSummary('Targeted-Bank'));
      await targetedAssets.promise.catch(() => {});
    });
    expect(screen.getByText(/Grouped-Bank/)).toBeTruthy();
    expect(screen.queryByText(/Targeted-Bank/)).toBeNull();
  });
});

describe('47. grouped refresh started BEFORE a targeted assets refresh: the later-started targeted read wins (Blocker 2)', () => {
  it('grouped #1 starts and is held; targeted #2 starts later and commits; #1 resolving after is inert', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItemsWithAccount('A-Bank', 'acct-1'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    const groupedAssets = deferred<ReturnType<typeof fakeAssetsSummary>>();
    mockGetAssetsSummary.mockReturnValueOnce(groupedAssets.promise);
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve());
    });

    mockGetAssetsSummary.mockResolvedValueOnce(fakeAssetsSummary('Targeted-Bank'));
    mockRefreshAccountBalances.mockResolvedValueOnce(fakeLinkedItemsWithAccount('A-Bank', 'acct-1'));
    await act(async () => {
      screen.getByText('Refresh balances').click();
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });
    act(() => screen.getByText('Overview').click());
    await waitFor(() => expect(screen.getByText(/Targeted-Bank/)).toBeTruthy());

    await act(async () => {
      groupedAssets.resolve(fakeAssetsSummary('Grouped-Bank'));
      await groupedAssets.promise.catch(() => {});
    });
    expect(screen.getByText(/Targeted-Bank/)).toBeTruthy();
    expect(screen.queryByText(/Grouped-Bank/)).toBeNull();
  });
});

describe('48. recurring-streams targeted vs. grouped ordering shares the same resource-version mechanism (Blocker 2)', () => {
  it('targeted #1 starts and is held; grouped #2 starts later and commits; #1 resolving after is inert', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    const targetedRecurring = deferred<ReturnType<typeof fakeRecurringStreams>>();
    mockGetRecurringStreams.mockReturnValueOnce(targetedRecurring.promise);
    await act(async () => {
      screen.getByText('Sync transactions').click();
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    mockGetRecurringStreams.mockResolvedValueOnce(fakeRecurringStreams('Grouped-Subscription'));
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    act(() => screen.getByText('Subscriptions & Recurring').click());
    await waitFor(() => expect(screen.getByText(/Grouped-Subscription/)).toBeTruthy());

    await act(async () => {
      targetedRecurring.resolve(fakeRecurringStreams('Targeted-Subscription'));
      await targetedRecurring.promise.catch(() => {});
    });
    expect(screen.getByText(/Grouped-Subscription/)).toBeTruthy();
    expect(screen.queryByText(/Targeted-Subscription/)).toBeNull();
  });
});

describe('49. account-refresh committer vs. a newer grouped items write (Blocker 2)', () => {
  it('old account-refresh committer work starts; a newer grouped refresh commits items; the old committer firing after is inert', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('A-Initial-Bank'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());
    expect(screen.getByText(/A-Initial-Bank/)).toBeTruthy();

    const oldRefresh = deferred<ReturnType<typeof fakeLinkedItems>>();
    mockRefreshAccountBalances.mockReturnValueOnce(oldRefresh.promise);
    await act(async () => {
      screen.getByText('Refresh balances').click();
      await Promise.resolve();
    });

    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('Grouped-Bank'));
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });
    expect(screen.getByText(/Grouped-Bank/)).toBeTruthy();

    await act(async () => {
      oldRefresh.resolve(fakeLinkedItems('Old-Callback-Bank'));
      await oldRefresh.promise.catch(() => {});
    });
    expect(screen.getByText(/Grouped-Bank/)).toBeTruthy();
    expect(screen.queryByText(/Old-Callback-Bank/)).toBeNull();
  });
});

// --- Round 8: per-operation-start Accounts ownership, mutation-success read invalidation --------
// Codex found four remaining gaps after Round 7. Blocker 1: handleSaveCategoryMapping's backfill
// continuation ran unconditionally on the awaited response, not gated by isStillCurrentSession the
// way its own categoryMappings write was — a stale response could still bump the shared
// `transactions` resource version and issue a follow-up fetch/refreshBudgetCategories() call after
// a newer lifecycle had already reserved its own transactions authority, wrongly invalidating that
// newer lifecycle's own legitimate read. Fixed with a single early return immediately after the
// awaited response, before any of the continuation runs. Blocker 2: a successful mutation applied
// its functional-updater patch but never invalidated a same-resource READ that had already reserved
// an (now-stale) version before the mutation committed — that read could still resolve afterward and
// replace-all the resource, erasing the mutation's patch. Fixed with commitMutationForResource,
// which bumps the resource's shared version at successful commit (never at the mutation's own
// start) before applying the patch. Blocker 3: plaidCategories participated in every grouped call
// but had no resource-read version of its own, so two overlapping grouped reads of the SAME session
// could commit out of order. Fixed by folding plaidCategories into the same resourceVersionsRef
// system every other replace-all resource already uses. Blocker 4: itemsVersionAtRender captured
// ownership once per App render, not once per child account operation — two operations kicked off
// from the same render shared one token, so an operation that started EARLIER but resolved LATER
// could still look "current" and incorrectly beat one that started later. Fixed by moving ownership
// reservation into a factory, createAccountsRefreshCommitter, called by the child component at the
// exact moment its own async operation begins.

describe('50. stale category-mapping backfill continuation is completely inert across a session switch (Blocker 1)', () => {
  it('A starts backfill -> switch to B -> B reserves transactions via its own sync -> A resolves with backfilled_count>0 -> A cannot corrupt or overwrite B\'s in-flight transactions read', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetTransactions.mockResolvedValueOnce(fakeTransactions('A-Transaction'));
    mockGetBudgetCategories.mockResolvedValueOnce({
      categories: [
        { id: 'cat-1', name: 'A-Groceries', budget_amount: 100, color: null, sort_order: 0, emoji: null, archived_at: null, spent: 0, recent_avg_spent: 0 },
      ],
    });
    mockGetCategoryMappings.mockResolvedValueOnce({
      mappings: [{ id: 'map-1', plaid_category: 'FOOD_AND_DRINK', budget_category_id: 'cat-1' }],
    });
    mockGetPlaidCategories.mockResolvedValueOnce({ categories: ['FOOD_AND_DRINK'] });
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Settings').click());
    act(() => screen.getByText('Categories').click());

    // A already has a mapping for FOOD_AND_DRINK -> cat-1, so "Apply to existing transactions" is
    // immediately available — clicking it calls handleSaveCategoryMapping(..., backfill=true), the
    // exact code path Blocker 1 found under-guarded.
    const aSave = deferred<{ mapping: unknown; backfilled_count: number }>();
    mockSaveCategoryMapping.mockReturnValueOnce(aSave.promise);
    await act(async () => {
      screen.getByText('Apply to existing transactions').click();
      await Promise.resolve();
    });

    // Switch to B; B reaches full readiness normally.
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetTransactions.mockResolvedValueOnce(fakeTransactions('B-Transaction'));
    mockGetBudgetCategories.mockResolvedValueOnce({ categories: [] });
    mockGetCategoryMappings.mockResolvedValueOnce({ mappings: [] });
    mockGetPlaidCategories.mockResolvedValueOnce({ categories: [] });
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    // activeTab persists as 'settings' across the lifecycle change, but the whole tab-content tree
    // still unmounts/remounts behind the financial-lifecycle gate — wait for the 'Settings' tab
    // button itself to reappear (same pattern as test 45) before navigating to Accounts.
    await waitFor(() => expect(screen.getByText('Settings')).toBeTruthy());
    act(() => screen.getByText('Accounts').click());
    expect(screen.getByText(/B-Transaction/)).toBeTruthy();

    // B reserves its own, later `transactions` version via a targeted read (Sync transactions) —
    // held open, representing B's own in-flight, legitimate read authority at the moment A's stale
    // backfill response arrives.
    mockSyncTransactions.mockResolvedValueOnce({});
    const bSyncRead = deferred<ReturnType<typeof fakeTransactions>>();
    mockGetTransactions.mockReturnValueOnce(bSyncRead.promise);
    await act(async () => {
      screen.getByText('Sync transactions').click();
      await Promise.resolve().then(() => Promise.resolve());
    });

    const callsBeforeStaleResolve = mockGetTransactions.mock.calls.length;

    // A's stale backfill response resolves well after B is fully ready and has its own read
    // in flight. Without Blocker 1's fix, the unguarded continuation below would (1) issue its own
    // extra getTransactions() follow-up call, and (2) bump the shared `transactions` resource
    // version out from under B's already-reserved version — corrupting B's own legitimate,
    // still-pending read so that IT would look stale against itself once it resolves.
    await act(async () => {
      aSave.resolve({ mapping: { id: 'map-1', plaid_category: 'FOOD_AND_DRINK', budget_category_id: 'cat-1' }, backfilled_count: 3 });
      await aSave.promise.catch(() => {});
      await Promise.resolve().then(() => Promise.resolve());
    });
    expect(mockGetTransactions.mock.calls.length).toBe(callsBeforeStaleResolve); // no extra backfill refetch

    // B's own in-flight read now resolves — it must still be able to commit; a corrupted resource
    // version (the bug) would make this legitimate, newer read reject itself.
    await act(async () => {
      bSyncRead.resolve(fakeTransactions('B-Synced-Transaction'));
      await bSyncRead.promise;
    });

    expect(screen.getByText(/B-Synced-Transaction/)).toBeTruthy();
    expect(screen.queryByText(/A-Transaction/)).toBeNull();
  });
});

describe('51. a successful category mutation invalidates an older, still-pending targeted budgets read (Blocker 2)', () => {
  it('a targeted budgets read (via Sync transactions) starts and holds open -> category-create mutation succeeds and patches locally -> the stale read resolving after cannot erase it', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('A-Bank'));
    mockGetBudgetCategories.mockResolvedValueOnce({ categories: [] });
    mockGetTransactions.mockResolvedValueOnce(fakeTransactions('Initial-Tx'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    // "Sync transactions" resolves its own sync + its own transactions refetch quickly, then
    // (synchronously after) calls refreshBudgetCategories() as a targeted, single-resource read of
    // `budgets` — held open here to represent a read reserved BEFORE the mutation below commits.
    mockSyncTransactions.mockResolvedValueOnce({});
    mockGetTransactions.mockResolvedValueOnce(fakeTransactions('Post-Sync-Tx'));
    const groupedBudgets = deferred<ReturnType<typeof fakeBudgetCategories>>();
    mockGetBudgetCategories.mockReturnValueOnce(groupedBudgets.promise);
    await act(async () => {
      screen.getByText('Sync transactions').click();
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    // A category-create mutation succeeds and patches budgetCategories locally while that read is
    // still pending.
    mockCreateBudgetCategory.mockResolvedValueOnce({
      category: { id: 'cat-new', name: 'New-Category', budget_amount: 200, color: null, sort_order: 0, emoji: null, archived_at: null },
    });
    act(() => screen.getByText('Budget').click());
    act(() => screen.getByText('Add category').click());
    const form = screen.getByText('Add a budget category').closest('form') as HTMLElement;
    fireEvent.change(within(form).getByLabelText('Name'), { target: { value: 'New-Category' } });
    fireEvent.change(within(form).getByLabelText('Monthly budget'), { target: { value: '200' } });
    await act(async () => {
      fireEvent.click(within(form).getByText('Add category'));
      await Promise.resolve().then(() => Promise.resolve());
    });
    expect(screen.getByText(/New-Category/)).toBeTruthy();

    // The older targeted read, reserved before the mutation committed, now resolves. Without
    // Blocker 2's fix, its full-array replacement would silently erase New-Category since the
    // mutation never used to advance the resource version the read checks itself against.
    await act(async () => {
      groupedBudgets.resolve(fakeBudgetCategories('Old-Targeted-Category'));
      await groupedBudgets.promise.catch(() => {});
    });

    expect(screen.getByText(/New-Category/)).toBeTruthy();
    expect(screen.queryByText(/Old-Targeted-Category/)).toBeNull();
  });
});

describe('52. a successful transaction approve mutation invalidates an older, still-pending transactions read (Blocker 2)', () => {
  it('a transactions read (via Sync transactions) starts and holds open -> approve mutation succeeds and patches locally -> the stale read resolving after cannot erase it', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('A-Bank'));
    mockGetTransactions.mockResolvedValueOnce(fakeTransactionNeedingReview('txn-1', 'Needs-Review-Tx', true));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());
    expect(screen.getByText('Approve')).toBeTruthy();

    // "Sync transactions" reserves a `transactions` version at its own start, then awaits its own
    // sync + its own transactions refetch — held open here to represent a read reserved BEFORE the
    // approve mutation below commits.
    mockSyncTransactions.mockResolvedValueOnce({});
    const syncedTransactions = deferred<ReturnType<typeof fakeTransactionNeedingReview>>();
    mockGetTransactions.mockReturnValueOnce(syncedTransactions.promise);
    await act(async () => {
      screen.getByText('Sync transactions').click();
      await Promise.resolve().then(() => Promise.resolve());
    });

    // The approve mutation succeeds and patches the transaction locally (needs_review: false) while
    // that read is still pending.
    mockApproveTransaction.mockResolvedValueOnce({});
    await act(async () => {
      screen.getByText('Approve').click();
      await Promise.resolve().then(() => Promise.resolve());
    });
    expect(screen.queryByText('Approve')).toBeNull(); // locally patched: approved, control gone

    // The older transactions read, reserved before the approve mutation committed, resolves after
    // with a stale (pre-approval) snapshot — without Blocker 2's fix this full-array replacement
    // would erase the local approval patch and bring "Approve" back.
    await act(async () => {
      syncedTransactions.resolve(fakeTransactionNeedingReview('txn-1', 'Needs-Review-Tx', true));
      await syncedTransactions.promise.catch(() => {});
    });
    expect(screen.queryByText('Approve')).toBeNull();
  });
});

describe('53. plaidCategories: same-session overlapping grouped reads settle with the newer winning (Blocker 3)', () => {
  it('grouped #1 starts -> grouped #2 starts and resolves first -> #1 resolves after -> #2 plaidCategories value is the one exposed', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('A-Bank'));
    mockGetCategoryMappings.mockResolvedValue({ mappings: [] });
    const firstCategories = deferred<{ categories: string[] }>();
    mockGetPlaidCategories.mockReturnValueOnce(firstCategories.promise);
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForFinancialLoading(); // #1 (initial) still pending on plaidCategories

    const secondCategories = deferred<{ categories: string[] }>();
    mockGetPlaidCategories.mockReturnValueOnce(secondCategories.promise);
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve());
    });

    // #2 (the Plaid-triggered grouped invocation) resolves first, with a distinctive category.
    await act(async () => {
      secondCategories.resolve({ categories: ['TRAVEL'] });
      await secondCategories.promise;
    });
    await waitForReady();
    act(() => screen.getByText('Settings').click());
    act(() => screen.getByText('Categories').click());
    expect(screen.getByText(/Travel/i)).toBeTruthy();

    // #1's stale plaidCategories value resolves after — must not overwrite #2's.
    await act(async () => {
      firstCategories.resolve({ categories: ['FOOD_AND_DRINK'] });
      await firstCategories.promise.catch(() => {});
    });
    expect(screen.getByText(/Travel/i)).toBeTruthy();
    expect(screen.queryByText(/Food and drink/i)).toBeNull();
  });
});

describe('54. Accounts: a later-started child operation beats an earlier one from the same render, regardless of resolution order (Blocker 4)', () => {
  it('op#1 (Refresh balances) then op#2 (Simulate reauth) start from the same render; op#1 resolves first but is rejected; op#2 wins', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('A-Initial-Bank'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());
    expect(screen.getByText(/A-Initial-Bank/)).toBeTruthy();

    const op1 = deferred<ReturnType<typeof fakeLinkedItems>>();
    mockRefreshAccountBalances.mockReturnValueOnce(op1.promise);
    await act(async () => {
      screen.getByText('Refresh balances').click();
      await Promise.resolve();
    });

    const op2 = deferred<ReturnType<typeof fakeLinkedItems>>();
    mockSandboxResetLogin.mockReturnValueOnce(op2.promise);
    await act(async () => {
      screen.getByText('Simulate reauth (sandbox test)').click();
      await Promise.resolve();
    });

    // op#1 started FIRST but resolves first too here — it must be rejected, since op#2 (started
    // later, from the same render) has already reserved newer authority over `items`.
    await act(async () => {
      op1.resolve(fakeLinkedItems('Op1-Bank'));
      await op1.promise.catch(() => {});
    });
    expect(screen.getByText(/A-Initial-Bank/)).toBeTruthy(); // op#1 rejected, no commit at all
    expect(screen.queryByText(/Op1-Bank/)).toBeNull();

    await act(async () => {
      op2.resolve(fakeLinkedItems('Op2-Bank'));
      await op2.promise;
    });
    expect(screen.getByText(/Op2-Bank/)).toBeTruthy();
    expect(screen.queryByText(/Op1-Bank/)).toBeNull();
  });
});

describe('55. Accounts: a later-started child operation resolving first still wins once the earlier one resolves after (Blocker 4)', () => {
  it('op#1 then op#2 start from the same render; op#2 resolves first and commits; op#1 resolving after cannot overwrite it', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('A-Initial-Bank'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());

    const op1 = deferred<ReturnType<typeof fakeLinkedItems>>();
    mockRefreshAccountBalances.mockReturnValueOnce(op1.promise);
    await act(async () => {
      screen.getByText('Refresh balances').click();
      await Promise.resolve();
    });

    const op2 = deferred<ReturnType<typeof fakeLinkedItems>>();
    mockSandboxResetLogin.mockReturnValueOnce(op2.promise);
    await act(async () => {
      screen.getByText('Simulate reauth (sandbox test)').click();
      await Promise.resolve();
    });

    // op#2 (started later) resolves FIRST and commits.
    await act(async () => {
      op2.resolve(fakeLinkedItems('Op2-Bank'));
      await op2.promise;
    });
    expect(screen.getByText(/Op2-Bank/)).toBeTruthy();

    // op#1 (started earlier) resolves after — must not overwrite op#2's already-committed result.
    await act(async () => {
      op1.resolve(fakeLinkedItems('Op1-Bank'));
      await op1.promise.catch(() => {});
    });
    expect(screen.getByText(/Op2-Bank/)).toBeTruthy();
    expect(screen.queryByText(/Op1-Bank/)).toBeNull();
  });
});

describe('56. Accounts: an older grouped items read cannot overwrite a newer account child operation that already committed (Blocker 4, reverse direction)', () => {
  it('grouped read starts and holds open -> a later account child operation resolves and commits first -> the grouped read resolving after is inert', async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetLinkedItems.mockResolvedValueOnce(fakeLinkedItems('A-Initial-Bank'));
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Accounts').click());
    expect(screen.getByText(/A-Initial-Bank/)).toBeTruthy();

    // A grouped items read (via a Plaid-link success) starts and reserves a version BEFORE the
    // account child operation below does, then holds open.
    const groupedItems = deferred<ReturnType<typeof fakeLinkedItems>>();
    mockGetLinkedItems.mockReturnValueOnce(groupedItems.promise);
    await act(async () => {
      capturedPlaidOnSuccess!('fake-public-token');
      await Promise.resolve().then(() => Promise.resolve());
    });

    const childOp = deferred<ReturnType<typeof fakeLinkedItems>>();
    mockSandboxResetLogin.mockReturnValueOnce(childOp.promise);
    await act(async () => {
      screen.getByText('Simulate reauth (sandbox test)').click();
      await Promise.resolve();
    });

    // The account child operation, started AFTER the grouped read, resolves and commits first.
    await act(async () => {
      childOp.resolve(fakeLinkedItems('Child-Op-Bank'));
      await childOp.promise;
    });
    expect(screen.getByText(/Child-Op-Bank/)).toBeTruthy();

    // The older grouped read, still holding its now-stale reserved version, resolves after — must
    // not overwrite the newer child operation's committed result.
    await act(async () => {
      groupedItems.resolve(fakeLinkedItems('Old-Grouped-Bank'));
      await groupedItems.promise.catch(() => {});
    });
    expect(screen.getByText(/Child-Op-Bank/)).toBeTruthy();
    expect(screen.queryByText(/Old-Grouped-Bank/)).toBeNull();
  });
});

// Codex Round 9: handleSaveCategoryMapping's FIRST await boundary (the saveCategoryMapping() call
// itself) was already guarded by Round 8's fix — an early return immediately after that response if
// the session had already changed. But the backfill continuation has a SECOND await boundary
// (getTransactions()) that can cross a lifecycle change on its own: the session can still be current
// right after saveCategoryMapping() resolves (so the Round 8 guard passes and the continuation enters
// the backfill block), then change WHILE getTransactions() is in flight. The old code only re-checked
// ownership before its own setTransactions call, then called refreshBudgetCategories() unconditionally
// regardless of that check's outcome — an unowned, current-session-under-the-hood targeted read that
// could advance a newer lifecycle's own budgets resource version out from under its still-pending
// grouped read, causing that legitimate newer read to reject itself as stale once it resolved. Fixed
// by re-checking isStillCurrentSession once, immediately after getTransactions() resolves, and
// returning immediately if it fails — before setTransactions AND before refreshBudgetCategories().
describe('57. handleSaveCategoryMapping: a lifecycle change during the post-backfill getTransactions() await must not let refreshBudgetCategories() run under a newer session (Blocker 1, second await boundary)', () => {
  it("A's backfill succeeds and starts its own getTransactions() follow-up (held pending) -> switch to B mid-grouped-bootstrap with one sibling still pending -> A's stale getTransactions() resolves -> refreshBudgetCategories() never fires, and B's own grouped budgets/transactions commit normally once its pending sibling resolves", async () => {
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetTransactions.mockResolvedValueOnce(fakeTransactions('A-Transaction'));
    mockGetBudgetCategories.mockResolvedValueOnce({
      categories: [
        { id: 'cat-1', name: 'A-Groceries', budget_amount: 100, color: null, sort_order: 0, emoji: null, archived_at: null, spent: 0, recent_avg_spent: 0 },
      ],
    });
    mockGetCategoryMappings.mockResolvedValueOnce({
      mappings: [{ id: 'map-1', plaid_category: 'FOOD_AND_DRINK', budget_category_id: 'cat-1' }],
    });
    mockGetPlaidCategories.mockResolvedValueOnce({ categories: ['FOOD_AND_DRINK'] });
    render(<App />);
    act(() => emitAuthEvent(fakeSession('user-a', 'sid-a1')));
    await waitForReady();
    act(() => screen.getByText('Settings').click());
    act(() => screen.getByText('Categories').click());

    // A's save resolves WHILE A is still current — the Round 8 guard passes, so the continuation
    // enters the backfill block and starts its own getTransactions() follow-up.
    const aSave = deferred<{ mapping: unknown; backfilled_count: number }>();
    mockSaveCategoryMapping.mockReturnValueOnce(aSave.promise);
    await act(async () => {
      screen.getByText('Apply to existing transactions').click();
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    // Held pending here to represent the SECOND await boundary Codex found unguarded — a lifecycle
    // change can still happen while this specific request is in flight.
    const aBackfillRead = deferred<ReturnType<typeof fakeTransactions>>();
    mockGetTransactions.mockReturnValueOnce(aBackfillRead.promise);
    await act(async () => {
      aSave.resolve({ mapping: { id: 'map-1', plaid_category: 'FOOD_AND_DRINK', budget_category_id: 'cat-1' }, backfilled_count: 3 });
      await aSave.promise;
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });

    // Switch to B while A's follow-up getTransactions() is still pending. B's own grouped bootstrap
    // starts and reserves its own budgets/transactions resource versions immediately — but one
    // sibling (budgetCategories) is held pending too, so B's grouped Promise.allSettled cannot commit
    // anything yet, reproducing Codex's exact "B has reserved but not yet committed" window.
    mockGetUserPreferences.mockResolvedValueOnce(fakePreferences());
    mockGetTransactions.mockResolvedValueOnce(fakeTransactions('B-Transaction'));
    const bBudgetsRead = deferred<ReturnType<typeof fakeBudgetCategories>>();
    mockGetBudgetCategories.mockReturnValueOnce(bBudgetsRead.promise);
    mockGetCategoryMappings.mockResolvedValueOnce({ mappings: [] });
    mockGetPlaidCategories.mockResolvedValueOnce({ categories: [] });
    act(() => emitAuthEvent(fakeSession('user-b', 'sid-b1')));
    await waitForFinancialLoading();

    const budgetCallsBeforeStaleResolve = mockGetBudgetCategories.mock.calls.length;
    const transactionsCallsBeforeStaleResolve = mockGetTransactions.mock.calls.length;

    // A's stale follow-up resolves now, well after B is current and mid-bootstrap. Without Round 9's
    // fix, the unguarded continuation would call refreshBudgetCategories() here under B's session — a
    // targeted read that reserves a NEW budgets version, advancing it out from under B's own grouped
    // budgetsVersion reservation above, so that when B's held sibling resolves, B's own grouped budget
    // commit would reject itself as stale.
    await act(async () => {
      aBackfillRead.resolve(fakeTransactions('A-Stale-Transaction'));
      await aBackfillRead.promise.catch(() => {});
      await Promise.resolve().then(() => Promise.resolve()).then(() => Promise.resolve());
    });
    expect(mockGetBudgetCategories.mock.calls.length).toBe(budgetCallsBeforeStaleResolve); // no extra refreshBudgetCategories() call
    expect(mockGetTransactions.mock.calls.length).toBe(transactionsCallsBeforeStaleResolve); // no extra transactions call either

    // B's still-pending grouped sibling now resolves — its budgets (and the rest of the grouped
    // batch, including B's own transactions) must commit normally, unaffected by A's stale work.
    await act(async () => {
      bBudgetsRead.resolve(fakeBudgetCategories('B-Groceries'));
      await bBudgetsRead.promise;
    });

    // activeTab persisted as 'settings' across the lifecycle change (same as test 50) — wait for the
    // tab bar itself to reappear (financialLifecycleStatus === 'ready') rather than waitForReady(),
    // whose own signal only ever renders on the Overview tab.
    await waitFor(() => expect(screen.getByText('Settings')).toBeTruthy());
    act(() => screen.getByText('Budget').click());
    expect(screen.getByText(/B-Groceries/)).toBeTruthy();
    expect(screen.queryByText(/A-Groceries/)).toBeNull();
    act(() => screen.getByText('Accounts').click());
    expect(screen.getByText(/B-Transaction/)).toBeTruthy();
    expect(screen.queryByText(/A-Transaction/)).toBeNull();
    expect(screen.queryByText(/A-Stale-Transaction/)).toBeNull();
  });
});
