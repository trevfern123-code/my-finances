import type { Session } from '@supabase/supabase-js';
import type { SaveStatus } from './saveStatus';
import type { NavTabEntry } from './navLayout';

const DEFAULT_SAVED_DISPLAY_MS = 2000;

// Same narrower-than-`typeof setTimeout` shape as lib/saveStatus.ts, for the same reason.
type TimeoutHandle = ReturnType<typeof setTimeout>;
type SetTimeoutFn = (callback: () => void, ms: number) => TimeoutHandle;
type ClearTimeoutFn = (handle: TimeoutHandle | undefined) => void;

export interface NavigationWriteCoordinatorOptions {
  save: (layout: NavTabEntry[], verify: (session: Session) => boolean) => Promise<unknown>;
  savedDisplayMs?: number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
}

interface Submission {
  layout: NavTabEntry[];
  sessionId: string;
  verify: (session: Session) => boolean;
}

/**
 * The one Navigation write queue for this running browser tab/JS module realm, shared across every
 * `NavLayoutScope` mount, rather than a fresh instance per mount. This is what closes the
 * cross-lifecycle ordering gap a mount-scoped queue could not: an already-issued write from an
 * *older* authenticated lifecycle can now be guaranteed to settle before a *newer* lifecycle's
 * write is ever sent, because "at most one write in flight" is now a guarantee for the whole tab,
 * not just for whichever scope happens to be currently mounted.
 *
 * App.tsx constructs exactly one instance of this class as a *module-level* constant (evaluated
 * once, the first time that module is loaded into this realm — not inside the `App` component
 * function), and exports it so every `NavLayoutScope` mount, across the entire page's lifetime,
 * attaches to that same instance. A `useRef`-scoped instance living inside `App` would not
 * actually deliver the guarantee below: if `App` itself were ever unmounted and a new `App`
 * instance mounted within the same page (a full top-level remount — not something this app
 * currently does, but not something this class should depend on it never doing either), a fresh
 * `useRef` would construct a second, competing coordinator with no memory of the first's in-flight
 * or queued work. A module-level constant has no such gap: this module is only ever evaluated once
 * per realm, so importing it from anywhere — including a brand-new `App` instance — always yields
 * the identical object.
 *
 * Guarantee, stated precisely: within one running browser tab/JS realm, at most one Navigation
 * write is on the wire at a time, and a newer authenticated lifecycle's save can never be overtaken
 * on the server by an older lifecycle's still-outstanding save. This makes no claim about, and
 * provides no protection against, a different browser tab or a different device — the last write
 * from any such source still simply wins at the database layer, exactly as it already does for
 * every other preference in this app.
 *
 * Each mounted `NavLayoutScope` "attaches" on mount and "detaches" on unmount (see
 * hooks/useNavLayout.ts) rather than constructing/disposing its own instance. Ownership of any
 * individual write is bound *per submission*, not per attachment: `verify` is supplied fresh with
 * every `submit()` call, closing over that submission's own immutable expected user id and
 * expected session id (see App.tsx's NavLayoutScope) — so a write already on the wire keeps
 * whatever ownership it was created with even after a different lifecycle attaches, and a new
 * lifecycle's own writes always carry their own, separate binding. Status is reported only to
 * whichever scope is *currently* attached, and only for a submission that scope itself created —
 * see `report()`.
 */
export class NavigationWriteCoordinator {
  private inFlight = false;
  private pending: Submission | null = null;
  private lastAttempted: Submission | null = null;
  private resetTimer: TimeoutHandle | undefined;
  private attachedSessionId: string | null = null;
  private onStatusChange: ((status: SaveStatus) => void) | null = null;
  private readonly save: (layout: NavTabEntry[], verify: (session: Session) => boolean) => Promise<unknown>;
  private readonly savedDisplayMs: number;
  private readonly setTimeoutFn: SetTimeoutFn;
  private readonly clearTimeoutFn: ClearTimeoutFn;

  constructor(options: NavigationWriteCoordinatorOptions) {
    this.save = options.save;
    this.savedDisplayMs = options.savedDisplayMs ?? DEFAULT_SAVED_DISPLAY_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = options.clearTimeoutFn ?? ((id) => clearTimeout(id));
  }

  /** Called when a NavLayoutScope mounts (or, under StrictMode, re-mounts after the simulated
   *  cleanup — this method is idempotent-safe to call repeatedly with the same sessionId). Clears
   *  any pending, not-yet-sent layout and any retryable failed attempt — both necessarily belonged
   *  to whichever scope was previously attached (Case A: "a new lifecycle discards unsent old
   *  work"; also closes the stale-Retry gap: a freshly attached scope can never retry a previous
   *  scope's failed attempt, because there is nothing left to retry until it makes its own). Does
   *  *not* touch an already-in-flight request — that request was legitimately dispatched under
   *  whichever lifecycle was attached at the time and is left to finish (Case B/C). */
  attach(sessionId: string, onStatusChange: (status: SaveStatus) => void): void {
    this.clearTimeoutFn(this.resetTimer);
    this.attachedSessionId = sessionId;
    this.onStatusChange = onStatusChange;
    this.pending = null;
    this.lastAttempted = null;
  }

  /** Called on unmount. Only clears the attachment if it still belongs to `sessionId` — guards
   *  against an out-of-order cleanup/setup pair wiping out a *newer* scope's attachment. Also
   *  drops this scope's own not-yet-sent `pending` layout and its `lastAttempted` (Retry target):
   *  a scope that's going away can make no more edits, so any queued-but-unsent work it left behind
   *  belongs to a lifecycle that no longer exists client-side — dropped here rather than left to
   *  linger indefinitely if nothing ever attaches again (e.g. a final sign-out), or dispatched onto
   *  the wire under a since-detached scope's binding once some unrelated in-flight request settles.
   *  This can never discard a *subsequent* scope's work: React always fully unmounts an old keyed
   *  instance (running this) before mounting a new one (running attach()), so nothing has had a
   *  chance to submit() under a new sessionId yet at the moment this runs. An already-in-flight
   *  request is untouched either way — it was legitimately dispatched while this scope owned the
   *  attachment and is left to finish per the documented guarantee (Case B/C). */
  detach(sessionId: string): void {
    if (this.attachedSessionId === sessionId) {
      this.attachedSessionId = null;
      this.onStatusChange = null;
      this.pending = null;
      this.lastAttempted = null;
    }
  }

  /** Called on every local edit (toggle/move/reset). A no-op if `sessionId` no longer matches the
   *  currently attached scope (a detached/stale scope can't queue new work). Never blocks; safe to
   *  call as rapidly as the user can click — only the newest submission for the currently attached
   *  scope is ever kept in `pending`. */
  submit(layout: NavTabEntry[], sessionId: string, verify: (session: Session) => boolean): void {
    if (sessionId !== this.attachedSessionId) return;
    this.pending = { layout, sessionId, verify };
    if (!this.inFlight) this.dispatchNext();
  }

  /** Reports a status transition only to the scope that actually owns `sessionId` — never into
   *  whichever scope happens to be attached *now* if it isn't the one this outcome belongs to. This
   *  is the same "immutable expected owner" principle already applied to network ownership (see
   *  `verify`), now also applied to status reporting, so a stale attempt's completion — success,
   *  failure, or the eventual idle-reset — can never be misread as "your recent change" by a
   *  different, currently-attached scope that never made that change. */
  private report(sessionId: string, status: SaveStatus): void {
    if (sessionId === this.attachedSessionId) this.onStatusChange?.(status);
  }

  private dispatchNext(): void {
    if (this.pending === null) return;
    // Cancel any Saved -> Idle timer still pending from an *earlier* attempt in this same
    // attachment before starting a new one. Without this, a second save beginning (and possibly
    // failing) before the first save's 2-second idle-reset fires would let that stale timer flip
    // status back to 'idle' later — silently erasing a genuine 'error' (or a since-changed 'saved')
    // that has nothing to do with the attempt the timer was originally scheduled for. attach()
    // already clears this across a scope change; this closes the gap for a second attempt within
    // the *same* still-attached scope, which attach() alone never runs for.
    this.clearTimeoutFn(this.resetTimer);
    this.resetTimer = undefined;
    const submission = this.pending;
    this.pending = null;
    this.lastAttempted = submission;
    this.inFlight = true;
    this.report(submission.sessionId, 'saving');

    // `save` must behave like an async function (never throw synchronously) for the `.then()`
    // below to be reachable at all — but it isn't assumed to. A synchronous throw is converted
    // into the same rejected-promise path a genuine network failure would take, so it can never
    // leave `inFlight` stuck `true`, which would otherwise wedge the coordinator for the rest of
    // the tab's lifetime, not just for one scope.
    let result: Promise<unknown>;
    try {
      result = this.save(submission.layout, submission.verify);
    } catch (err) {
      result = Promise.reject(err);
    }

    result.then(
      () => {
        this.inFlight = false;
        if (this.pending !== null) {
          // A newer submission arrived while this one was in flight — whether from the same scope
          // or a different one that has since attached — chase it immediately rather than
          // reporting 'saved' for a layout that's already stale. Cases B/C converge here: an
          // already-issued write from an older lifecycle finishing normally, with a newer
          // lifecycle's write already queued behind it.
          this.dispatchNext();
          return;
        }
        this.report(submission.sessionId, 'saved');
        this.resetTimer = this.setTimeoutFn(() => this.report(submission.sessionId, 'idle'), this.savedDisplayMs);
      },
      () => {
        this.inFlight = false;
        if (this.pending !== null) {
          // This failure — whether a genuine network failure or an ownership-verification
          // rejection (Case C: the returned session's own session_id no longer matches what this
          // submission expected) — is for a layout the user (or scope) has already moved past.
          // Drop it silently and go straight to the newer state instead.
          this.dispatchNext();
          return;
        }
        this.report(submission.sessionId, 'error');
      }
    );
  }

  /** Re-submits the layout that actually failed — but only for the scope that owns it. A no-op if
   *  nothing has failed, or if `sessionId` doesn't match both the currently attached scope *and*
   *  the failed attempt's own scope (the second check is structurally redundant given `attach()`
   *  already clears `lastAttempted` on every transition, but kept as cheap, independent
   *  defense-in-depth against a stale Retry, consistent with keeping the ambient session check in
   *  `verify` alongside the direct token comparison). */
  retry(sessionId: string): void {
    if (!this.lastAttempted) return;
    if (sessionId !== this.attachedSessionId) return;
    if (this.lastAttempted.sessionId !== this.attachedSessionId) return;
    this.submit(this.lastAttempted.layout, sessionId, this.lastAttempted.verify);
  }
}
