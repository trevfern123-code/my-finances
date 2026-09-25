export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

const DEFAULT_SAVED_DISPLAY_MS = 2000;

// Deliberately narrower than `typeof setTimeout`/`typeof clearTimeout` (Node's lib types include
// a `__promisify__` member neither this code nor a test double needs to satisfy) — just enough
// shape to schedule and cancel a callback.
type TimeoutHandle = ReturnType<typeof setTimeout>;
type SetTimeoutFn = (callback: () => void, ms: number) => TimeoutHandle;
type ClearTimeoutFn = (handle: TimeoutHandle | undefined) => void;

export interface SaveStatusTrackerOptions {
  /** How long 'saved' stays visible before fading back to 'idle'. Defaults to 2000ms; overridden
   *  in tests to avoid real waiting. */
  savedDisplayMs?: number;
  onStatusChange: (status: SaveStatus) => void;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
  /** Holds the app-update `pending_save` guard (lib/appUpdate.ts) and returns its release. While
   *  the latest change is not durably saved — 'saving', or 'error' awaiting Retry — the tracker
   *  holds it, so an automatic update reload can never throw that change away. */
  acquireGuard?: () => () => void;
}

/**
 * The framework-agnostic state machine behind useSaveStatus — kept separate from the hook (same
 * split this codebase already uses for dashboardLayout.ts/useDashboardLayout.ts and every other
 * "pure logic + thin React wrapper" pair) specifically so its transitions are unit-testable
 * without a DOM or a component-testing library, neither of which this project uses anywhere else.
 *
 * `status` only ever becomes 'saved' after the tracked promise has actually resolved, and only
 * ever becomes 'error' after it has actually rejected — never merely because `track()` was
 * called. A stale attempt's resolution/rejection can never overwrite a newer attempt's status:
 * each call to `track()` invalidates any earlier one still in flight.
 */
export class SaveStatusTracker {
  private status: SaveStatus = 'idle';
  private lastAttempt: (() => Promise<unknown>) | null = null;
  private attemptId = 0;
  private resetTimer: TimeoutHandle | undefined;
  private readonly savedDisplayMs: number;
  private readonly onStatusChange: (status: SaveStatus) => void;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;
  private readonly acquireGuard: (() => () => void) | null;
  private releaseGuard: (() => void) | null = null;
  private guardEnabled = true;

  constructor(options: SaveStatusTrackerOptions) {
    this.acquireGuard = options.acquireGuard ?? null;
    this.savedDisplayMs = options.savedDisplayMs ?? DEFAULT_SAVED_DISPLAY_MS;
    this.onStatusChange = options.onStatusChange;
    // Wrapped in a fresh arrow function rather than assigned directly (`options.setTimeoutFn ??
    // setTimeout`) — the global setTimeout/clearTimeout are WebIDL platform functions that throw
    // "Illegal invocation" in a real browser when called as a detached method reference
    // (`this.setTimeoutFn(...)` no longer has `window` as its receiver once stored on `this`).
    // Calling them from inside a plain arrow function keeps the call itself a normal global
    // invocation. Node-only test environments don't enforce this receiver check, which is exactly
    // why this needs stating explicitly rather than relying on tests alone to catch it.
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((id) => clearTimeout(id));
  }

  getStatus(): SaveStatus {
    return this.status;
  }

  private setStatus(next: SaveStatus): void {
    this.status = next;
    // Synchronously, before anything else observes the new status: a save's own request guard is
    // released just before its outcome reaches this tracker, so a failure must already be covered.
    this.syncGuard();
    this.onStatusChange(next);
  }

  /** The change is not durable while it is being saved, or after its save failed (Retry pending). */
  private syncGuard(): void {
    const needed = this.guardEnabled && (this.status === 'saving' || this.status === 'error');
    if (needed && !this.releaseGuard && this.acquireGuard) {
      this.releaseGuard = this.acquireGuard();
    } else if (!needed && this.releaseGuard) {
      const release = this.releaseGuard;
      this.releaseGuard = null;
      release();
    }
  }

  /** (Re-)enables the guard on mount — including React StrictMode's re-mount after its simulated
   *  cleanup called dispose(). */
  enableGuard(): void {
    this.guardEnabled = true;
    this.syncGuard();
  }

  /** Starts tracking a new save attempt: 'saving' immediately, then 'saved' or 'error' once
   *  `run()` actually settles — never before. `run` is a thunk (not an already-started promise)
   *  specifically so `retry()` can safely re-invoke the exact same attempt later. */
  track(run: () => Promise<unknown>): void {
    this.lastAttempt = run;
    this.clearTimeoutFn(this.resetTimer);
    const id = ++this.attemptId;
    this.setStatus('saving');
    run().then(
      () => {
        if (this.attemptId !== id) return; // a newer attempt has already superseded this one
        this.setStatus('saved');
        this.resetTimer = this.setTimeoutFn(() => this.setStatus('idle'), this.savedDisplayMs);
      },
      () => {
        if (this.attemptId !== id) return;
        this.setStatus('error');
      }
    );
  }

  /** Re-invokes the exact thunk from the most recent `track()` call — a no-op if nothing has
   *  ever been tracked yet. */
  retry(): void {
    if (this.lastAttempt) this.track(this.lastAttempt);
  }

  /** Releases the pending idle-reset timer and the update guard, if any — call on unmount. The
   *  changes the guard covered go away with the component, and a save still settling afterwards
   *  never re-acquires it. */
  dispose(): void {
    this.clearTimeoutFn(this.resetTimer);
    this.guardEnabled = false;
    this.syncGuard();
  }
}

export interface SaveStatusDisplay {
  visible: boolean;
  text: string;
  showRetry: boolean;
}

/** Pure mapping from status to what SaveStatusIndicator actually renders — split out so the
 *  "what text/whether Retry shows for each status" logic is testable without mounting the
 *  component. */
export function getSaveStatusDisplay(status: SaveStatus): SaveStatusDisplay {
  switch (status) {
    case 'idle':
      return { visible: false, text: '', showRetry: false };
    case 'saving':
      return { visible: true, text: 'Saving…', showRetry: false };
    case 'saved':
      return { visible: true, text: 'Saved ✓', showRetry: false };
    case 'error':
      return { visible: true, text: 'Couldn’t save.', showRetry: true };
  }
}
