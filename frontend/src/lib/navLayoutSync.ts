import type { SaveStatus } from './saveStatus';
import type { NavTabEntry } from './navLayout';

const DEFAULT_SAVED_DISPLAY_MS = 2000;

// Same narrower-than-`typeof setTimeout` shape as lib/saveStatus.ts, for the same reason.
type TimeoutHandle = ReturnType<typeof setTimeout>;
type SetTimeoutFn = (callback: () => void, ms: number) => TimeoutHandle;
type ClearTimeoutFn = (handle: TimeoutHandle | undefined) => void;

export interface NavLayoutSyncOptions {
  save: (layout: NavTabEntry[]) => Promise<unknown>;
  onStatusChange: (status: SaveStatus) => void;
  savedDisplayMs?: number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
}

/**
 * Guarantees the server ends up holding the last navigation layout the user actually set, no
 * matter how quickly they hide/show/reorder tabs in succession — by construction, not by detecting
 * and discarding stale responses after the fact the way lib/saveStatus.ts's `attemptId` does for
 * *displayed status only*. At most one `save()` call is ever outstanding at a time; every
 * `submit()` that arrives while one is in flight replaces (not queues alongside) whatever was
 * waiting to go next, so the pending slot never holds more than the single newest layout.
 *
 * Because dispatch is strictly one-at-a-time, there is never a second in-flight request that could
 * complete out of order relative to the first — the race this exists to prevent (an older, slower
 * write landing at the server after a newer one already committed) cannot occur upstream at all,
 * not merely be papered over on the client.
 *
 * One instance is scoped to exactly one authenticated identity (see hooks/useNavLayout.ts, which
 * creates a fresh instance — and disposes the previous one — whenever the authenticated user
 * changes). `dispose()` is what makes that safe: it discards any not-yet-sent layout immediately,
 * and permanently silences the instance so an already-in-flight request from the *previous* user is
 * still allowed to finish normally on the wire (nothing cancels the actual HTTP call), but its
 * outcome can never dispatch further work or report status into whatever identity is current by
 * the time it settles.
 */
export class NavLayoutSync {
  private inFlight = false;
  private pending: NavTabEntry[] | null = null;
  private lastAttempted: NavTabEntry[] | null = null;
  private resetTimer: TimeoutHandle | undefined;
  private disposed = false;
  private readonly save: (layout: NavTabEntry[]) => Promise<unknown>;
  private readonly onStatusChange: (status: SaveStatus) => void;
  private readonly savedDisplayMs: number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;

  constructor(options: NavLayoutSyncOptions) {
    this.save = options.save;
    this.onStatusChange = options.onStatusChange;
    this.savedDisplayMs = options.savedDisplayMs ?? DEFAULT_SAVED_DISPLAY_MS;
    // Wrapped in a fresh arrow function, not assigned directly — see lib/saveStatus.ts's identical
    // comment: the global setTimeout/clearTimeout throw "Illegal invocation" in a real browser when
    // called as a detached method reference, a hazard Node's test environment doesn't enforce.
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((id) => clearTimeout(id));
  }

  /** Called on every local edit (toggle/move/reset). Never blocks and never itself calls `save` —
   *  it only records what the newest desired layout is and, if nothing is currently in flight,
   *  kicks off sending it. Safe to call as rapidly as the user can click. A no-op once disposed —
   *  a disposed instance accepts no further work, full stop. */
  submit(layout: NavTabEntry[]): void {
    if (this.disposed) return;
    this.clearTimeoutFn(this.resetTimer);
    this.pending = layout; // overwrite — only the newest edit is ever worth sending
    if (!this.inFlight) this.dispatchNext();
  }

  private dispatchNext(): void {
    if (this.disposed || this.pending === null) return;
    const layout = this.pending;
    this.pending = null;
    this.lastAttempted = layout;
    this.inFlight = true;
    this.onStatusChange('saving');

    // `save` must behave like an async function (never throw synchronously) for the `.then()`
    // below to be reachable at all — but it isn't assumed to. A synchronous throw is converted
    // into the same rejected-promise path a genuine network failure would take, so it can never
    // leave `inFlight` stuck `true` (which would otherwise wedge this instance forever, silently
    // dropping every future submit()).
    let result: Promise<unknown>;
    try {
      result = this.save(layout);
    } catch (err) {
      result = Promise.reject(err);
    }

    result.then(
      () => {
        this.inFlight = false;
        // An already-dispatched request is allowed to finish normally even after disposal — only
        // its *effects* (further dispatch, a status callback) must never reach whoever disposed
        // this instance's replacement.
        if (this.disposed) return;
        if (this.pending !== null) {
          // A newer edit arrived while this request was in flight — chase it immediately rather
          // than reporting 'saved' for a layout that's already stale.
          this.dispatchNext();
          return;
        }
        this.onStatusChange('saved');
        this.resetTimer = this.setTimeoutFn(() => {
          if (!this.disposed) this.onStatusChange('idle');
        }, this.savedDisplayMs);
      },
      () => {
        this.inFlight = false;
        if (this.disposed) return;
        if (this.pending !== null) {
          // This failure is for a layout the user has already moved past — surfacing it would be
          // both stale and confusing. Drop it silently and go straight to the newer state instead;
          // only a failure with nothing queued behind it is ever shown to the user (see below).
          this.dispatchNext();
          return;
        }
        this.onStatusChange('error');
      }
    );
  }

  /** Re-submits the layout that actually failed. Only meaningful in the error state, where —by
   *  construction — nothing has changed locally since that failure (if it had, dispatchNext would
   *  already have moved on to the newer state instead of reporting an error), so this is always
   *  equivalent to "try saving exactly what's on screen again." No-op if nothing has ever failed,
   *  or once disposed. */
  retry(): void {
    if (this.disposed || !this.lastAttempted) return;
    this.submit(this.lastAttempted);
  }

  /** Permanently retires this instance — call when the authenticated identity it belongs to is no
   *  longer current (sign-out, or switching accounts), not just on component unmount. After this:
   *  - any not-yet-sent layout is discarded immediately (`pending` is cleared) and can never be
   *    dispatched later under a different identity;
   *  - `submit()`/`retry()` become permanent no-ops;
   *  - if a request was already in flight, it's left to finish normally on the wire (nothing
   *    cancels the actual HTTP call, since it was legitimately dispatched under the identity that
   *    was current at the time) — but its resolution/rejection can no longer trigger another
   *    dispatch or emit a status callback, both guarded by the `disposed` check above. */
  dispose(): void {
    this.disposed = true;
    this.pending = null;
    this.clearTimeoutFn(this.resetTimer);
  }
}
