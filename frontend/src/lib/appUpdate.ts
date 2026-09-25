/**
 * Application update manager (service-worker / version compatibility, phase 2).
 *
 * WHY: a tab (or installed PWA window) keeps running the JavaScript it loaded, even after a newer
 * build is deployed and a newer service worker has taken control of it. During the 2026-09-24
 * release that let an old tab run a retired Plaid flow against the new backend. The generated
 * service worker (vite-plugin-pwa, `registerType: 'autoUpdate'`) still activates immediately and
 * claims open pages; this module is the page-side half that was missing:
 *
 * - registers `/sw.js` itself (the injected bare registration is disabled in vite.config.ts), and
 *   checks for a newer worker on startup, every 30 minutes, when the tab becomes visible again
 *   (throttled), and when the backend reports a newer API level;
 * - notices when a NEW worker takes control of this already-running page (`controllerchange`), which
 *   means a newer build is available. The first-ever installation claiming a page is not an update;
 * - reloads onto the new build only when it is safe: never while a guard is active (a mutation in
 *   flight, a Hosted Link attempt, the Reconnect modal, unsaved edits). A safe page reloads
 *   automatically shortly after launch or while hidden; a safe visible page shows a banner instead;
 * - tracks the backend's API levels (see backend/src/middleware/clientApiLevel.ts). Below the
 *   minimum, the client is "update required": new mutations are refused before they are sent, and
 *   the page reloads as soon as it is safe AND a newer build is actually available;
 * - protects against reload loops by build identity, not only by time: if an update reload comes
 *   back running the same build, automatic reloads stop for this page (the banner remains).
 *
 * Guards are per tab. Each tab decides for itself, so a busy tab is never reloaded because another
 * tab updated; no cross-tab coordination is needed.
 */

/** The API level this client speaks. Sent as `X-Client-Api-Level` on every app API request. */
export const CLIENT_API_LEVEL = 1;

export const SW_URL = '/sw.js';
export const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const REQUIRED_UPDATE_CHECK_INTERVAL_MS = 60 * 1000;
export const CHECK_THROTTLE_MS = 60 * 1000;
export const LAUNCH_WINDOW_MS = 15 * 1000;
export const RELOAD_COOLDOWN_MS = 30 * 1000;
export const SAME_BUILD_WINDOW_MS = 5 * 60 * 1000;
export const RELOAD_HISTORY_WINDOW_MS = 10 * 60 * 1000;
export const MAX_AUTO_RELOADS_IN_WINDOW = 3;
export const RELOAD_HISTORY_KEY = 'my-finances:update-reloads';

/**
 * What can make a reload unsafe right now:
 * - `mutation`: a request that changes data is in flight (held by authedFetch);
 * - `hosted_link` / `reconnect`: a Plaid flow this tab is completing;
 * - `unsaved_edit`: a form or field holds typed values that have not been submitted;
 * - `pending_save`: a change already applied on screen is not yet durably saved — being sent,
 *   queued behind another save, or failed and waiting for Retry (held by the save trackers, from
 *   the edit until the save succeeds, so it outlives the request's own `mutation` guard).
 * Only `unsaved_edit` and `pending_save` may be discarded, and only by the user's explicit choice.
 */
export type GuardKind = 'mutation' | 'hosted_link' | 'reconnect' | 'unsaved_edit' | 'pending_save';

export interface UpdateSnapshot {
  buildId: string;
  /** A newer build has taken control of this page (or a failed chunk load suggests one). */
  updateAvailable: boolean;
  /** The backend no longer serves this client's API level. */
  updateRequired: boolean;
  /** Distinct guard kinds currently active in this tab, sorted. */
  guards: GuardKind[];
  /** Loop protection has stopped automatic reloads for this page. */
  autoReloadSuppressed: boolean;
  serverApiLevel: number | null;
  minClientApiLevel: number | null;
}

export interface ServiceWorkerRegistrationLike {
  /** The worker already active for this scope when registration resolved (null on a first install). */
  readonly active?: unknown;
  update(): Promise<unknown>;
}

export interface ServiceWorkerContainerLike {
  readonly controller: unknown;
  register(url: string, options?: { scope?: string }): Promise<ServiceWorkerRegistrationLike>;
  addEventListener(type: 'controllerchange', listener: () => void): void;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface UpdateManagerDeps {
  buildId: string;
  serviceWorker: ServiceWorkerContainerLike | null;
  getVisibility(): 'visible' | 'hidden';
  onVisibilityChange(listener: () => void): void;
  /** Vite's `vite:preloadError` (a lazy chunk failed to load, usually because a deploy replaced it). */
  onPreloadError(listener: (event: { preventDefault(): void }) => void): void;
  reload(): void;
  storage: StorageLike | null;
  now(): number;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(id: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
}

interface ReloadRecord {
  at: number;
  fromBuild: string;
  auto: boolean;
}

export interface AppUpdateManager {
  start(): void;
  getSnapshot(): UpdateSnapshot;
  subscribe(listener: () => void): () => void;
  /** Marks this tab busy until the returned function is called (idempotent). */
  acquireGuard(kind: GuardKind): () => void;
  /** Feeds the levels a backend response reported; null means "not reported". */
  reportServerLevels(apiLevel: number | null, minClientApiLevel: number | null): void;
  /** The backend answered `client_update_required`. */
  markUpdateRequired(): void;
  isUpdateRequired(): boolean;
  /** Explicit user reload. Refused while any guard is active. */
  reloadNow(): boolean;
  /** Explicit user choice to lose unsaved edits. Refused while a non-discardable guard is active,
   *  and while no newer build is available (it would only reload onto this same build). */
  discardAndReload(): boolean;
}

const NON_DISCARDABLE: GuardKind[] = ['mutation', 'hosted_link', 'reconnect'];

export function createAppUpdateManager(deps: UpdateManagerDeps): AppUpdateManager {
  const guardCounts = new Map<GuardKind, number>();
  const listeners = new Set<() => void>();

  let started = false;
  let launchedAt = 0;
  let registration: ServiceWorkerRegistrationLike | null = null;
  let controllerSeen = false;
  let lastCheckAt = Number.NEGATIVE_INFINITY;
  let requiredTimer: unknown = null;
  let cooldownTimer: unknown = null;
  let reloading = false;

  let updateAvailable = false;
  let updateRequired = false;
  let serverApiLevel: number | null = null;
  let minClientApiLevel: number | null = null;

  let storageOk = deps.storage !== null;
  let history: ReloadRecord[] = [];
  let sameBuildSuppressed = false;

  let snapshot = buildSnapshot();

  function activeGuards(): GuardKind[] {
    return [...guardCounts.entries()].filter(([, n]) => n > 0).map(([k]) => k).sort();
  }

  function recentAutoReloads(): number {
    const now = deps.now();
    return history.filter((r) => r.auto && now - r.at < RELOAD_HISTORY_WINDOW_MS).length;
  }

  function autoReloadSuppressed(): boolean {
    return !storageOk || sameBuildSuppressed || recentAutoReloads() >= MAX_AUTO_RELOADS_IN_WINDOW;
  }

  function buildSnapshot(): UpdateSnapshot {
    return {
      buildId: deps.buildId,
      updateAvailable,
      updateRequired,
      guards: activeGuards(),
      autoReloadSuppressed: autoReloadSuppressed(),
      serverApiLevel,
      minClientApiLevel,
    };
  }

  function emit() {
    const next = buildSnapshot();
    const prev = snapshot;
    const changed =
      next.updateAvailable !== prev.updateAvailable ||
      next.updateRequired !== prev.updateRequired ||
      next.autoReloadSuppressed !== prev.autoReloadSuppressed ||
      next.serverApiLevel !== prev.serverApiLevel ||
      next.minClientApiLevel !== prev.minClientApiLevel ||
      next.guards.join(',') !== prev.guards.join(',');
    if (!changed) return;
    snapshot = next;
    for (const listener of listeners) listener();
  }

  function loadHistory() {
    if (!deps.storage) return;
    let raw: string | null;
    try {
      raw = deps.storage.getItem(RELOAD_HISTORY_KEY);
    } catch {
      storageOk = false;
      return;
    }
    try {
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      history = Array.isArray(parsed)
        ? parsed.filter(
            (r): r is ReloadRecord =>
              typeof r === 'object' && r !== null &&
              typeof (r as ReloadRecord).at === 'number' &&
              typeof (r as ReloadRecord).fromBuild === 'string' &&
              typeof (r as ReloadRecord).auto === 'boolean'
          )
        : [];
    } catch {
      history = []; // An unreadable record is replaced on the next save.
    }
  }

  function saveHistory(): boolean {
    if (!deps.storage) return false;
    const now = deps.now();
    history = history.filter((r) => now - r.at < RELOAD_HISTORY_WINDOW_MS).slice(-10);
    try {
      deps.storage.setItem(RELOAD_HISTORY_KEY, JSON.stringify(history));
      return true;
    } catch {
      storageOk = false;
      return false;
    }
  }

  function doReload(auto: boolean) {
    if (reloading) return;
    history.push({ at: deps.now(), fromBuild: deps.buildId, auto });
    const saved = saveHistory();
    // Without a durable record, an automatic reload could loop across page loads: refuse it.
    if (auto && !saved) {
      emit();
      return;
    }
    reloading = true;
    deps.reload();
  }

  /** How long until the cooldown after the last AUTOMATIC reload ends (0 = now). A user's own reload
   *  does not start it: the same-build check already covers a reload that did not help. */
  function cooldownRemaining(): number {
    const lastAuto = history.filter((r) => r.auto).pop();
    return lastAuto ? Math.max(0, RELOAD_COOLDOWN_MS - (deps.now() - lastAuto.at)) : 0;
  }

  function evaluate() {
    emit();
    if (reloading || !updateAvailable) return;
    if (activeGuards().length > 0) return;
    if (autoReloadSuppressed()) return;
    const withinLaunch = deps.now() - launchedAt < LAUNCH_WINDOW_MS;
    if (!(updateRequired || withinLaunch || deps.getVisibility() === 'hidden')) return;
    const wait = cooldownRemaining();
    if (wait > 0) {
      // Deferred only by the cooldown: look again when it ends, rather than waiting for an
      // unrelated event (a required, visible page would otherwise sit there).
      if (cooldownTimer === null) {
        cooldownTimer = deps.setTimeout(() => {
          cooldownTimer = null;
          evaluate();
        }, wait);
      }
      return;
    }
    doReload(true);
  }

  function checkForUpdate(force: boolean) {
    if (!registration) return;
    const now = deps.now();
    if (!force && now - lastCheckAt < CHECK_THROTTLE_MS) return;
    lastCheckAt = now;
    try {
      registration.update().catch(() => {
        // Offline, or the worker script is briefly unavailable: the next trigger tries again.
      });
    } catch {
      // Some browsers throw synchronously while the page is unloading: nothing to do.
    }
  }

  function setRequired(required: boolean) {
    if (updateRequired === required) return;
    updateRequired = required;
    if (required) {
      checkForUpdate(true);
      if (requiredTimer === null) {
        requiredTimer = deps.setInterval(() => checkForUpdate(true), REQUIRED_UPDATE_CHECK_INTERVAL_MS);
      }
    } else if (requiredTimer !== null) {
      deps.clearInterval(requiredTimer);
      requiredTimer = null;
    }
    evaluate();
  }

  function markAvailable() {
    updateAvailable = true;
    evaluate();
  }

  return {
    start() {
      if (started) return;
      started = true;
      launchedAt = deps.now();

      loadHistory();
      const last = history[history.length - 1];
      // The previous page reloaded for an update but this page runs the SAME build: the reload did
      // not help (a CDN or worker state briefly inconsistent). Stop automatic reloads for this page.
      sameBuildSuppressed =
        last !== undefined && last.fromBuild === deps.buildId && deps.now() - last.at < SAME_BUILD_WINDOW_MS;

      deps.onVisibilityChange(() => {
        if (deps.getVisibility() === 'visible') checkForUpdate(false);
        evaluate();
      });
      deps.onPreloadError((event) => {
        // Recovery is ours from here (a guarded reload onto the new build), so Vite must not also
        // rethrow the import error. The app has no lazy chunks today; this covers any added later.
        event.preventDefault();
        checkForUpdate(true);
        markAvailable();
      });

      const sw = deps.serviceWorker;
      if (sw) {
        controllerSeen = sw.controller !== null && sw.controller !== undefined;
        sw.addEventListener('controllerchange', () => {
          if (!controllerSeen) {
            // First-ever installation claiming this page: the page already runs the newest build.
            controllerSeen = true;
            return;
          }
          // A genuinely new worker is new evidence, even after an earlier reload that didn't help.
          sameBuildSuppressed = false;
          markAvailable();
        });
        sw.register(SW_URL, { scope: '/' })
          .then((reg) => {
            registration = reg;
            // A worker was already active but not controlling this page (a hard reload bypasses it):
            // the page came from the network, so the next worker to take control IS a newer build.
            if (reg.active !== null && reg.active !== undefined) controllerSeen = true;
            checkForUpdate(true);
          })
          .catch(() => {
            // Registration failed (private mode, blocked): the app still works, just without updates.
          });
      }
      deps.setInterval(() => checkForUpdate(true), UPDATE_CHECK_INTERVAL_MS);
      emit();
    },

    getSnapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    acquireGuard(kind) {
      guardCounts.set(kind, (guardCounts.get(kind) ?? 0) + 1);
      emit();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        guardCounts.set(kind, Math.max(0, (guardCounts.get(kind) ?? 0) - 1));
        evaluate();
      };
    },

    reportServerLevels(apiLevel, minLevel) {
      if (apiLevel !== null) serverApiLevel = apiLevel;
      if (minLevel !== null) minClientApiLevel = minLevel;
      if (apiLevel !== null && apiLevel > CLIENT_API_LEVEL) checkForUpdate(false);
      // A response saying we're supported again (e.g. after a backend rollback) clears the state.
      if (minLevel !== null) setRequired(minLevel > CLIENT_API_LEVEL);
      emit();
    },

    markUpdateRequired() {
      setRequired(true);
    },

    isUpdateRequired: () => updateRequired,

    reloadNow() {
      if (activeGuards().length > 0) return false;
      doReload(false);
      return true;
    },

    discardAndReload() {
      if (!updateAvailable) return false;
      if (activeGuards().some((g) => NON_DISCARDABLE.includes(g))) return false;
      doReload(false);
      return true;
    },
  };
}

// ---- Banner description (pure, so every state is directly testable) --------------------------------

export type BannerAction = 'reload' | 'discard_and_reload';

export interface BannerDescription {
  severity: 'info' | 'required';
  title: string;
  detail: string;
  actions: BannerAction[];
}

function waitingFor(guards: GuardKind[]): string {
  if (guards.includes('mutation')) return 'your changes finish saving';
  if (guards.includes('hosted_link')) return 'you finish linking your bank';
  if (guards.includes('reconnect')) return 'you finish reconnecting your bank';
  if (guards.includes('pending_save')) return 'your changes are saved (if saving failed, use Retry)';
  return 'you save or cancel your unsaved changes';
}

export function describeUpdateBanner(s: UpdateSnapshot): BannerDescription | null {
  if (!s.updateAvailable && !s.updateRequired) return null;
  const blocking = s.guards.filter((g) => NON_DISCARDABLE.includes(g));
  const dirty = s.guards.length > 0 && blocking.length === 0; // only discardable guards

  if (!s.updateRequired) {
    if (s.guards.length > 0) {
      return {
        severity: 'info',
        title: 'A new version is ready — finish your current edit first.',
        detail: `The app will update after ${waitingFor(s.guards)}.`,
        // Discarding is offered only when nothing but the user's own unsaved changes is waiting.
        actions: dirty ? ['discard_and_reload'] : [],
      };
    }
    return { severity: 'info', title: 'A new version is ready.', detail: 'Reload to start using it.', actions: ['reload'] };
  }

  if (blocking.length > 0) {
    return {
      severity: 'required',
      title: 'Update required — this version is out of date.',
      detail: `Saving is turned off. The app will update after ${waitingFor(blocking)}.`,
      actions: [],
    };
  }
  if (dirty) {
    if (!s.updateAvailable) {
      // Reloading now would only load this same, incompatible build: never invite the user to
      // throw their changes away for that. Wait for the newer build to arrive.
      return {
        severity: 'required',
        title: "Update required — the newer version isn't available yet.",
        detail: 'Saving is turned off. Your unsaved changes stay on screen while the app keeps checking for the update.',
        actions: [],
      };
    }
    return {
      severity: 'required',
      title: 'Update required — this version is out of date.',
      detail: "Your unsaved changes can't be saved with this version. Discard them and reload to update.",
      actions: ['discard_and_reload'],
    };
  }
  if (s.updateAvailable && !s.autoReloadSuppressed) {
    return { severity: 'required', title: 'Update required — reloading…', detail: 'Saving is turned off until the app updates.', actions: ['reload'] };
  }
  return {
    severity: 'required',
    title: 'Update required — reload to continue.',
    detail: s.updateAvailable
      ? 'Saving is turned off until the app updates.'
      : "Saving is turned off. A newer version isn't available yet; the app keeps checking.",
    actions: ['reload'],
  };
}

// ---- API-level header parsing -------------------------------------------------------------------------

const CANONICAL_LEVEL = /^(0|[1-9][0-9]{0,5})$/;

/** Parses an `X-Api-Level` / `X-Min-Client-Api-Level` header value strictly; null when absent or malformed. */
export function parseLevelHeader(raw: string | null): number | null {
  if (raw === null || !CANONICAL_LEVEL.test(raw)) return null;
  return Number(raw);
}

// ---- The application's singleton ------------------------------------------------------------------------

declare const __APP_BUILD_ID__: string | undefined;

export const APP_BUILD_ID: string = typeof __APP_BUILD_ID__ === 'string' ? __APP_BUILD_ID__ : 'unknown';

function browserDeps(): UpdateManagerDeps {
  const hasWindow = typeof window !== 'undefined';
  const hasDocument = typeof document !== 'undefined';
  let storage: StorageLike | null = null;
  try {
    storage = hasWindow ? window.sessionStorage : null;
  } catch {
    storage = null; // Access can throw when storage is blocked.
  }
  return {
    buildId: APP_BUILD_ID,
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null,
    getVisibility: () => (hasDocument && document.visibilityState === 'hidden' ? 'hidden' : 'visible'),
    onVisibilityChange: (listener) => {
      if (hasDocument) document.addEventListener('visibilitychange', listener);
    },
    onPreloadError: (listener) => {
      if (hasWindow) window.addEventListener('vite:preloadError', (event) => listener(event));
    },
    reload: () => window.location.reload(),
    storage,
    now: () => Date.now(),
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (id) => clearInterval(id as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  };
}

/** The single manager every part of the app shares. `start()` is called once, from main.tsx. */
export const appUpdate: AppUpdateManager = createAppUpdateManager(browserDeps());
