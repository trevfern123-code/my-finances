import { describe, expect, it, vi } from 'vitest';
import {
  CHECK_THROTTLE_MS,
  CLIENT_API_LEVEL,
  LAUNCH_WINDOW_MS,
  MAX_AUTO_RELOADS_IN_WINDOW,
  RELOAD_COOLDOWN_MS,
  RELOAD_HISTORY_KEY,
  REQUIRED_UPDATE_CHECK_INTERVAL_MS,
  SAME_BUILD_WINDOW_MS,
  SW_URL,
  UPDATE_CHECK_INTERVAL_MS,
  createAppUpdateManager,
  describeUpdateBanner,
  parseLevelHeader,
  type StorageLike,
  type UpdateSnapshot,
} from './appUpdate';

/** Everything the manager touches, faked: one instance is one browser tab. */
function fakeTab(opts: {
  buildId?: string;
  controller?: boolean;
  activeWorker?: boolean;
  visibility?: 'visible' | 'hidden';
  storage?: StorageLike | null;
  now?: number;
  noServiceWorker?: boolean;
} = {}) {
  let now = opts.now ?? 1_000_000;
  let visibility = opts.visibility ?? 'visible';
  const controllerListeners: Array<() => void> = [];
  const visibilityListeners: Array<() => void> = [];
  const preloadListeners: Array<(event: { preventDefault(): void }) => void> = [];
  const timers: Array<{ fn: () => void; ms: number; id: number; cleared: boolean }> = [];
  const timeouts: Array<{ fn: () => void; ms: number; fired: boolean }> = [];
  const update = vi.fn(() => Promise.resolve());
  const register = vi.fn((_url: string, _o?: { scope?: string }) =>
    Promise.resolve({ active: opts.activeWorker || opts.controller ? {} : null, update })
  );
  const reload = vi.fn();
  const storage = opts.storage === undefined ? memoryStorage() : opts.storage;

  const manager = createAppUpdateManager({
    buildId: opts.buildId ?? 'build-a',
    serviceWorker: opts.noServiceWorker
      ? null
      : {
          controller: opts.controller === false ? null : {},
          register,
          addEventListener: (_type, listener) => controllerListeners.push(listener),
        },
    getVisibility: () => visibility,
    onVisibilityChange: (l) => visibilityListeners.push(l),
    onPreloadError: (l) => preloadListeners.push(l),
    reload,
    storage,
    now: () => now,
    setInterval: (fn, ms) => {
      const t = { fn, ms, id: timers.length + 1, cleared: false };
      timers.push(t);
      return t.id;
    },
    clearInterval: (id) => {
      const t = timers.find((x) => x.id === id);
      if (t) t.cleared = true;
    },
    setTimeout: (fn, ms) => {
      timeouts.push({ fn, ms, fired: false });
      return timeouts.length;
    },
  });

  return {
    manager,
    reload,
    update,
    register,
    storage,
    timers,
    /** Starts the tab and lets the registration promise settle. */
    async start() {
      manager.start();
      await Promise.resolve();
      await Promise.resolve();
    },
    advance(ms: number) {
      now += ms;
    },
    newWorkerTakesControl() {
      controllerListeners.forEach((l) => l());
    },
    setVisibility(v: 'visible' | 'hidden') {
      visibility = v;
      visibilityListeners.forEach((l) => l());
    },
    /** Dispatches a cancelable `vite:preloadError`-like event; returns it for inspection. */
    preloadError() {
      const event = { defaultPrevented: false, preventDefault: vi.fn(() => void (event.defaultPrevented = true)) };
      preloadListeners.forEach((l) => l(event));
      return event;
    },
    /** Moves time forward to each pending one-shot timer and runs it. */
    fireTimeouts() {
      for (const t of timeouts.filter((x) => !x.fired)) {
        t.fired = true;
        now += t.ms;
        t.fn();
      }
    },
    pendingTimeouts: () => timeouts.filter((x) => !x.fired).map((x) => x.ms),
    fireIntervals(ms: number) {
      timers.filter((t) => t.ms === ms && !t.cleared).forEach((t) => t.fn());
    },
  };
}

function memoryStorage(initial: Record<string, string> = {}): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

function snapshot(partial: Partial<UpdateSnapshot>): UpdateSnapshot {
  return {
    buildId: 'b',
    updateAvailable: false,
    updateRequired: false,
    guards: [],
    autoReloadSuppressed: false,
    serverApiLevel: null,
    minClientApiLevel: null,
    ...partial,
  };
}

describe('app update manager — registration and checks', () => {
  it('registers the same /sw.js URL and checks for an update at startup', async () => {
    const tab = fakeTab();
    await tab.start();
    expect(SW_URL).toBe('/sw.js');
    expect(tab.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(tab.update).toHaveBeenCalledTimes(1);
  });

  it('checks periodically, and on becoming visible only when not checked recently', async () => {
    const tab = fakeTab();
    await tab.start();
    tab.fireIntervals(UPDATE_CHECK_INTERVAL_MS);
    expect(tab.update).toHaveBeenCalledTimes(2);

    tab.setVisibility('visible'); // just checked: throttled
    expect(tab.update).toHaveBeenCalledTimes(2);
    tab.advance(CHECK_THROTTLE_MS);
    tab.setVisibility('visible');
    expect(tab.update).toHaveBeenCalledTimes(3);
    tab.setVisibility('hidden'); // hiding never checks
    expect(tab.update).toHaveBeenCalledTimes(3);
  });

  it('works without service-worker support (no registration, nothing thrown)', async () => {
    const tab = fakeTab({ noServiceWorker: true });
    await tab.start();
    expect(tab.manager.getSnapshot().updateAvailable).toBe(false);
  });
});

describe('app update manager — activation', () => {
  it('treats the first-ever installation claiming the page as NOT an update', async () => {
    const tab = fakeTab({ controller: false });
    await tab.start();
    tab.newWorkerTakesControl();
    expect(tab.manager.getSnapshot().updateAvailable).toBe(false);
    expect(tab.reload).not.toHaveBeenCalled();
    // ...but a later worker taking control is.
    tab.advance(LAUNCH_WINDOW_MS);
    tab.newWorkerTakesControl();
    expect(tab.manager.getSnapshot().updateAvailable).toBe(true);
  });

  it('after a hard reload (active worker, no controller), the next worker taking control IS an update', async () => {
    const tab = fakeTab({ controller: false, activeWorker: true });
    await tab.start();
    tab.advance(LAUNCH_WINDOW_MS);
    tab.newWorkerTakesControl();
    expect(tab.manager.getSnapshot().updateAvailable).toBe(true);
  });

  it('reloads automatically when safe shortly after launch', async () => {
    const tab = fakeTab();
    await tab.start();
    tab.advance(LAUNCH_WINDOW_MS - 1);
    tab.newWorkerTakesControl();
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it('reloads automatically when safe and hidden', async () => {
    const tab = fakeTab({ visibility: 'hidden' });
    await tab.start();
    tab.advance(LAUNCH_WINDOW_MS);
    tab.newWorkerTakesControl();
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it('shows a Reload banner, not an automatic reload, when safe and visible — and reloads once hidden', async () => {
    const tab = fakeTab();
    await tab.start();
    tab.advance(LAUNCH_WINDOW_MS);
    tab.newWorkerTakesControl();
    expect(tab.reload).not.toHaveBeenCalled();
    expect(describeUpdateBanner(tab.manager.getSnapshot())).toMatchObject({
      title: 'A new version is ready.',
      actions: ['reload'],
    });
    expect(tab.manager.reloadNow()).toBe(true);
    expect(tab.reload).toHaveBeenCalledTimes(1);

    const other = fakeTab();
    await other.start();
    other.advance(LAUNCH_WINDOW_MS);
    other.newWorkerTakesControl();
    other.setVisibility('hidden');
    expect(other.reload).toHaveBeenCalledTimes(1);
  });

  it('treats a failed chunk preload as a sign of a new build: checks now, and goes through the same safe path', async () => {
    const tab = fakeTab();
    await tab.start();
    tab.advance(LAUNCH_WINDOW_MS);
    const release = tab.manager.acquireGuard('unsaved_edit');
    const event = tab.preloadError();
    // Recovery is the manager's: Vite must not also rethrow the failed import.
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(tab.update).toHaveBeenCalledTimes(2);
    expect(tab.manager.getSnapshot().updateAvailable).toBe(true);
    expect(tab.reload).not.toHaveBeenCalled(); // guarded, and visible
    release();
    tab.setVisibility('hidden');
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });
});

describe('app update manager — guards', () => {
  it.each(['mutation', 'hosted_link', 'reconnect', 'unsaved_edit', 'pending_save'] as const)(
    'a %s guard defers the reload, and releasing it resumes the update',
    async (kind) => {
      const tab = fakeTab({ visibility: 'hidden' });
      await tab.start();
      const release = tab.manager.acquireGuard(kind);
      tab.newWorkerTakesControl();
      expect(tab.reload).not.toHaveBeenCalled();
      expect(tab.manager.reloadNow()).toBe(false); // an explicit Reload is refused too
      expect(describeUpdateBanner(tab.manager.getSnapshot())).toMatchObject({
        title: 'A new version is ready — finish your current edit first.',
        // Only the user's own unsaved changes may be explicitly discarded.
        actions: kind === 'unsaved_edit' || kind === 'pending_save' ? ['discard_and_reload'] : [],
      });
      release();
      expect(tab.reload).toHaveBeenCalledTimes(1);
    }
  );

  it('a pending_save guard is explained as waiting for the save, with Retry', async () => {
    const tab = fakeTab();
    await tab.start();
    tab.advance(LAUNCH_WINDOW_MS);
    tab.manager.acquireGuard('pending_save');
    tab.newWorkerTakesControl();
    expect(describeUpdateBanner(tab.manager.getSnapshot())?.detail).toBe(
      'The app will update after your changes are saved (if saving failed, use Retry).'
    );
    expect(tab.manager.discardAndReload()).toBe(true); // the explicit way out
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it('counts nested guards and tolerates a double release', async () => {
    const tab = fakeTab({ visibility: 'hidden' });
    await tab.start();
    const a = tab.manager.acquireGuard('mutation');
    const b = tab.manager.acquireGuard('mutation');
    tab.newWorkerTakesControl();
    a();
    a();
    expect(tab.reload).not.toHaveBeenCalled();
    b();
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it('guards are per tab: a busy tab is not reloaded because another tab is safe', async () => {
    const shared = memoryStorage(); // separate sessionStorage per tab in reality; sharing is the worse case
    const busy = fakeTab({ visibility: 'hidden', storage: shared });
    const idle = fakeTab({ visibility: 'hidden', storage: memoryStorage() });
    await busy.start();
    await idle.start();
    const release = busy.manager.acquireGuard('hosted_link');
    busy.newWorkerTakesControl();
    idle.newWorkerTakesControl();
    expect(idle.reload).toHaveBeenCalledTimes(1);
    expect(busy.reload).not.toHaveBeenCalled();
    release();
    expect(busy.reload).toHaveBeenCalledTimes(1);
  });
});

describe('app update manager — update required', () => {
  it('a minimum above this client makes the update required, checks at once and then every minute', async () => {
    const tab = fakeTab();
    await tab.start();
    tab.advance(LAUNCH_WINDOW_MS);
    tab.manager.reportServerLevels(CLIENT_API_LEVEL + 1, CLIENT_API_LEVEL + 1);
    expect(tab.manager.isUpdateRequired()).toBe(true);
    expect(tab.update).toHaveBeenCalledTimes(2);
    tab.fireIntervals(REQUIRED_UPDATE_CHECK_INTERVAL_MS);
    expect(tab.update).toHaveBeenCalledTimes(3);
    // No newer build yet: nothing to reload onto.
    expect(tab.reload).not.toHaveBeenCalled();
    expect(describeUpdateBanner(tab.manager.getSnapshot())?.title).toBe('Update required — reload to continue.');
    // The new build arrives: required + safe reloads even while visible.
    tab.newWorkerTakesControl();
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it('markUpdateRequired (a 409 client_update_required) behaves the same', async () => {
    const tab = fakeTab();
    await tab.start();
    tab.manager.markUpdateRequired();
    expect(tab.manager.isUpdateRequired()).toBe(true);
  });

  it('a newer API level alone only checks for an update (throttled) and never blocks', async () => {
    const tab = fakeTab();
    await tab.start();
    tab.advance(CHECK_THROTTLE_MS);
    tab.manager.reportServerLevels(CLIENT_API_LEVEL + 1, 0);
    expect(tab.update).toHaveBeenCalledTimes(2);
    tab.manager.reportServerLevels(CLIENT_API_LEVEL + 1, 0);
    expect(tab.update).toHaveBeenCalledTimes(2);
    expect(tab.manager.isUpdateRequired()).toBe(false);
    expect(tab.manager.getSnapshot()).toMatchObject({ serverApiLevel: CLIENT_API_LEVEL + 1, minClientApiLevel: 0 });
  });

  it('a later response saying this level is supported again clears the required state', async () => {
    const tab = fakeTab();
    await tab.start();
    tab.manager.reportServerLevels(2, 2);
    tab.manager.reportServerLevels(1, 0);
    expect(tab.manager.isUpdateRequired()).toBe(false);
    expect(tab.timers.find((t) => t.ms === REQUIRED_UPDATE_CHECK_INTERVAL_MS)?.cleared).toBe(true);
  });

  it('ignores missing levels (a response without the headers changes nothing)', async () => {
    const tab = fakeTab();
    await tab.start();
    tab.manager.reportServerLevels(2, 2);
    tab.manager.reportServerLevels(null, null);
    expect(tab.manager.isUpdateRequired()).toBe(true);
  });

  it('required with unsaved edits: waits, and offers "discard and reload" as the way out', async () => {
    const tab = fakeTab();
    await tab.start();
    const release = tab.manager.acquireGuard('unsaved_edit');
    tab.manager.markUpdateRequired();
    tab.newWorkerTakesControl();
    expect(tab.reload).not.toHaveBeenCalled();
    const banner = describeUpdateBanner(tab.manager.getSnapshot());
    expect(banner).toMatchObject({ severity: 'required', actions: ['discard_and_reload'] });
    expect(tab.manager.reloadNow()).toBe(false);
    expect(tab.manager.discardAndReload()).toBe(true);
    expect(tab.reload).toHaveBeenCalledTimes(1);
    release();
  });

  it('discard never overrides a mutation, Hosted Link attempt or reconnect in progress', async () => {
    for (const kind of ['mutation', 'hosted_link', 'reconnect'] as const) {
      const tab = fakeTab();
      await tab.start();
      const release = tab.manager.acquireGuard(kind);
      tab.manager.acquireGuard('unsaved_edit');
      tab.manager.markUpdateRequired();
      tab.newWorkerTakesControl();
      expect(describeUpdateBanner(tab.manager.getSnapshot())).toMatchObject({ severity: 'required', actions: [] });
      expect(tab.manager.discardAndReload()).toBe(false);
      expect(tab.reload).not.toHaveBeenCalled();
      release();
    }
  });
});

describe('app update manager — reload-loop protection', () => {
  it('records each reload with the build it left', async () => {
    const tab = fakeTab({ visibility: 'hidden', buildId: 'build-a' });
    await tab.start();
    tab.newWorkerTakesControl();
    const history = JSON.parse((tab.storage as ReturnType<typeof memoryStorage>).data[RELOAD_HISTORY_KEY]);
    expect(history).toEqual([expect.objectContaining({ fromBuild: 'build-a', auto: true })]);
  });

  it('a reload that comes back running the SAME build stops automatic reloads (not just a timer)', async () => {
    const storage = memoryStorage();
    const first = fakeTab({ visibility: 'hidden', buildId: 'build-a', storage });
    await first.start();
    first.newWorkerTakesControl();
    expect(first.reload).toHaveBeenCalledTimes(1);

    // The "reloaded" page is still build-a (e.g. a CDN still serving the old index.html).
    const second = fakeTab({ visibility: 'hidden', buildId: 'build-a', storage, now: 1_000_000 + RELOAD_COOLDOWN_MS * 3 });
    await second.start();
    second.manager.reportServerLevels(2, 2); // even "required" does not loop
    second.preloadError();
    expect(second.reload).not.toHaveBeenCalled();
    expect(second.manager.getSnapshot().autoReloadSuppressed).toBe(true);
    // The banner still offers the manual path.
    expect(describeUpdateBanner(second.manager.getSnapshot())?.actions).toEqual(['reload']);
    // A genuinely new worker taking control is new evidence: automatic reloads resume.
    second.newWorkerTakesControl();
    expect(second.reload).toHaveBeenCalledTimes(1);
  });

  it('a reload that arrives on a NEW build is not suppressed', async () => {
    const storage = memoryStorage();
    const first = fakeTab({ visibility: 'hidden', buildId: 'build-a', storage });
    await first.start();
    first.newWorkerTakesControl();
    const second = fakeTab({ visibility: 'hidden', buildId: 'build-b', storage, now: 1_000_000 + RELOAD_COOLDOWN_MS });
    await second.start();
    expect(second.manager.getSnapshot().autoReloadSuppressed).toBe(false);
    second.newWorkerTakesControl();
    expect(second.reload).toHaveBeenCalledTimes(1);
  });

  it('same-build suppression expires after its window', async () => {
    const storage = memoryStorage({
      [RELOAD_HISTORY_KEY]: JSON.stringify([{ at: 1_000_000, fromBuild: 'build-a', auto: true }]),
    });
    const tab = fakeTab({ buildId: 'build-a', storage, now: 1_000_000 + SAME_BUILD_WINDOW_MS });
    await tab.start();
    expect(tab.manager.getSnapshot().autoReloadSuppressed).toBe(false);
  });

  it(`caps automatic reloads at ${MAX_AUTO_RELOADS_IN_WINDOW} in the window, even across builds`, async () => {
    const t0 = 1_000_000;
    const storage = memoryStorage({
      [RELOAD_HISTORY_KEY]: JSON.stringify([
        { at: t0, fromBuild: 'b1', auto: true },
        { at: t0 + 60_000, fromBuild: 'b2', auto: true },
        { at: t0 + 120_000, fromBuild: 'b3', auto: true },
      ]),
    });
    const tab = fakeTab({ visibility: 'hidden', buildId: 'b4', storage, now: t0 + 180_000 });
    await tab.start();
    tab.newWorkerTakesControl();
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.manager.reloadNow()).toBe(true); // manual reload is still allowed
  });

  it('keeps a cooldown between automatic reloads, and reloads by itself when it ends', async () => {
    const storage = memoryStorage({
      [RELOAD_HISTORY_KEY]: JSON.stringify([{ at: 1_000_000, fromBuild: 'b1', auto: true }]),
    });
    const tab = fakeTab({ buildId: 'b2', storage, now: 1_000_000 + 1000 });
    await tab.start();
    tab.advance(LAUNCH_WINDOW_MS); // past the launch window and visible, but still inside the cooldown
    tab.manager.markUpdateRequired();
    tab.newWorkerTakesControl();
    tab.newWorkerTakesControl(); // a second trigger does not stack a second timer
    expect(tab.reload).not.toHaveBeenCalled();
    expect(tab.pendingTimeouts()).toHaveLength(1);
    // No other event happens: the cooldown ending is enough (required + visible + safe).
    tab.fireTimeouts();
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it('a cooldown retry re-checks the guards: a page that became busy meanwhile is not reloaded', async () => {
    const storage = memoryStorage({
      [RELOAD_HISTORY_KEY]: JSON.stringify([{ at: 1_000_000, fromBuild: 'b1', auto: true }]),
    });
    const tab = fakeTab({ visibility: 'hidden', buildId: 'b2', storage, now: 1_000_000 + 1000 });
    await tab.start();
    tab.newWorkerTakesControl();
    const release = tab.manager.acquireGuard('unsaved_edit');
    tab.fireTimeouts();
    expect(tab.reload).not.toHaveBeenCalled();
    release();
    expect(tab.reload).toHaveBeenCalledTimes(1);
  });

  it("the user's own reload does not start the cooldown (a required page follows the next build at once)", async () => {
    const storage = memoryStorage();
    const first = fakeTab({ buildId: 'b1', storage });
    await first.start();
    first.advance(LAUNCH_WINDOW_MS);
    first.newWorkerTakesControl();
    expect(first.manager.reloadNow()).toBe(true); // manual, onto b2
    const second = fakeTab({ buildId: 'b2', storage, now: 1_000_000 + LAUNCH_WINDOW_MS + 1000 });
    await second.start();
    second.advance(LAUNCH_WINDOW_MS);
    second.manager.markUpdateRequired();
    second.newWorkerTakesControl(); // b3 arrives seconds later
    expect(second.reload).toHaveBeenCalledTimes(1);
  });

  it('never reloads automatically without working storage (it could not detect a loop)', async () => {
    const throwing: StorageLike = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    for (const storage of [null, throwing]) {
      const tab = fakeTab({ visibility: 'hidden', storage });
      await tab.start();
      tab.newWorkerTakesControl();
      expect(tab.reload).not.toHaveBeenCalled();
      expect(tab.manager.getSnapshot().autoReloadSuppressed).toBe(true);
      expect(tab.manager.reloadNow()).toBe(true);
      expect(tab.reload).toHaveBeenCalledTimes(1);
    }
  });

  it('replaces a corrupt history record instead of treating storage as broken', async () => {
    const storage = memoryStorage({ [RELOAD_HISTORY_KEY]: '{not json' });
    const tab = fakeTab({ visibility: 'hidden', storage });
    await tab.start();
    tab.newWorkerTakesControl();
    expect(tab.reload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storage.data[RELOAD_HISTORY_KEY])).toHaveLength(1);
  });

  it('never reloads automatically when the history cannot even be read', async () => {
    const storage: StorageLike = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
    };
    const tab = fakeTab({ visibility: 'hidden', storage });
    await tab.start();
    tab.newWorkerTakesControl();
    expect(tab.reload).not.toHaveBeenCalled();
  });
});

describe('describeUpdateBanner', () => {
  it('shows nothing when there is nothing to do', () => {
    expect(describeUpdateBanner(snapshot({}))).toBeNull();
  });

  it('names what it is waiting for', () => {
    expect(describeUpdateBanner(snapshot({ updateAvailable: true, guards: ['mutation'] }))?.detail).toContain(
      'finish saving'
    );
    expect(describeUpdateBanner(snapshot({ updateAvailable: true, guards: ['hosted_link'] }))?.detail).toContain(
      'linking your bank'
    );
    expect(describeUpdateBanner(snapshot({ updateAvailable: true, guards: ['reconnect'] }))?.detail).toContain(
      'reconnecting'
    );
    expect(describeUpdateBanner(snapshot({ updateAvailable: true, guards: ['unsaved_edit'] }))?.detail).toContain(
      'unsaved changes'
    );
  });

  it('describes the required states', () => {
    expect(describeUpdateBanner(snapshot({ updateRequired: true, updateAvailable: true }))?.title).toBe(
      'Update required — reloading…'
    );
    expect(
      describeUpdateBanner(snapshot({ updateRequired: true, updateAvailable: true, autoReloadSuppressed: true }))
    ).toMatchObject({ title: 'Update required — reload to continue.', actions: ['reload'] });
    expect(describeUpdateBanner(snapshot({ updateRequired: true, guards: ['hosted_link', 'unsaved_edit'] }))).toMatchObject({
      detail: expect.stringContaining('Saving is turned off'),
      actions: [],
    });
  });
});

describe('parseLevelHeader', () => {
  it('accepts canonical non-negative integers only', () => {
    expect(parseLevelHeader('0')).toBe(0);
    expect(parseLevelHeader('1')).toBe(1);
    expect(parseLevelHeader('999999')).toBe(999999);
    for (const bad of [null, '', ' 1', '01', '-1', '1.0', '1e2', 'abc', '1000000']) {
      expect(parseLevelHeader(bad)).toBeNull();
    }
  });
});

describe('update required, unsaved changes, and no newer build yet (Codex re-review A)', () => {
  it.each(['unsaved_edit', 'pending_save'] as const)(
    'with %s: never offers a destructive discard that would only reload the same build',
    async (kind) => {
      const tab = fakeTab();
      await tab.start();
      tab.advance(LAUNCH_WINDOW_MS);
      const release = tab.manager.acquireGuard(kind);
      tab.manager.markUpdateRequired(); // e.g. a 409 client_update_required; no new worker yet

      const banner = describeUpdateBanner(tab.manager.getSnapshot());
      expect(banner).toEqual({
        severity: 'required',
        title: "Update required — the newer version isn't available yet.",
        detail: 'Saving is turned off. Your unsaved changes stay on screen while the app keeps checking for the update.',
        actions: [],
      });
      expect(tab.manager.discardAndReload()).toBe(false); // refused even if called directly
      expect(tab.manager.isUpdateRequired()).toBe(true); // mutations stay blocked
      expect(tab.reload).not.toHaveBeenCalled();

      // Still checking: once now, and every minute.
      const checks = tab.update.mock.calls.length;
      tab.fireIntervals(REQUIRED_UPDATE_CHECK_INTERVAL_MS);
      expect(tab.update.mock.calls.length).toBe(checks + 1);

      // The newer build arrives: now, and only now, discarding is offered.
      tab.newWorkerTakesControl();
      expect(tab.reload).not.toHaveBeenCalled(); // still guarded
      expect(describeUpdateBanner(tab.manager.getSnapshot())?.actions).toEqual(['discard_and_reload']);
      expect(tab.manager.discardAndReload()).toBe(true);
      expect(tab.reload).toHaveBeenCalledTimes(1);
      release();
    }
  );
});
