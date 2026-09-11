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

vi.mock('./lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/api')>();
  return {
    ...actual,
    // Out-of-scope datasets (declared out of this remediation's boundary, same as the original
    // audit's own scope) — trivial, instantly-resolved stubs; their content is irrelevant here.
    getLinkedItems: mockGetLinkedItems,
    getTransactions: vi.fn().mockResolvedValue({ transactions: [] }),
    getBudgetCategories: vi.fn().mockResolvedValue({ categories: [] }),
    getRecurringStreams: vi.fn().mockResolvedValue({ streams: [], total_monthly_outflow: 0, total_monthly_inflow: 0 }),
    getLoans: vi.fn().mockResolvedValue({ loans: [], total_debt: 0, total_minimum_payment: 0 }),
    getAssetsSummary: vi.fn().mockResolvedValue({ groups: [], total_assets: 0 }),
    getManualLoans: vi.fn().mockResolvedValue({ loans: [] }),
    getCategoryMappings: vi.fn().mockResolvedValue({ mappings: [] }),
    getPlaidCategories: vi.fn().mockResolvedValue({ categories: [] }),
    // Saves — not exercised by any case in this file (no test here clicks an edit control); stubbed
    // so nothing throws if a hook's own internal wiring ever reaches one.
    updateDashboardLayout: vi.fn().mockResolvedValue({ dashboard_layout: { cards: [] } }),
    updateAppearance: vi.fn().mockResolvedValue({ theme: 'system', accent_color: 'green' }),
    updateFinancialPreferences: mockUpdateFinancialPreferences,
    updateReportingRange: vi.fn().mockResolvedValue({ reporting_range: 'last_6_months' }),
    updateNavLayout: vi.fn().mockResolvedValue({ nav_layout: { tabs: [] } }),
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
