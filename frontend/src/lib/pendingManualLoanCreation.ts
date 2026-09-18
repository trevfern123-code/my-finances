import type { ManualLoanInput } from './api';
import { parseManualLoanInput } from './manualLoanValidation';

/**
 * A manual-loan creation that has been sent at least once but not yet confirmed resolved.
 *
 * A create failure is ambiguous: the backend commits the loan before running
 * backfillMatchesForLoan, so an error response (or a network drop, or the page going away
 * mid-request) can mean the loan already exists. The only safe retry resends the IDENTICAL
 * idempotency key and payload, which the server replays onto the loan it already created. So this
 * record lives outside the create form, scoped to the authenticated user and in durable browser
 * storage, and it is removed ONLY once the server has confirmed the attempt's outcome. There is
 * deliberately no way for the client to abandon it: the client cannot know whether the key already
 * created a loan, and a new key for the same intent is exactly how a duplicate gets created.
 *
 * Each user has ONE slot. While it holds an attempt, no other attempt may start for that user —
 * in this tab or any other.
 */
export interface PendingManualLoanCreation {
  idempotencyKey: string;
  input: ManualLoanInput;
}

/** A create request must not be sent: the attempt could not be made durable and exclusive. */
export class PendingCreationPersistenceError extends Error {}

/** The minimal Web Locks surface this module uses (`navigator.locks`); injectable for tests. */
export interface CrossContextLocks {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
}

export type AcquireResult =
  /** This tab holds the slot for `pending` (freshly stored, or already stored under this key). */
  | { status: 'acquired'; pending: PendingManualLoanCreation }
  /** A DIFFERENT unresolved attempt holds the slot; it was not touched. Adopt it; do not send. */
  | { status: 'held-by-other'; pending: PendingManualLoanCreation };

const STORAGE_PREFIX = 'myfinances.pendingManualLoanCreation.';
const LOCK_PREFIX = 'myfinances.pendingManualLoanCreation.lock.';

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function browserLocks(): CrossContextLocks | null {
  const locks = (globalThis.navigator as (Navigator & { locks?: CrossContextLocks }) | undefined)?.locks;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/**
 * Version of the stored envelope `{ version, idempotencyKey, input }`. A record with any other
 * version (from a newer or older build of this app) is not understood, and — like any other
 * unrecognized record — fails closed rather than being treated as an empty slot.
 */
const RECORD_VERSION = 1;

function serializeRecord(pending: PendingManualLoanCreation): string {
  return JSON.stringify({ version: RECORD_VERSION, idempotencyKey: pending.idempotencyKey, input: pending.input });
}

/**
 * Strict: exactly `{ version, idempotencyKey, input }`, the supported version, a non-empty key, and
 * an `input` that is a complete, well-typed ManualLoanInput passing the same rules as new input
 * (Round 14 remediation — previously any non-array object was accepted as the payload and cast).
 * Anything else is unrecognized and returns null.
 */
function parseRecord(raw: string): PendingManualLoanCreation | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== 'idempotencyKey' || keys[1] !== 'input' || keys[2] !== 'version') return null;
  if (record.version !== RECORD_VERSION) return null;
  if (typeof record.idempotencyKey !== 'string' || record.idempotencyKey.length === 0) return null;
  const input = parseManualLoanInput(record.input);
  if (input === null) return null;
  return { idempotencyKey: record.idempotencyKey, input };
}

/**
 * Non-authoritative read, for DISPLAY only (e.g. reopening the form onto an unresolved attempt).
 * Never use its result to decide whether a new attempt may start — only acquire makes that decision,
 * under the lock. A malformed record reads as null here; acquire is what refuses to act on it.
 */
export function loadPendingManualLoanCreation(userId: string): PendingManualLoanCreation | null {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    return raw === null ? null : parseRecord(raw);
  } catch {
    return null;
  }
}

/**
 * Claims the user's slot for `pending`, or reports the unresolved attempt already holding it.
 * Throws PendingCreationPersistenceError — and sends nothing — whenever that cannot be done safely.
 *
 * Round 13 remediation. Round 12 read the slot, then wrote it, as two ordinary localStorage calls.
 * localStorage has no compare-and-swap, so two tabs could both read the slot as empty before either
 * wrote, then each store its own key — the second overwriting the first — and each send a request
 * under a different key: two loans. The read-check-write below therefore runs inside an exclusive
 * Web Lock named for this user. Web Locks are coordinated by the browser across every tab, window
 * and worker of this origin (the same scope as this localStorage), so no second context can run
 * this section for the same user until the first has finished its write and read-back. The loser
 * then finds the winner's record and gets 'held-by-other'.
 *
 * Inside the lock:
 *  - an empty slot is written with `pending` and read back verbatim before 'acquired' is returned;
 *  - a slot holding THIS key is 'acquired' with the stored record (its payload is authoritative —
 *    a retry must resend what was first sent);
 *  - a slot holding ANY OTHER key is left untouched and returned as 'held-by-other';
 *  - a non-empty slot that is not a well-formed record fails closed: it may be an attempt written
 *    by another version of this app, so treating it as empty and replacing it could forget a key
 *    that already created a loan.
 * Without Web Locks (very old browsers) nothing is attempted: there is no safe way to make the
 * slot exclusive, so creating a loan is refused rather than risked.
 */
export async function acquirePendingManualLoanCreation(
  userId: string,
  pending: PendingManualLoanCreation,
  locks: CrossContextLocks | null = browserLocks()
): Promise<AcquireResult> {
  if (!locks) {
    throw new PendingCreationPersistenceError(
      "This browser can't coordinate saves between open tabs, so the loan was not sent — without that, " +
        'two tabs could each create it. Update your browser, then try again.'
    );
  }
  const key = storageKey(userId);
  return locks.request(`${LOCK_PREFIX}${userId}`, () => {
    let raw: string | null;
    try {
      raw = localStorage.getItem(key);
    } catch (err) {
      throw storageUnavailable(err);
    }

    if (raw !== null) {
      const existing = parseRecord(raw);
      if (existing === null) {
        throw new PendingCreationPersistenceError(
          'Saved data about an earlier loan save on this device is unreadable, so no new loan was sent — ' +
            'replacing it could lose track of a loan that save already created. Check your loans list; ' +
            "if it's there, you can clear this site's data to continue."
        );
      }
      return existing.idempotencyKey === pending.idempotencyKey
        ? { status: 'acquired', pending: existing }
        : { status: 'held-by-other', pending: existing };
    }

    // Never write a record this module would itself refuse to read back: it would become an
    // "unreadable" slot that blocks every later creation for this user.
    if (parseManualLoanInput(pending.input) === null || pending.idempotencyKey.length === 0) {
      throw new PendingCreationPersistenceError('This loan could not be saved because some of its details are invalid.');
    }
    const serialized = serializeRecord(pending);
    try {
      localStorage.setItem(key, serialized);
      if (localStorage.getItem(key) !== serialized) {
        throw new Error('stored value did not read back identically');
      }
    } catch (err) {
      throw storageUnavailable(err);
    }
    return { status: 'acquired', pending };
  });
}

/**
 * Removes the user's record once the server has confirmed the attempt's outcome — under the same
 * lock, and only if the slot still holds exactly `idempotencyKey`, so this can never erase an attempt
 * another tab acquired in the meantime, nor a record it cannot read. Best-effort: if the lock or
 * storage is unavailable the record survives, and retrying it only replays the confirmed result.
 */
export async function releasePendingManualLoanCreation(
  userId: string,
  idempotencyKey: string,
  locks: CrossContextLocks | null = browserLocks()
): Promise<void> {
  if (!locks) return;
  const key = storageKey(userId);
  try {
    await locks.request(`${LOCK_PREFIX}${userId}`, () => {
      const raw = localStorage.getItem(key);
      const current = raw === null ? null : parseRecord(raw);
      if (current !== null && current.idempotencyKey === idempotencyKey) {
        localStorage.removeItem(key);
      }
    });
  } catch {
    // See doc comment.
  }
}

function storageUnavailable(err: unknown): PendingCreationPersistenceError {
  const reason = err instanceof Error ? err.message : String(err);
  return new PendingCreationPersistenceError(
    `This browser isn't letting the app save data on this device (${reason}), so the loan was not sent — ` +
      'without that, a failed save could not be safely retried. Turn off private browsing or allow site data, then try again.'
  );
}
