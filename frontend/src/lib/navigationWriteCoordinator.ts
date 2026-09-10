import type { Session } from '@supabase/supabase-js';
import type { SaveStatus } from './saveStatus';
import type { NavTabEntry } from './navLayout';

const DEFAULT_SAVED_DISPLAY_MS = 2000;

// Same narrower-than-`typeof setTimeout` shape as lib/saveStatus.ts, for the same reason.
type TimeoutHandle = ReturnType<typeof setTimeout>;
type SetTimeoutFn = (callback: () => void, ms: number) => TimeoutHandle;
type ClearTimeoutFn = (handle: TimeoutHandle | undefined) => void;

/**
 * Identifies one UI *attachment* — one mounted `NavLayoutScope`'s lifetime between its own
 * `attach()` and `detach()` calls — as distinct from `sessionId`, which identifies the
 * *authenticated login lifecycle* it happens to be attached under. These are not the same thing:
 * a full `NavLayoutScope` remount can happen while the very same Supabase session stays active
 * (e.g. a full top-level `App` remount, or — see the class doc comment — nothing about this class
 * assumes App itself never remounts), producing two distinct attachments that share one identical
 * `sessionId`. Opaque outside this module; callers only ever pass back exactly what `attach()`
 * returned them.
 */
export type AttachmentId = number;

export interface NavigationWriteCoordinatorOptions {
  save: (layout: NavTabEntry[], verify: (session: Session) => boolean) => Promise<unknown>;
  savedDisplayMs?: number;
  setTimeoutFn?: SetTimeoutFn;
  clearTimeoutFn?: ClearTimeoutFn;
}

interface Submission {
  layout: NavTabEntry[];
  sessionId: string;
  attachmentId: AttachmentId;
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
 * Two distinct identities are in play, and it matters which one governs which decision:
 *
 * - `sessionId` (Supabase's own authenticated-login-lifecycle identity — see lib/authGeneration.ts)
 *   governs *network* ownership: `verify` (supplied fresh per submission, closing over the
 *   submission's own immutable expected user id and session id) decides whether a write is actually
 *   allowed to reach the server at all, and this is checked against the session Supabase actually
 *   returns at send time — never against `sessionId` alone.
 * - `attachmentId` (this module's own opaque counter, bumped on every `attach()` call) governs *UI*
 *   ownership: which mounted `NavLayoutScope` a status transition (saving/saved/error/idle) or a
 *   Retry actually belongs to. `sessionId` is not enough for this on its own — a full
 *   `NavLayoutScope` remount can happen while the very same session stays active (its `sessionId`
 *   is unchanged), producing two distinct attachments that would otherwise be indistinguishable to
 *   `report()`/`detach()`/`retry()`, letting an old attachment's already-in-flight write report its
 *   eventual `saved`/`error` into whatever *new* attachment happens to share that same `sessionId`.
 *   `attachmentId` closes that gap: every `attach()` call gets a brand-new id, even when `sessionId`
 *   is identical to the previous attachment's.
 *
 * An already-issued write's *network* behavior never changes because its owning attachment
 * detached — see `dispatchNext()` — only where its eventual status is allowed to be *reported* (see
 * `report()`) is scoped by attachment.
 */
export class NavigationWriteCoordinator {
  private inFlight = false;
  private pending: Submission | null = null;
  private lastAttempted: Submission | null = null;
  private resetTimer: TimeoutHandle | undefined;
  private attachedSessionId: string | null = null;
  private attachedAttachmentId: AttachmentId | null = null;
  private nextAttachmentId: AttachmentId = 1;
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
   *  cleanup). Always issues a brand-new `AttachmentId` — even when `sessionId` is identical to
   *  whatever was attached immediately before — and the caller must hold onto it for the lifetime
   *  of this exact mount, passing it back to every other method (`detach`/`submit`/`retry`).
   *  Clears any pending, not-yet-sent layout, any retryable failed attempt, and any outstanding
   *  Saved -> Idle timer — all three necessarily belonged to whichever attachment was previously
   *  current (Case A: "a new attachment discards unsent old work"; also closes the stale-Retry gap:
   *  a freshly attached scope can never retry a previous attachment's failed attempt, because there
   *  is nothing left to retry until it makes its own). Does *not* touch an already-in-flight
   *  request — that request was legitimately dispatched while the previous attachment was current
   *  and is left to finish (Case B/C); only where its eventual status gets reported changes. */
  attach(sessionId: string, onStatusChange: (status: SaveStatus) => void): AttachmentId {
    this.clearTimeoutFn(this.resetTimer);
    this.resetTimer = undefined;
    const attachmentId = this.nextAttachmentId++;
    this.attachedSessionId = sessionId;
    this.attachedAttachmentId = attachmentId;
    this.onStatusChange = onStatusChange;
    this.pending = null;
    this.lastAttempted = null;
    return attachmentId;
  }

  /** Called on unmount. Only clears the attachment if *both* `sessionId` and `attachmentId` still
   *  match the currently attached one — `sessionId` alone is not enough to guard against a stale
   *  cleanup wiping out a newer attachment's state, because a full remount under the very same
   *  session produces two attachments sharing one identical `sessionId`; only `attachmentId`
   *  actually distinguishes them. This is what makes a delayed/stale StrictMode cleanup (bound to
   *  an already-superseded attachment id) structurally unable to detach a newer setup's attachment,
   *  even one using the same session. Also drops this attachment's own not-yet-sent `pending`
   *  layout, its `lastAttempted` (Retry target), and cancels its own outstanding Saved -> Idle
   *  timer if one is running: an attachment that's going away can make no more edits and show no
   *  more status, so any of its own queued-but-unsent work, retryable failure, or pending idle-
   *  reset belongs to a UI instance that no longer exists — dropped here rather than left to linger
   *  indefinitely if nothing ever attaches again (e.g. a final sign-out), or fire into whatever
   *  *different* attachment happens to be current by the time it would have. This can never discard
   *  a *subsequent* attachment's work: React always fully unmounts an old instance (running this)
   *  before mounting a new one (running attach()), so nothing has had a chance to submit() under a
   *  new attachment yet at the moment this runs. An already-in-flight request is untouched either
   *  way — it was legitimately dispatched while this attachment was current and is left to finish
   *  per the documented guarantee (Case B/C); only its eventual status report is now permanently
   *  unreachable, since nothing will ever match this attachment's id again. */
  detach(sessionId: string, attachmentId: AttachmentId): void {
    if (this.attachedSessionId === sessionId && this.attachedAttachmentId === attachmentId) {
      this.attachedSessionId = null;
      this.attachedAttachmentId = null;
      this.onStatusChange = null;
      this.pending = null;
      this.lastAttempted = null;
      this.clearTimeoutFn(this.resetTimer);
      this.resetTimer = undefined;
    }
  }

  /** Called on every local edit (toggle/move/reset). A no-op if `sessionId`/`attachmentId` no
   *  longer match the currently attached scope (a detached/stale scope can't queue new work).
   *  Never blocks; safe to call as rapidly as the user can click — only the newest submission for
   *  the currently attached scope is ever kept in `pending`. */
  submit(layout: NavTabEntry[], sessionId: string, attachmentId: AttachmentId, verify: (session: Session) => boolean): void {
    if (sessionId !== this.attachedSessionId || attachmentId !== this.attachedAttachmentId) return;
    this.pending = { layout, sessionId, attachmentId, verify };
    if (!this.inFlight) this.dispatchNext();
  }

  /** Reports a status transition only to the attachment that actually owns it — checking
   *  `attachmentId`, not merely `sessionId`, is the whole point: two attachments can share one
   *  identical `sessionId` (a full remount under the same still-active session), and without the
   *  attachment check an old, already-detached attachment's stale completion could report `saved`
   *  or `error` straight into a brand-new attachment that never made that change, including — the
   *  specific failure mode this exists to close — an `error` whose Retry is silently nonfunctional
   *  because the new attachment (correctly) already cleared the old attempt's `lastAttempted`. */
  private report(sessionId: string, attachmentId: AttachmentId, status: SaveStatus): void {
    if (sessionId === this.attachedSessionId && attachmentId === this.attachedAttachmentId) {
      this.onStatusChange?.(status);
    }
  }

  private dispatchNext(): void {
    if (this.pending === null) return;
    // Cancel any Saved -> Idle timer still pending from an *earlier* attempt before starting a new
    // one — regardless of whether that earlier attempt belonged to this same attachment or an
    // already-detached one. Without this, a second save beginning (and possibly failing) before an
    // earlier save's 2-second idle-reset fires would let that stale timer flip status back to
    // 'idle' later — silently erasing a genuine 'error' (or a since-changed 'saved') that has
    // nothing to do with the attempt the timer was originally scheduled for. attach()/detach()
    // already clear this across an attachment change; this closes the gap for a second attempt
    // within the *same* still-attached attachment, which neither of those runs for.
    this.clearTimeoutFn(this.resetTimer);
    this.resetTimer = undefined;
    const submission = this.pending;
    this.pending = null;
    this.lastAttempted = submission;
    this.inFlight = true;
    this.report(submission.sessionId, submission.attachmentId, 'saving');

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
          // A newer submission arrived while this one was in flight — whether from the same
          // attachment or a different one that has since attached — chase it immediately rather
          // than reporting 'saved' for a layout that's already stale. Cases B/C converge here: an
          // already-issued write from an older attachment finishing normally, with a newer
          // attachment's write already queued behind it. Network behavior is unaffected by
          // attachment identity — only whether *this* submission's own status gets reported is.
          this.dispatchNext();
          return;
        }
        this.report(submission.sessionId, submission.attachmentId, 'saved');
        this.resetTimer = this.setTimeoutFn(() => {
          this.resetTimer = undefined;
          this.report(submission.sessionId, submission.attachmentId, 'idle');
        }, this.savedDisplayMs);
      },
      () => {
        this.inFlight = false;
        if (this.pending !== null) {
          // This failure — whether a genuine network failure or an ownership-verification
          // rejection (Case C: the returned session's own session_id no longer matches what this
          // submission expected) — is for a layout the user (or attachment) has already moved past.
          // Drop it silently and go straight to the newer state instead.
          this.dispatchNext();
          return;
        }
        this.report(submission.sessionId, submission.attachmentId, 'error');
      }
    );
  }

  /** Re-submits the layout that actually failed — but only for the attachment that owns it. A
   *  no-op if nothing has failed, or if `sessionId`/`attachmentId` doesn't match both the currently
   *  attached scope *and* the failed attempt's own attachment (the second check is structurally
   *  redundant given `attach()` already clears `lastAttempted` on every transition, but kept as
   *  cheap, independent defense-in-depth against a stale Retry, consistent with keeping the ambient
   *  session check in `verify` alongside the direct token comparison). Requiring `attachmentId`
   *  here — not just `sessionId` — is what makes a Retry from one attachment structurally unable to
   *  ever execute a different attachment's failed layout, even when both share one session. */
  retry(sessionId: string, attachmentId: AttachmentId): void {
    if (!this.lastAttempted) return;
    if (sessionId !== this.attachedSessionId || attachmentId !== this.attachedAttachmentId) return;
    if (
      this.lastAttempted.sessionId !== this.attachedSessionId ||
      this.lastAttempted.attachmentId !== this.attachedAttachmentId
    )
      return;
    this.submit(this.lastAttempted.layout, sessionId, attachmentId, this.lastAttempted.verify);
  }
}
