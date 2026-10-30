import { useCallback, useEffect, useRef, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { RecoveryActionInput, RecoveryActionRequest } from '../lib/api';
import {
  isInFlight,
  markInFlight,
  notePendingOperation,
  readPendingOperation,
  recordPendingOperation,
  resolvePendingOperation,
  subscribePendingOperations,
  type PendingRecoveryOperation,
  type PendingWrite,
} from '../lib/cardPaymentRecoveryPending';
import { decodeSessionId } from '../lib/jwt';
import type { RecoveryCandidate, RecoveryFreshness, RecoveryReview, RecoveryReviewsResponse } from '../lib/semanticModel';
import {
  acceptedDifferenceText,
  paymentsUnderReviewNote,
  recoveryFailureText,
  REVIEW_ACTION_HELP,
  reviewCandidateText,
  reviewDecisionText,
  reviewObligationText,
  reviewReadingText,
  reviewSourceText,
  reviewTitle,
} from '../lib/semanticPresentation';

/**
 * Payment review after a bank connection was removed (I3A-R packet 2-A; PHASE_B_I3A_R_PACKET_2A_REVIEW.md §9).
 *
 * WHAT IT SHOWS. For each payment under review: what it counts as now (a range stays a range), why it is under
 * review (which removal, what that removal depended on, and what is not known), the transactions the bank data
 * offers as its other side — as SUGGESTIONS, never as facts — and what the user can do about THIS payment.
 *
 * WHAT IT NEVER DOES. It offers nothing that ends the record of a removal, no "mark as reviewed", and no way to
 * let a future transaction through. It shows no figure that is not current: while the figures are not up to date
 * it says so, and offers the one thing that is always available: asking for them to be refreshed. Of a refresh
 * that is queued it says exactly that — "A refresh is queued. The figures are not up to date." A queue row does
 * not say that anything is running it, that nothing has tried it yet, or that it will finish, so none of that is
 * said.
 * A response this build cannot read is shown as "update the app", never as a figure and never as zero.
 *
 * ONE REQUEST PER ACTION. A click makes one operation id and sends one request. If the answer never arrives,
 * NOTHING is assumed: the review says the outcome is not known and asks the server about that same operation id
 * before anything else can be done. Sending it again uses the same id and the same request, so it cannot act
 * twice. FINDING NO RECEIPT DECIDES NOTHING: the first request may still be completing. Only a receipt, or the
 * server's own answer to that operation, ends the unknown state.
 *
 * AN UNRESOLVED CHANGE OUTLIVES THIS COMPONENT. Its operation id and its exact request are recorded in the
 * browser BEFORE the request is sent, under the signed-in user (lib/cardPaymentRecoveryPending.ts), and removed
 * only when the server has answered that operation. Closing this review, opening it from the other entry,
 * leaving the screen, a reload, an app update or a new login of the same user brings the same operation back,
 * and no other change can be started from here until it is answered. Another user's record is never read. If the
 * browser cannot keep the record, the change is not sent.
 *
 * WHO. The owner of every request is the signed-in user the SERVER sees. This component additionally remembers
 * which login it was opened under, and refuses to send a change under any other (the same rule every change in
 * the app follows; see lib/sessionOwnership.ts) — a review opened by one person is never acted on as another.
 */

/**
 * The API module, loaded when a review is first read or acted on — not when this file is imported. The two
 * screens that offer the entry (Transactions, the Effects Drilldown) are imported by many screens and tests that
 * never open a review; they must not pull in the API client (and, with it, the Supabase client) just by
 * importing this component.
 */
let apiModule: Promise<typeof import('../lib/api')> | null = null;
const api = (): Promise<typeof import('../lib/api')> => {
  // One load, shared by everything that asks at the same moment; a failed load is not remembered.
  apiModule ??= import('../lib/api').catch((err) => {
    apiModule = null;
    throw err;
  });
  return apiModule;
};
/** The server's code for a request whose outcome is not known (mirrors RECOVERY_OUTCOME_UNKNOWN in lib/api.ts). */
const OUTCOME_UNKNOWN = 'outcome_unknown';

type Loaded = Extract<RecoveryReviewsResponse, { kind: 'ok' }>;

export type RecoveryReviewsState =
  | { phase: 'loading' }
  /** No usable answer. `unreadable`: the answer was not in a shape this build knows. */
  | { phase: 'unavailable'; unreadable: boolean }
  | { phase: 'ready'; data: Loaded; reviews: RecoveryReview[]; loadingMore: boolean };

/**
 * The payments under review, loaded once and reloadable. A response that arrives after a newer request was
 * started is dropped: what is on screen always belongs to the latest request. Never throws.
 */
export function useRecoveryReviews(enabled = true): { state: RecoveryReviewsState; reload: () => void; loadMore: () => void } {
  const [state, setState] = useState<RecoveryReviewsState>({ phase: 'loading' });
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    generation.current += 1;
    const mine = generation.current;
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    setState({ phase: 'loading' });
    (async () => {
      try {
        const response = await (await api()).getRecoveryReviews({ cursor: null }, abort.signal);
        if (generation.current !== mine) return;
        setState(response.kind === 'ok' ? { phase: 'ready', data: response, reviews: response.reviews, loadingMore: false } : { phase: 'unavailable', unreadable: true });
      } catch {
        if (generation.current !== mine) return;
        setState({ phase: 'unavailable', unreadable: false });
      }
    })();
  }, []);

  const loadMore = useCallback(() => {
    const mine = generation.current;
    setState((current) => {
      if (current.phase !== 'ready' || current.loadingMore || current.data.next_cursor === null) return current;
      const cursor = current.data.next_cursor;
      (async () => {
        try {
          const response = await (await api()).getRecoveryReviews({ cursor }, controller.current?.signal);
          if (generation.current !== mine) return;
          // A later page must describe the same list: the same versions. Otherwise start again.
          setState((latest) => {
            if (latest.phase !== 'ready') return latest;
            if (response.kind !== 'ok' || !response.fresh || response.freshness.input_version !== latest.data.freshness.input_version || response.freshness.review_revision !== latest.data.freshness.review_revision) {
              reload();
              return latest;
            }
            return { phase: 'ready', data: { ...latest.data, next_cursor: response.next_cursor }, reviews: [...latest.reviews, ...response.reviews], loadingMore: false };
          });
        } catch {
          if (generation.current !== mine) return;
          setState((latest) => (latest.phase === 'ready' ? { ...latest, loadingMore: false } : latest));
        }
      })();
      return { ...current, loadingMore: true };
    });
  }, [reload]);

  useEffect(() => {
    if (!enabled) return undefined;
    reload();
    return () => {
      generation.current += 1;
      controller.current?.abort();
    };
  }, [enabled, reload]);

  return { state, reload, loadMore };
}

/** What a row needs to offer its review: is this transaction under review, and how many are there in all. */
export function reviewIndex(state: RecoveryReviewsState): { ids: Set<string>; count: number } {
  if (state.phase !== 'ready') return { ids: new Set(), count: 0 };
  return { ids: new Set(state.reviews.map((r) => r.transaction_id)), count: state.data.affected_payment_count };
}

/**
 * The label of the entry into the review, or null when there is nothing to enter. A change of this user whose
 * outcome is not known is always something to enter — also when no review is listed, and when the list cannot
 * be read at all: the entry is how that change is checked.
 */
export function reviewEntryLabel(state: RecoveryReviewsState, pending: 'none' | 'pending' = 'none'): string | null {
  const reviews = state.phase !== 'ready' || state.data.affected_payment_count === 0 ? null : paymentsUnderReviewNote(state.data.affected_payment_count);
  if (pending === 'none') return reviews;
  return reviews === null ? '1 change to check' : `${reviews} · 1 change to check`;
}

/**
 * Whether the signed-in user has a change from the review whose outcome is not known (or a record of one that
 * this version cannot read). For the two entries: they must lead to it. Reads only that user's record, follows
 * it as it changes, sends nothing, and never throws.
 */
export function usePendingRecoveryEntry(enabled = true): 'none' | 'pending' {
  const [value, setValue] = useState<'none' | 'pending'>('none');
  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;
    let ownerUserId: string | null = null;
    const sync = () => {
      if (!live || ownerUserId === null) return;
      const read = readPendingOperation(ownerUserId);
      setValue(read.kind === 'pending' || (read.kind === 'unusable' && read.reason === 'unreadable_record') ? 'pending' : 'none');
    };
    const unsubscribe = subscribePendingOperations(sync);
    api()
      .then((module) => module.getCurrentSessionOwner())
      .then((current) => {
        if (!live || !current) return;
        ownerUserId = current.userId;
        sync();
      })
      .catch(() => undefined);
    return () => {
      live = false;
      unsubscribe();
    };
  }, [enabled]);
  return value;
}

interface Owner {
  userId: string;
  sessionId: string | null;
}

/**
 * An operation the user started. It stays here — with its operation id and its exact request — until its
 * outcome is KNOWN. There are only two ways to know: a receipt is found, or the server answers THIS operation.
 * "No receipt is visible" is neither: the original request's transaction may still be open (it commits its
 * receipt with the decision), or the request may not have arrived yet. So there is no "not saved" state here,
 * and no way to drop the operation and start another.
 */
type Operation =
  // `request`: the exact request of a change (recorded in the browser), or null for a refresh request (not recorded:
  // it changes no payment and may always be asked again).
  | { status: 'sending'; operationId: string; label: string; request: RecoveryActionRequest | null }
  | {
      status: 'unknown';
      operationId: string;
      label: string;
      request: RecoveryActionRequest | null;
      busy: 'checking' | 'resending' | null;
      /** What the last attempt to find out said. None of these is an outcome. */
      last: 'none' | 'no_record' | 'unreachable' | 'try_again';
    };

const errorCode = (err: unknown): string | null => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
};
const errorStatus = (err: unknown): number | null => {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' ? status : null;
};
/** Codes that mean "the server did not take this request at all" — the outcome is known: nothing happened. */
const NOT_SENT_CODES = new Set(['session_owner_mismatch', 'session_owner_required', 'client_update_required']);
/** The login changed: nothing more is asked or sent under the new one. */
const OWNER_CHANGED_CODES = new Set(['session_owner_mismatch', 'session_owner_required']);
/**
 * Refusals that say nothing about an EARLIER copy of the same operation: the server could not decide just now
 * (retry), or did not run the request at all (changes switched off, an outdated app). When the same operation
 * is sent again and gets one of these, its outcome is still unknown.
 * Every other coded refusal of a resent operation IS an outcome. The server looks for the operation's receipt
 * first, under the user's lock; finding none, it judged this exact intent at the versions the user saw and
 * refused it. An earlier copy that is still on its way carries the same intent and the same versions: versions
 * only advance, so it will be refused too.
 */
const UNDECIDED_REFUSALS = new Set(['retry', 'recovery_actions_disabled', 'client_update_required', 'recovery_unavailable', 'invalid_request']);

const newOperationId = (): string => globalThis.crypto.randomUUID();

const UNREADABLE_RECORD_TEXT =
  "A change sent earlier from this browser is recorded in a form this version of the app can't read. It may not have been answered yet, so nothing new can be sent from this screen. Reload the app to update it.";
/** Why a change was NOT sent: it could not be recorded first. */
function notRecordedText(reason: Exclude<PendingWrite, { ok: true }>['reason']): string {
  if (reason === 'another_operation_pending') return 'An earlier change is still waiting to be checked, so this one was not sent. Nothing was saved.';
  if (reason === 'unreadable_record') return UNREADABLE_RECORD_TEXT;
  // No exclusive turn at the record could be had (no Web Locks in this browser, or it did not come): the change
  // is not sent, because another tab's unresolved change could otherwise be overwritten unseen.
  if (reason === 'coordination_unavailable')
    return "This browser couldn't make sure that another open tab of the app isn't sending a change at the same moment, so this one was not sent. Nothing was saved. Try again; if it keeps happening, update your browser.";
  return "This browser couldn't keep a record of that change, so it was not sent. Nothing was saved. Check that this site is allowed to store data, then try again.";
}
/**
 * The change WAS answered, and its record could not be removed (no turn at it, or the browser refused): the record
 * is left as it is, and the change stays listed until a check or a resend of the same operation clears it.
 */
const RECORD_NOT_UPDATED_TEXT =
  "This change was answered, but this browser couldn't update its own record of it just now, so it is still listed as waiting. Check it again in a moment.";

export function CardPaymentRecoveryReview({
  focusTransactionId,
  describeTransaction,
  onChanged,
}: {
  /** The payment the user came from: shown first and opened. */
  focusTransactionId?: string | null;
  /** A name for a transaction the caller already shows (the feed has it; the review itself carries none). */
  describeTransaction?: (transactionId: string) => string | null;
  /** Called after something was saved, so the caller can reload the figures it shows. */
  onChanged?: () => void;
}) {
  const { state, reload, loadMore } = useRecoveryReviews();
  const [owner, setOwner] = useState<Owner | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [message, setMessage] = useState<{ tone: 'status' | 'alert'; text: string } | null>(null);
  const [openId, setOpenId] = useState<string | null>(focusTransactionId ?? null);
  const [confirmDifference, setConfirmDifference] = useState<string | null>(null);
  const mounted = useRef(true);
  /** This user's record cannot be read: nothing new may be sent (see lib/cardPaymentRecoveryPending.ts). */
  const [unreadableRecord, setUnreadableRecord] = useState(false);
  // What this instance shows now, and which operation it is itself sending or has itself just resolved — so that
  // a change of the record made by THIS instance is not mistaken for one made elsewhere.
  const shown = useRef<Operation | null>(null);
  shown.current = operation;
  const ownSend = useRef<string | null>(null);
  const ownResolve = useRef<string | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  /** Shows an operation (or none) and remembers it at once: code that runs before the next render sees it. */
  const display = useCallback((next: Operation | null) => {
    shown.current = next;
    setOperation(next);
  }, []);
  /**
   * Whether this screen shows nothing pending, or exactly this operation. ONLY THEN may an answer for that
   * operation change what is shown: once another operation is pending here (recorded in another tab after this
   * one was resolved there), a late answer for the first can neither clear it, replace it nor be said of it.
   */
  const showsNoOther = useCallback((operationId: string) => shown.current === null || shown.current.operationId === operationId, []);
  /**
   * Shows what THIS user's record says now, whatever this instance believed a moment ago. Used when a change of
   * the record by this instance was refused, or found another operation in its place: the record, not an old
   * answer, decides what is pending on this screen. (Set by the effect below; it needs the owner.)
   */
  const adoptRecord = useRef<(whenNothingIsRecorded: 'reload' | 'keep') => void>(() => undefined);

  useEffect(() => {
    mounted.current = true;
    // The login this review was opened under. A change is sent only under that same login.
    api()
      .then((module) => module.getCurrentSessionOwner())
      .then((current) => {
        if (mounted.current && current) setOwner(current);
      })
      .catch(() => undefined);
    return () => {
      mounted.current = false;
    };
  }, []);

  // THE RECORD OF AN UNRESOLVED CHANGE of the signed-in user is read as soon as that user is known — before any
  // action can be started (actions wait for the owner) — and followed from then on. It brings back an operation
  // this component did not send: one sent before the review was closed, before a reload, before a new login.
  // Only this user's record is read; someone else's stays where it is.
  const ownerUserId = owner?.userId ?? null;
  useEffect(() => {
    if (ownerUserId === null) return undefined;
    const showRecorded = (recorded: PendingRecoveryOperation) => {
      const next: Operation =
        recorded.status === 'sending' && isInFlight(ownerUserId, recorded.operationId)
          ? { status: 'sending', operationId: recorded.operationId, label: recorded.label, request: recorded.request }
          : { status: 'unknown', operationId: recorded.operationId, label: recorded.label, request: recorded.request, busy: null, last: recorded.last };
      shown.current = next;
      setOperation(next);
    };
    const sync = () => {
      if (!mounted.current) return;
      const read = readPendingOperation(ownerUserId);
      setUnreadableRecord(read.kind === 'unusable' && read.reason === 'unreadable_record');
      const current = shown.current;
      if (read.kind === 'pending') {
        const recorded = read.operation;
        // This instance is sending it, checking it or re-sending it right now: what it shows is the newer state.
        if (ownSend.current === recorded.operationId) return;
        if (current !== null && current.operationId === recorded.operationId && current.status === 'unknown' && current.busy !== null) return;
        showRecorded(recorded);
        return;
      }
      // No record. A change this review still shows was answered for another review (the one that sent it and was
      // closed since): it is over here too, and what is on screen is reloaded.
      if (read.kind === 'none' && current !== null && current.request !== null && ownResolve.current !== current.operationId && ownSend.current !== current.operationId) {
        shown.current = null;
        setOperation(null);
        setConfirmDifference(null);
        reload();
        onChangedRef.current?.();
      }
    };
    adoptRecord.current = (whenNothingIsRecorded) => {
      if (!mounted.current) return;
      const read = readPendingOperation(ownerUserId);
      setUnreadableRecord(read.kind === 'unusable' && read.reason === 'unreadable_record');
      if (read.kind === 'pending') {
        showRecorded(read.operation);
        return;
      }
      shown.current = null;
      setOperation(null);
      setConfirmDifference(null);
      if (whenNothingIsRecorded === 'reload') {
        reload();
        onChangedRef.current?.();
      }
    };
    sync();
    const unsubscribe = subscribePendingOperations(sync);
    return () => {
      adoptRecord.current = () => undefined;
      unsubscribe();
    };
  }, [ownerUserId, reload]);

  const verifyOwnership = useCallback(
    (session: Session) => owner !== null && owner.sessionId !== null && session.user.id === owner.userId && decodeSessionId(session.access_token) === owner.sessionId,
    [owner]
  );

  const settleScreen = useCallback(
    (text: string, tone: 'status' | 'alert', changed: boolean) => {
      if (!mounted.current) return;
      display(null);
      setConfirmDifference(null);
      setMessage({ tone, text });
      reload();
      if (changed) onChanged?.();
    },
    [reload, onChanged, display]
  );

  /**
   * The login changed while an outcome was unknown: nothing is asked or sent under the new login, and nothing is
   * claimed. The record of the operation is NOT touched: it is its own user's, and is there when that user is back.
   */
  const ownerChanged = useCallback(() => {
    if (!mounted.current) return;
    display(null);
    setConfirmDifference(null);
    setMessage({ tone: 'alert', text: "You signed in again since this was sent, so its outcome can't be checked from here. Reload the review to see what is saved." });
    reload();
  }, [reload, display]);

  /**
   * NO USABLE ANSWER for operation X. Its record is noted — under the user's journal lock, and only if the record
   * still IS X — and X is shown as unknown, but only if this screen still shows X (or nothing).
   * If the record is no longer X's (X was resolved in another tab; another operation may be recorded since), this
   * late result says nothing about what is recorded now: the screen shows what the record says.
   * If the record could not be noted at all (no turn at it), it is still X's, unchanged: X is shown as unknown.
   */
  const stillUnknownOperation = useCallback(
    async (recordedFor: string | null, pending: { operationId: string; label: string; request: RecoveryActionRequest | null }, last: 'none' | 'no_record' | 'unreachable' | 'try_again') => {
      if (recordedFor !== null) {
        const noted = await notePendingOperation(recordedFor, pending.operationId, 'unknown', last);
        if (!noted.ok && noted.reason === 'not_this_operation') {
          adoptRecord.current('reload');
          return;
        }
      }
      if (mounted.current && showsNoOther(pending.operationId)) display({ status: 'unknown', operationId: pending.operationId, label: pending.label, request: pending.request, busy: null, last });
    },
    [display, showsNoOther]
  );

  /**
   * THE SERVER ANSWERED operation X (or its request never left). Its record is removed — under the user's journal
   * lock, and only if the record still IS X — and then the screen settles, but only if it still shows X (or
   * nothing):
   *   - the record is ANOTHER operation's now (X was resolved in another tab and Y recorded): Y is what is pending
   *     here. X's answer removes nothing, clears nothing and is not shown beside Y; only the figures are reloaded;
   *   - the record is X's and could NOT be removed (no turn at it, or the browser refused): it is kept, X stays
   *     listed, and the screen says so. A check or a resend of the same operation clears it later.
   */
  const settleOperation = useCallback(
    async (recordedFor: string | null, pending: { operationId: string; label: string; request: RecoveryActionRequest | null }, text: string, tone: 'status' | 'alert', changed: boolean) => {
      if (recordedFor !== null) {
        ownResolve.current = pending.operationId;
        const resolved = await resolvePendingOperation(recordedFor, pending.operationId);
        if (!resolved.ok) {
          if (ownResolve.current === pending.operationId) ownResolve.current = null;
          if (resolved.reason !== 'not_this_operation') {
            if (mounted.current && showsNoOther(pending.operationId)) {
              display({ status: 'unknown', operationId: pending.operationId, label: pending.label, request: pending.request, busy: null, last: 'none' });
              setConfirmDifference(null);
              setMessage({ tone: 'alert', text: RECORD_NOT_UPDATED_TEXT });
              reload();
              if (changed) onChanged?.();
            }
            return;
          }
          if (readPendingOperation(recordedFor).kind !== 'none') {
            adoptRecord.current('keep');
            if (mounted.current) {
              reload();
              if (changed) onChanged?.();
            }
            return;
          }
        }
      }
      if (mounted.current && !showsNoOther(pending.operationId)) {
        reload();
        if (changed) onChanged?.();
        return;
      }
      settleScreen(text, tone, changed);
    },
    [settleScreen, display, showsNoOther, reload, onChanged]
  );

  /**
   * Sends one request and sorts what came back into: saved, refused (nothing saved), or NOT KNOWN.
   * `again`: the same operation id and the same request are sent a second time while the first outcome is
   * unknown. The server runs an operation id at most once; a replay answers from the one receipt.
   */
  const send = useCallback(
    async (operationId: string, label: string, request: RecoveryActionRequest | null, again = false) => {
      // A change (not a refresh request) is recorded for the user who sends it. Everything this call does to that
      // record, it does to THAT user's record of THAT operation — also when its answer arrives after this review
      // was closed, or after someone else signed in: it can never touch another user's record or screen.
      const recordedFor = request !== null && owner !== null ? owner.userId : null;
      setMessage(null);
      display(again ? { status: 'unknown', operationId, label, request, busy: 'resending', last: 'none' } : { status: 'sending', operationId, label, request });
      // Both act on the record of THIS operation only, and on the screen only while it shows this operation.
      const stillUnknown = (last: 'none' | 'unreachable' | 'try_again') => stillUnknownOperation(recordedFor, { operationId, label, request }, last);
      // The server answered THIS operation (or the request never left): its record is removed, then the screen settles.
      const settle = (text: string, tone: 'status' | 'alert', changed: boolean) => settleOperation(recordedFor, { operationId, label, request }, text, tone, changed);
      if (recordedFor !== null) {
        ownSend.current = operationId;
        if (!again) markInFlight(recordedFor, operationId, true);
      }
      try {
        const client = await api();
        const answer = request === null ? await client.requestRecoveryRefresh(operationId, verifyOwnership) : await client.applyRecoveryAction(request, verifyOwnership);
        if (answer.kind !== 'ok') {
          // An answer this build cannot read says nothing about what happened.
          await stillUnknown(again ? 'unreachable' : 'none');
          return;
        }
        // "queued" is all that is known of a refresh: a queue row exists. Whether anything runs it, has tried it or
        // will finish it is not known here, and is not said. A change that committed while its figures are not
        // current IS known: it was saved.
        if (answer.status === 'queued') await settle('A refresh is queued. The figures are not up to date.', 'status', false);
        else if (answer.status === 'committed_pending') await settle('Saved. A refresh is queued. The figures are not up to date.', 'status', true);
        else if (answer.status === 'replayed') await settle(request === null ? 'That refresh was already requested.' : 'That was already saved.', 'status', true);
        else await settle('Saved.', 'status', true);
      } catch (err) {
        const code = errorCode(err);
        const status = errorStatus(err);
        if (again && code !== null && OWNER_CHANGED_CODES.has(code)) {
          ownerChanged();
        } else if (!again && code !== null && NOT_SENT_CODES.has(code)) {
          await settle(recoveryFailureText(code), 'alert', false);
        } else if (code === OUTCOME_UNKNOWN || status === null || status >= 500) {
          // A timeout, a lost connection, a server error after the request left: it may have been saved.
          await stillUnknown(again ? 'unreachable' : 'none');
        } else if (again && (code === null || UNDECIDED_REFUSALS.has(code))) {
          // The server did not decide this operation: an earlier copy of it may still be saved.
          await stillUnknown('try_again');
        } else {
          // A refusal (4xx with a code): the server answered this operation, and saved nothing.
          await settle(recoveryFailureText(code), 'alert', false);
        }
      } finally {
        if (recordedFor !== null) {
          if (!again) markInFlight(recordedFor, operationId, false);
          if (ownSend.current === operationId) ownSend.current = null;
        }
      }
    },
    [settleOperation, stillUnknownOperation, verifyOwnership, ownerChanged, owner, display]
  );

  /** Asks whether a receipt of the SAME operation id is visible. Finding none decides nothing. */
  const check = useCallback(async () => {
    if (operation === null || operation.status !== 'unknown' || operation.busy !== null) return;
    const pending = operation;
    const recordedFor = pending.request !== null && owner !== null ? owner.userId : null;
    display({ ...pending, busy: 'checking' });
    try {
      const lookup = await (await api()).getRecoveryAction(pending.operationId, verifyOwnership);
      if (lookup.kind !== 'ok') throw new Error('unreadable');
      // A receipt is the server's answer to this operation: its record is removed. No receipt is not an answer:
      // the record stays, with what this look found. Either way only the record of THIS operation is touched, and
      // the screen only while it still shows this operation.
      if (lookup.found) await settleOperation(recordedFor, pending, pending.request === null ? 'The refresh was requested.' : 'It was saved.', 'status', true);
      else await stillUnknownOperation(recordedFor, pending, 'no_record');
    } catch (err) {
      const code = errorCode(err);
      if (code !== null && OWNER_CHANGED_CODES.has(code)) ownerChanged();
      else await stillUnknownOperation(recordedFor, pending, 'unreachable');
    }
  }, [operation, settleOperation, stillUnknownOperation, verifyOwnership, ownerChanged, owner, display]);

  const act = useCallback(
    async (label: string, action: RecoveryActionInput) => {
      // `shown` as well as `operation`: a second click before the next render must not start a second change.
      if (state.phase !== 'ready' || !state.data.fresh || operation !== null || shown.current !== null) return;
      const { input_version: inputVersion, review_revision: reviewRevision } = state.data.freshness;
      if (inputVersion === null || owner === null || unreadableRecord) return;
      const operationId = newOperationId();
      const request: RecoveryActionRequest = { operationId, expectedInputVersion: inputVersion, expectedReviewRevision: reviewRevision, action };
      // RECORDED BEFORE IT IS SENT — under the user's journal lock, on the record as it is THEN, not as this tab
      // last saw it. If the browser cannot keep the record, cannot give this tab its turn at it, or the record
      // already holds an unresolved change of this user (also one another tab recorded a moment ago), the request
      // is NOT sent: a change the server might save must never be without its id, and never replace another's.
      ownSend.current = operationId;
      setMessage(null);
      display({ status: 'sending', operationId, label, request });
      const recorded = await recordPendingOperation({ ownerUserId: owner.userId, operationId, label, request });
      if (!recorded.ok) {
        ownSend.current = null;
        if (mounted.current) {
          setConfirmDifference(null);
          setMessage({ tone: 'alert', text: notRecordedText(recorded.reason) });
          // Nothing of this change is pending. What the record holds — another tab's change, or nothing — is shown.
          adoptRecord.current('keep');
        }
        return;
      }
      void send(operationId, label, request);
    },
    [state, operation, send, owner, unreadableRecord, display]
  );

  const busy = operation !== null;
  // An unresolved change, and a record that cannot be read, are shown whatever else can or cannot be shown:
  // they do not depend on the list of reviews.
  const operationNotice = operation !== null && (
    <OperationNotice operation={operation} onCheck={check} onResend={() => operation.status === 'unknown' && operation.busy === null && void send(operation.operationId, operation.label, operation.request, true)} />
  );
  const notice = message !== null && (
    <p className={message.tone === 'alert' ? 'error drilldown-error' : 'hint'} role={message.tone}>
      {message.text}
    </p>
  );
  const recordNotice = unreadableRecord && (
    <p className="error drilldown-error" role="alert" data-testid="unreadable-pending-record">
      {UNREADABLE_RECORD_TEXT}
    </p>
  );

  // ---- What cannot be shown --------------------------------------------------------------------
  if (state.phase === 'loading') {
    return (
      <div className="category-drilldown" data-testid="payment-review">
        {notice}
        {recordNotice}
        {operationNotice}
        <p className="hint" role="status">
          Loading the review…
        </p>
      </div>
    );
  }
  if (state.phase === 'unavailable') {
    return (
      <div className="category-drilldown" data-testid="payment-review">
        {notice}
        {recordNotice}
        {operationNotice}
        <p className="hint" role="status">
          {state.unreadable ? "This version of the app can't show this review. Reload the page to update." : "Payment review isn't available right now."}{' '}
          <button type="button" className="link-button" onClick={reload}>
            Try again
          </button>
        </p>
      </div>
    );
  }

  const { data, reviews } = state;

  // ---- The figures are not current: no review is shown, and the refresh is always available ------
  if (!data.fresh) {
    return (
      <div className="category-drilldown" data-testid="payment-review">
        {notice}
        {recordNotice}
        {operationNotice}
        <NotCurrent freshness={data.freshness} count={data.affected_payment_count} busy={busy} onRefresh={() => void send(newOperationId(), 'Refresh the figures', null)} onReload={reload} />
      </div>
    );
  }

  const ordered = focusTransactionId ? [...reviews.filter((r) => r.transaction_id === focusTransactionId), ...reviews.filter((r) => r.transaction_id !== focusTransactionId)] : reviews;

  return (
    <div className="category-drilldown" data-testid="payment-review">
      {notice}
      {recordNotice}
      {operationNotice}
      {ordered.length === 0 ? (
        <p className="hint">No payments are under review.</p>
      ) : (
        <>
          <p className="hint">
            {paymentsUnderReviewNote(data.affected_payment_count)}. A bank connection was removed while these payments were tied to it. Nothing here is matched for you: you decide each one, or leave it.
          </p>
          {!data.actions_enabled && (
            <p className="hint" role="status">
              Changes from this screen are switched off right now. You can still read each review.
            </p>
          )}
          {ordered.map((review) => (
            <ReviewBlock
              key={review.transaction_id}
              review={review}
              name={describeTransaction?.(review.transaction_id) ?? null}
              describeTransaction={describeTransaction}
              open={openId === review.transaction_id}
              onToggle={() => setOpenId((current) => (current === review.transaction_id ? null : review.transaction_id))}
              canAct={data.actions_enabled && owner !== null && !busy && !unreadableRecord}
              actionsEnabled={data.actions_enabled}
              confirmDifference={confirmDifference}
              onConfirmDifference={setConfirmDifference}
              onAct={act}
            />
          ))}
          {data.next_cursor !== null && (
            <button type="button" className="link-button" onClick={loadMore} disabled={state.loadingMore}>
              {state.loadingMore ? 'Loading…' : 'Show more'}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function NotCurrent({ freshness, count, busy, onRefresh, onReload }: { freshness: RecoveryFreshness; count: number; busy: boolean; onRefresh: () => void; onReload: () => void }) {
  const attention = freshness.refresh.needs_attention;
  return (
    <p className={attention ? 'error drilldown-error' : 'hint'} role={attention ? 'alert' : 'status'}>
      {count === 0 ? '' : count === 1 ? '1 payment is under review. ' : `${count} payments are under review. `}
      {attention
        ? `${count === 0 ? 'Your card-payment figures' : count === 1 ? 'Its figures' : 'Their figures'} couldn't be brought up to date after several tries, so nothing is shown.`
        : freshness.refresh.queued
          ? // ALL that a queue row establishes: a refresh is queued. Not that anything is running it, not that
            // nothing has tried it yet (it may have failed several times), not that it will finish.
            'A refresh is queued. The figures are not up to date. No figure is shown.'
          : 'The figures are not up to date. No figure is shown.'}{' '}
      <button type="button" className="link-button" onClick={onRefresh} disabled={busy}>
        Refresh the figures
      </button>
      {' · '}
      <button type="button" className="link-button" onClick={onReload} disabled={busy}>
        Check again
      </button>
    </p>
  );
}

function OperationNotice({ operation, onCheck, onResend }: { operation: Operation; onCheck: () => void; onResend: () => void }) {
  if (operation.status === 'sending') {
    return (
      <p className="hint" role="status">
        Saving: {operation.label}…
      </p>
    );
  }
  const working = operation.busy !== null;
  return (
    <p className="error drilldown-error" role="alert" data-testid="unknown-outcome" data-operation-id={operation.operationId}>
      We don't know whether “{operation.label}” was saved: no answer came back. It may have been.{' '}
      {operation.last === 'no_record' && 'No record of it is visible yet. That does not mean it failed: it may still be completing. '}
      {operation.last === 'unreachable' && "That couldn't be checked just now. "}
      {operation.last === 'try_again' && 'The server could not answer that just now. '}
      Nothing else can be changed here until this is known.{' '}
      <button type="button" className="link-button" onClick={onCheck} disabled={working}>
        {operation.busy === 'checking' ? 'Checking…' : 'Check whether it was saved'}
      </button>
      {' · '}
      <button type="button" className="link-button" onClick={onResend} disabled={working} title="The same request, under the same id. It cannot be saved twice.">
        {operation.busy === 'resending' ? 'Sending…' : 'Send the same request again'}
      </button>
    </p>
  );
}

function ReviewBlock({
  review,
  name,
  describeTransaction,
  open,
  onToggle,
  canAct,
  actionsEnabled,
  confirmDifference,
  onConfirmDifference,
  onAct,
}: {
  review: RecoveryReview;
  name: string | null;
  describeTransaction?: (transactionId: string) => string | null;
  open: boolean;
  onToggle: () => void;
  canAct: boolean;
  actionsEnabled: boolean;
  confirmDifference: string | null;
  onConfirmDifference: (key: string | null) => void;
  onAct: (label: string, action: RecoveryActionInput) => void;
}) {
  const reading = reviewReadingText(review);
  const title = name ? `${name} — ${reviewTitle(review)}` : reviewTitle(review);
  const userDecision = review.controlling_decision?.user_decision ? review.controlling_decision : null;
  const id = review.transaction_id;

  return (
    <div className="drilldown-row" data-testid={`review-${id}`} style={{ display: 'block' }}>
      <button type="button" className="link-button" onClick={onToggle} aria-expanded={open}>
        {title}
      </button>{' '}
      <span className="split-badge">{reading.headline}</span>
      {review.pending && <span className="split-badge">pending</span>}
      {open && (
        <div>
          <p className="hint" data-testid={`reading-${id}`}>
            {reading.detail}
          </p>

          <p className="hint">
            <strong>Why it is under review</strong>
          </p>
          {review.obligations.map((obligation) => (
            <div key={obligation.obligation_id} data-testid={`obligation-${obligation.obligation_id}`}>
              <p className="hint">{reviewObligationText(obligation)}</p>
              {obligation.sources.map((source, index) => (
                <p className="hint" key={source.decision_id ?? `graph-${index}`}>
                  {reviewSourceText(source)}
                </p>
              ))}
            </div>
          ))}
          <p className="hint">This record of the removal stays as it is, whatever you decide here.</p>

          {userDecision && (
            <p className="hint" data-testid={`decision-${id}`}>
              {reviewDecisionText(userDecision)}{' '}
              {actionsEnabled && (
                <button type="button" className="link-button" disabled={!canAct} title={REVIEW_ACTION_HELP.undo_decision} onClick={() => onAct('Undo your decision', { type: 'undo_decision', decisionId: userDecision.decision_id })}>
                  Undo
                </button>
              )}
            </p>
          )}

          <p className="hint">
            <strong>Possible other side</strong> — suggestions from your bank data. None is confirmed, and none is applied unless you choose it.
          </p>
          {review.candidates.length === 0 ? (
            <p className="hint">No transaction in your accounts looks like the other side of this payment.</p>
          ) : (
            review.candidates.map((candidate) => (
              <CandidateRow
                key={candidate.transaction_id}
                review={review}
                candidate={candidate}
                name={describeTransaction?.(candidate.transaction_id) ?? null}
                canAct={canAct}
                actionsEnabled={actionsEnabled}
                replaces={userDecision !== null}
                confirming={confirmDifference === `${id}|${candidate.transaction_id}`}
                onConfirm={(on) => onConfirmDifference(on ? `${id}|${candidate.transaction_id}` : null)}
                onAct={onAct}
              />
            ))
          )}

          {actionsEnabled && (
            <p className="hint">
              {review.side === 'cash' && userDecision?.kind !== 'destination_unlinked' && (
                <>
                  <button
                    type="button"
                    className="link-button"
                    disabled={!canAct}
                    title={REVIEW_ACTION_HELP.confirm_unlinked}
                    onClick={() => onAct("It went to a card I haven't linked", { type: 'confirm_unlinked', transactionId: id })}
                  >
                    It went to a card I haven't linked
                  </button>
                  {userDecision !== null && ' (replaces your earlier decision)'}
                  {' · '}
                </>
              )}
              {review.deferred ? (
                'You chose to decide later.'
              ) : (
                <button type="button" className="link-button" disabled={!canAct} title={REVIEW_ACTION_HELP.defer} onClick={() => onAct('Decide later', { type: 'defer', transactionId: id })}>
                  Decide later
                </button>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function CandidateRow({
  review,
  candidate,
  name,
  canAct,
  actionsEnabled,
  replaces,
  confirming,
  onConfirm,
  onAct,
}: {
  review: RecoveryReview;
  candidate: RecoveryCandidate;
  name: string | null;
  canAct: boolean;
  actionsEnabled: boolean;
  replaces: boolean;
  confirming: boolean;
  onConfirm: (on: boolean) => void;
  onAct: (label: string, action: RecoveryActionInput) => void;
}) {
  const id = review.transaction_id;
  // |cash| − |credit|, as the server requires it: the candidate's difference is |this leg| − |candidate|.
  const acceptedDifferenceCents = review.side === 'cash' ? candidate.difference_cents : -candidate.difference_cents;
  const pair = () =>
    onAct('Match these two', { type: 'pair_current', transactionId: id, counterpartTransactionId: candidate.transaction_id, acceptedDifferenceCents });
  return (
    <div data-testid={`candidate-${candidate.transaction_id}`}>
      <p className="hint">
        {name ? `${name} · ` : ''}
        {reviewCandidateText(candidate)}
        {candidate.withheld_by_guard && ' · the closest fit — held back for your review, not matched'}
        {candidate.rejected && ' · you hid this suggestion'}
      </p>
      {actionsEnabled && (
        <p className="hint">
          {candidate.difference_cents === 0 ? (
            <button type="button" className="link-button" disabled={!canAct} title={REVIEW_ACTION_HELP.pair_current} onClick={pair}>
              Match with this
            </button>
          ) : confirming ? (
            <>
              {acceptedDifferenceText(candidate.difference_cents)}{' '}
              <button type="button" className="link-button" disabled={!canAct} onClick={pair}>
                Accept the difference and match
              </button>
              {' · '}
              <button type="button" className="link-button" onClick={() => onConfirm(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button type="button" className="link-button" disabled={!canAct} title={REVIEW_ACTION_HELP.pair_current} onClick={() => onConfirm(true)}>
              Match with this…
            </button>
          )}
          {replaces && ' (replaces your earlier decision)'}
          {' · '}
          <button
            type="button"
            className="link-button"
            disabled={!canAct}
            title={REVIEW_ACTION_HELP.dismiss_candidate}
            onClick={() => onAct('Not the other side of this payment', { type: 'dismiss_candidate', transactionId: id, candidateTransactionId: candidate.transaction_id })}
          >
            Not this one — it can change the figure
          </button>
          {!candidate.rejected && (
            <>
              {' · '}
              <button
                type="button"
                className="link-button"
                disabled={!canAct}
                title={REVIEW_ACTION_HELP.reject_suggestion}
                onClick={() => onAct('Hide this suggestion', { type: 'reject_suggestion', transactionId: id, candidateTransactionId: candidate.transaction_id })}
              >
                Hide this suggestion — nothing else changes
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}
