// @vitest-environment jsdom
//
// Codex re-review of 659eb7e: an automatic update reload must never discard a change that is on
// screen but not yet durably saved. authedFetch's own `mutation` guard ends when the request ends,
// yet a failed optimistic preference save (awaiting Retry) or a navigation layout queued behind an
// in-flight save is still unsaved at that moment. These tests reproduce that exact sequence with the
// real hooks, the real authedFetch (so the request guard is released in its `finally`, exactly as
// in production), App's real navigation coordinator, and a real update manager whose service
// worker the test controls.
import { StrictMode, type ReactNode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppUpdateManager, UpdateManagerDeps } from './lib/appUpdate';

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('./lib/supabaseClient', () => ({
  supabase: { auth: { getSession: mockGetSession, onAuthStateChange: vi.fn() } },
}));

// Every module that uses the shared `appUpdate` singleton (authedFetch, useSaveStatus, App's
// navigation coordinator) gets this proxy, which forwards to the current test's own manager.
const current = vi.hoisted(() => ({ manager: null as AppUpdateManager | null }));
vi.mock('./lib/appUpdate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/appUpdate')>();
  const appUpdate = new Proxy({} as AppUpdateManager, {
    get: (_target, key: keyof AppUpdateManager) => current.manager![key],
  });
  return { ...actual, appUpdate };
});

import { createAppUpdateManager, describeUpdateBanner, LAUNCH_WINDOW_MS } from './lib/appUpdate';
import { navigationWriteCoordinator } from './App';
import { useFinancialPreferences } from './hooks/useFinancialPreferences';
import { useDashboardLayout } from './hooks/useDashboardLayout';
import { useReportingRange } from './hooks/useReportingRange';
import { useNavLayout } from './hooks/useNavLayout';
import { useAppearance } from './hooks/useAppearance';

const SESSION = { user: { id: 'user-a' }, access_token: 'a-token' };
const verify = () => true;
const SAVED_PREFS = {
  minimum_cash_buffer: 100,
  upcoming_bills_days: 14,
  recent_avg_months: 3,
  savings_rate_target: 20,
  safe_to_spend_include_upcoming_bills: true,
  safe_to_spend_include_remaining_budget: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => (resolve = res));
  return { promise, resolve };
}
const ok = () => ({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve({}) });
const serverError = () => ({
  ok: false,
  status: 500,
  headers: new Headers(),
  json: () => Promise.resolve({ error: 'Something went wrong' }),
});
const updateRequired409 = () => ({
  ok: false,
  status: 409,
  headers: new Headers({ 'X-Api-Level': '2', 'X-Min-Client-Api-Level': '2' }),
  json: () => Promise.resolve({ error: 'This version of the app is out of date.', code: 'client_update_required' }),
});
/** Lets every pending promise hop (session lookup, fetch, json, the trackers' own .then) run. */
const flush = () => new Promise((r) => setTimeout(r, 0));
const sentBodies = () => vi.mocked(fetch).mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)));

/** One browser tab's update manager, already running on a page a service worker controls. */
function tab(opts: { visibility?: 'visible' | 'hidden' } = {}) {
  let now = 1_000_000;
  const controllerListeners: Array<() => void> = [];
  const reload = vi.fn();
  const data: Record<string, string> = {};
  const deps: UpdateManagerDeps = {
    buildId: 'build-a',
    serviceWorker: {
      controller: {},
      register: () => Promise.resolve({ active: {}, update: () => Promise.resolve() }),
      addEventListener: (_type, listener) => controllerListeners.push(listener),
    },
    getVisibility: () => opts.visibility ?? 'hidden',
    onVisibilityChange: () => {},
    onPreloadError: () => {},
    reload,
    storage: { getItem: (k) => data[k] ?? null, setItem: (k, v) => void (data[k] = v) },
    now: () => now,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: () => 0,
  };
  const manager = createAppUpdateManager(deps);
  manager.start();
  current.manager = manager;
  return {
    manager,
    reload,
    guards: () => manager.getSnapshot().guards,
    /** A newer build's service worker takes control of this already-running page. */
    newBuildTakesControl: () => controllerListeners.forEach((l) => l()),
    leaveLaunchWindow: () => void (now += LAUNCH_WINDOW_MS),
  };
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  mockGetSession.mockResolvedValue({ data: { session: SESSION } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('financial preferences: a failed optimistic save survives a pending update', () => {
  it('pending save + update ready + save fails + request ends: NO automatic reload; Retry succeeds, then it updates', async () => {
    const t = tab({ visibility: 'hidden' }); // hidden and safe would normally reload at once
    const first = deferred<unknown>();
    vi.mocked(fetch).mockImplementationOnce(() => first.promise as never);
    const { result } = renderHook(() => useFinancialPreferences(SAVED_PREFS, verify));

    act(() => result.current.setMinimumCashBuffer(750)); // applied on screen at once
    await act(flush);
    expect(fetch).toHaveBeenCalledTimes(1); // the save is in flight
    t.newBuildTakesControl();
    expect(t.reload).not.toHaveBeenCalled();

    await act(async () => {
      first.resolve(serverError()); // the request ends: authedFetch releases its own guard
      await flush();
    });
    expect(t.reload).not.toHaveBeenCalled();
    expect(result.current.saveStatus).toBe('error');
    expect(result.current.minimumCashBuffer).toBe(750); // the user's value is still on screen
    expect(t.guards()).toEqual(['pending_save']);
    expect(describeUpdateBanner(t.manager.getSnapshot())).toMatchObject({
      detail: 'The app will update after your changes are saved (if saving failed, use Retry).',
      actions: ['discard_and_reload'],
    });

    vi.mocked(fetch).mockResolvedValueOnce(ok() as never);
    await act(async () => {
      result.current.retry();
      await flush();
    });
    expect(result.current.saveStatus).toBe('saved');
    expect(sentBodies()[1].minimum_cash_buffer).toBe(750); // the same value, now durable
    expect(t.guards()).toEqual([]);
    expect(t.reload).toHaveBeenCalledTimes(1); // only now
  });

  it('...or the user explicitly discards the unsaved value', async () => {
    const t = tab({ visibility: 'hidden' });
    vi.mocked(fetch).mockResolvedValueOnce(serverError() as never);
    const { result } = renderHook(() => useFinancialPreferences(SAVED_PREFS, verify));
    act(() => result.current.setUpcomingBillsDays(30));
    t.newBuildTakesControl();
    await act(flush);
    expect(result.current.saveStatus).toBe('error');
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.manager.discardAndReload()).toBe(true);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('the save itself is refused with 409 client_update_required (visible, update ready): no reload over it', async () => {
    const t = tab({ visibility: 'visible' });
    t.leaveLaunchWindow();
    t.newBuildTakesControl(); // a new build is ready; a visible, safe page only shows the banner
    vi.mocked(fetch).mockResolvedValueOnce(updateRequired409() as never);
    const { result } = renderHook(() => useFinancialPreferences(SAVED_PREFS, verify));

    act(() => result.current.setSavingsRateTarget(35));
    await act(flush);
    // "Update required" alone would reload a safe page immediately; the failed value keeps it safe.
    expect(t.manager.isUpdateRequired()).toBe(true);
    expect(t.reload).not.toHaveBeenCalled();
    expect(result.current.savingsRateTarget).toBe(35);
    expect(describeUpdateBanner(t.manager.getSnapshot())).toMatchObject({
      severity: 'required',
      actions: ['discard_and_reload'],
    });
  });

  it('a successful ordinary save releases the guard normally (and the pending update then proceeds)', async () => {
    const t = tab({ visibility: 'hidden' });
    const save = deferred<unknown>();
    vi.mocked(fetch).mockImplementationOnce(() => save.promise as never);
    const { result } = renderHook(() => useFinancialPreferences(SAVED_PREFS, verify));
    act(() => result.current.setRecentAvgMonths(6));
    await act(flush);
    expect(t.guards()).toEqual(['mutation', 'pending_save']);
    t.newBuildTakesControl();
    expect(t.reload).not.toHaveBeenCalled();
    await act(async () => {
      save.resolve(ok());
      await flush();
    });
    expect(result.current.saveStatus).toBe('saved');
    expect(t.guards()).toEqual([]);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('with no update pending, a successful save leaves no guard behind', async () => {
    const t = tab();
    vi.mocked(fetch).mockResolvedValueOnce(ok() as never);
    const { result } = renderHook(() => useFinancialPreferences(SAVED_PREFS, verify));
    act(() => result.current.setIncludeUpcomingBills(false));
    await act(flush);
    expect(result.current.saveStatus).toBe('saved');
    expect(t.guards()).toEqual([]);
  });
});

describe('dashboard layout and reporting range: failed optimistic values survive a pending update', () => {
  it('dashboard: optimistic change + failed save + update ready: no reload while it differs from the saved layout', async () => {
    const t = tab({ visibility: 'hidden' });
    vi.mocked(fetch).mockResolvedValueOnce(serverError() as never);
    const { result } = renderHook(() => useDashboardLayout(null, verify));
    const statsBefore = result.current.layout.find((c) => c.id === 'stats')!.visible;

    act(() => result.current.toggleVisibility('stats'));
    t.newBuildTakesControl();
    await act(flush);
    expect(t.reload).not.toHaveBeenCalled();
    expect(result.current.layout.find((c) => c.id === 'stats')!.visible).toBe(!statsBefore);
    expect(result.current.saveStatus).toBe('error');
    expect(t.guards()).toEqual(['pending_save']);

    vi.mocked(fetch).mockResolvedValueOnce(ok() as never);
    await act(async () => {
      result.current.retry();
      await flush();
    });
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('reporting range: a failed range change holds the update; a newer successful change releases it', async () => {
    const t = tab({ visibility: 'hidden' });
    vi.mocked(fetch).mockResolvedValueOnce(serverError() as never);
    const { result } = renderHook(() => useReportingRange('last_6_months', verify, () => {}));

    act(() => result.current.setRange('last_3_months'));
    t.newBuildTakesControl();
    await act(flush);
    expect(t.reload).not.toHaveBeenCalled();
    expect(result.current.range).toBe('last_3_months');
    expect(result.current.saveStatus).toBe('error');

    vi.mocked(fetch).mockResolvedValueOnce(ok() as never);
    await act(async () => {
      result.current.setRange('last_12_months'); // the newest value is what gets saved
      await flush();
    });
    expect(result.current.saveStatus).toBe('saved');
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('appearance (the same save tracker): a failed theme save holds the update too', async () => {
    const t = tab({ visibility: 'hidden' });
    vi.mocked(fetch).mockResolvedValueOnce(serverError() as never);
    const { result } = renderHook(() => useAppearance({ theme: 'light', accent_color: 'green' }, verify));
    act(() => result.current.setTheme('dark'));
    t.newBuildTakesControl();
    await act(flush);
    expect(result.current.saveStatus).toBe('error');
    expect(t.reload).not.toHaveBeenCalled();
  });
});

describe('navigation: a layout queued behind an in-flight save is not lost', () => {
  function renderNav(sessionId: string) {
    return renderHook(() => useNavLayout('user-a', sessionId, navigationWriteCoordinator, verify, []));
  }

  it('first save in flight, newer layout queued, update ready: the first request ending does NOT reload; the queued one saving does', async () => {
    const t = tab({ visibility: 'hidden' });
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    vi.mocked(fetch)
      .mockImplementationOnce(() => first.promise as never)
      .mockImplementationOnce(() => second.promise as never);
    const { result } = renderNav('sid-nav-1');
    await act(flush);

    act(() => result.current.toggleVisibility('budget'));
    await act(flush);
    act(() => result.current.toggleVisibility('loans')); // queued behind the first
    await act(flush);
    expect(fetch).toHaveBeenCalledTimes(1);
    t.newBuildTakesControl();

    await act(async () => {
      first.resolve(ok()); // its request guard is released here...
      await flush();
    });
    expect(t.reload).not.toHaveBeenCalled(); // ...but the queued layout isn't saved yet
    expect(fetch).toHaveBeenCalledTimes(2); // the queued layout is now being sent
    const sent = sentBodies()[1].tabs as Array<{ id: string; visible: boolean }>;
    expect(sent.find((tb) => tb.id === 'loans')!.visible).toBe(false);
    expect(sent.find((tb) => tb.id === 'budget')!.visible).toBe(false);

    await act(async () => {
      second.resolve(ok());
      await flush();
    });
    expect(result.current.status).toBe('saved');
    expect(t.guards()).toEqual([]);
    expect(t.reload).toHaveBeenCalledTimes(1);
  });

  it('the queued layout fails: still no reload; Retry saves it and the update proceeds', async () => {
    const t = tab({ visibility: 'hidden' });
    const first = deferred<unknown>();
    vi.mocked(fetch)
      .mockImplementationOnce(() => first.promise as never)
      .mockResolvedValueOnce(serverError() as never);
    const { result } = renderNav('sid-nav-2');
    await act(flush);
    act(() => result.current.toggleVisibility('recurring'));
    await act(flush);
    act(() => result.current.move('income', 'up'));
    t.newBuildTakesControl();
    await act(async () => {
      first.resolve(ok());
      await flush();
    });
    expect(result.current.status).toBe('error');
    expect(t.reload).not.toHaveBeenCalled();
    expect(t.guards()).toEqual(['pending_save']);

    vi.mocked(fetch).mockResolvedValueOnce(ok() as never);
    await act(async () => {
      result.current.retry();
      await flush();
    });
    expect(result.current.status).toBe('saved');
    expect(t.reload).toHaveBeenCalledTimes(1);
  });
});

describe('no permanent guard', () => {
  it('unmounting a component whose save failed releases its guard', async () => {
    const t = tab();
    vi.mocked(fetch).mockResolvedValueOnce(serverError() as never);
    const prefs = renderHook(() => useFinancialPreferences(SAVED_PREFS, verify));
    act(() => prefs.result.current.setMinimumCashBuffer(10));
    await act(flush);
    expect(t.guards()).toEqual(['pending_save']);
    prefs.unmount(); // e.g. sign-out: the unsaved value goes with the component
    expect(t.guards()).toEqual([]);
  });

  it('a save still in flight at unmount does not re-acquire the guard when it later fails', async () => {
    const t = tab();
    const save = deferred<unknown>();
    vi.mocked(fetch).mockImplementationOnce(() => save.promise as never);
    const { result, unmount } = renderHook(() => useDashboardLayout(null, verify));
    act(() => result.current.move('stats', 'down'));
    await act(flush);
    unmount();
    expect(t.guards()).toEqual(['mutation']); // only the request itself, until it ends
    await act(async () => {
      save.resolve(serverError());
      await flush();
    });
    expect(t.guards()).toEqual([]);
  });

  it('detaching the navigation scope drops its failed/queued layouts and the guard with them', async () => {
    const t = tab();
    vi.mocked(fetch).mockResolvedValueOnce(serverError() as never);
    const { result, unmount } = renderHook(() =>
      useNavLayout('user-a', 'sid-nav-3', navigationWriteCoordinator, verify, [])
    );
    await act(flush);
    act(() => result.current.toggleVisibility('accounts'));
    await act(flush);
    expect(result.current.status).toBe('error');
    expect(t.guards()).toEqual(['pending_save']);
    unmount();
    expect(t.guards()).toEqual([]);
  });

  it('StrictMode (mount, simulated unmount, re-mount) still guards a failure, and releases on success', async () => {
    const t = tab();
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    vi.mocked(fetch).mockResolvedValueOnce(serverError() as never).mockResolvedValueOnce(ok() as never);
    const { result } = renderHook(() => useReportingRange('this_month', verify, () => {}), { wrapper });
    act(() => result.current.setRange('last_month'));
    await act(flush);
    expect(t.guards()).toEqual(['pending_save']);
    await act(async () => {
      result.current.retry();
      await flush();
    });
    expect(t.guards()).toEqual([]);
  });
});
