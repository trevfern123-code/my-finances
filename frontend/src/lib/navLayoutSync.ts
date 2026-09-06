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
 */
export class NavLayoutSync {
  private inFlight = false;
  private pending: NavTabEntry[] | null = null;
  private lastAttempted: NavTabEntry[] | null = null;
  private resetTimer: TimeoutHandle | undefined;
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
   *  kicks off sending it. Safe to call as rapidly as the user can click. */
  submit(layout: NavTabEntry[]): void {
    this.clearTimeoutFn(this.resetTimer);
    this.pending = layout; // overwrite — only the newest edit is ever worth sending
    if (!this.inFlight) this.dispatchNext();
  }

  private dispatchNext(): void {
    if (this.pending === null) return;
    const layout = this.pending;
    this.pending = null;
    this.lastAttempted = layout;
    this.inFlight = true;
    this.onStatusChange('saving');
    this.save(layout).then(
      () => {
        this.inFlight = false;
        if (this.pending !== null) {
          // A newer edit arrived while this request was in flight — chase it immediately rather
          // than reporting 'saved' for a layout that's already stale.
          this.dispatchNext();
          return;
        }
        this.onStatusChange('saved');
        this.resetTimer = this.setTimeoutFn(() => this.onStatusChange('idle'), this.savedDisplayMs);
      },
      () => {
        this.inFlight = false;
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
   *  equivalent to "try saving exactly what's on screen again." No-op if nothing has ever failed. */
  retry(): void {
    if (this.lastAttempted) this.submit(this.lastAttempted);
  }

  /** Releases the pending idle-reset timer, if any — call on unmount. */
  dispose(): void {
    this.clearTimeoutFn(this.resetTimer);
  }
}
