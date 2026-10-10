import type { RecoveryActionInput, RecoveryActionRequest } from './api';

/**
 * The record of a payment-review change whose outcome is not known yet (I3A-R packet 2-A, correction C2;
 * PHASE_B_I3A_R_PACKET_2A_REVIEW.md §9).
 *
 * WHY IT EXISTS. A change is sent once, under one operation id, with one exact request. If no answer comes
 * back, the server may still have saved it — its receipt is invisible while its transaction is open — and the
 * only safe things to do are to ask about THAT id or to send THAT request again. Both need the id and the
 * request. The review screen is closed, reopened, left and reloaded; the app is updated; the user signs in
 * again. None of that may lose them. So they are written here BEFORE the request is sent, and removed only when
 * the server has answered that operation.
 *
 * WHERE. The browser's `localStorage`, one entry per signed-in user:
 *     my-finances:card-payment-recovery:pending:v1:<user id>
 * It survives a closed panel, a navigation, a reload, an app update and a new login of the same user. It does
 * NOT survive the user clearing the browser's data, a private window being closed, or another browser or device:
 * what was erased cannot be recovered, and this module does not pretend otherwise. `localStorage` is neither
 * encrypted nor hidden from other scripts of this same site: nothing secret is kept in it (below).
 *
 * WHOSE. The entry is filed under the user id of the signed-in user who sent the request, and is read only for
 * the user who is signed in now. Another user's entry is never read, shown, sent or changed while someone else is
 * signed in: it stays where it is until its own user is back. The user id here is BOOKKEEPING — which entry to
 * look at — and never authority: every request that reconciles an operation is authenticated by the server from
 * the session, as always.
 *
 * WHAT IS KEPT. Exactly what asking and re-sending need: the user id, the operation id, the request as it was
 * sent (the versions the user saw, the action, the ids it names, an accepted difference), the label shown for it,
 * and whether an answer is still awaited. No session or access token, no password, no key, no amount, no name,
 * no account or transaction content.
 *
 * WHAT IT NEVER DOES.
 *   - It never replaces an unresolved record with another one (`recordPendingOperation` refuses).
 *   - It never removes a record on its own: no expiry, no clean-up, no "forget". Only `resolvePendingOperation`,
 *     called with the SAME operation id after the server answered that operation, removes it.
 *   - It never overwrites or deletes an entry it cannot read (damaged, or written by a version it does not know).
 *     Such an entry may be an unresolved operation. Everything stops instead: nothing new can be recorded for that
 *     user, so nothing new is sent.
 *   - It never falls back to memory when the browser cannot store: a change that might be saved by the server
 *     with no recoverable id is not sent at all.
 *
 * ONE CHANGE AT A TIME, ACROSS TABS (v4). Two tabs of the same user share the entry. Recording, noting and
 * resolving are each a read, a decision and a write; if another tab could change the entry in between, a tab
 * would decide on what is no longer there — overwrite an unresolved operation it did not see, or delete or
 * rewrite the one that replaced the one it meant. A read-back after the write, a `storage` event and a flag in
 * this page's memory do not prevent that. So each of the three runs under an EXCLUSIVE WEB LOCK of that user's
 * journal (`navigator.locks`, one lock per user, the same for every tab and worker of this origin), and reads the
 * entry AGAIN inside it. What the lock guarantees is the browser's: one holder of a name at a time across the
 * origin's tabs. What follows from it here:
 *   - of two competing changes exactly one is recorded; the other finds it and is refused, so it is not sent;
 *   - a note or a resolution for X changes or removes the entry only while the entry IS X. After X was resolved
 *     and Y recorded, a late answer for X finds Y and does nothing to it.
 * The lock is held for the change itself — synchronous, a few storage calls — never across a request to the
 * server: the entry, not a held lock, is what remembers an unresolved operation.
 *   - NO LOCK, NO CHANGE. A browser without Web Locks, a context where it is refused, a lock that does not come
 *     in time: the change is not made. A new operation is then not recorded (so not sent); an existing record is
 *     neither rewritten nor removed. Waiting too long is not an answer of the server: nothing is forgotten and
 *     nobody's place is taken. There is no uncoordinated path.
 *   - LIMIT. Only code that takes the lock is held by it. A tab still running a build from before v4 changes the
 *     entry without it, and so does anything else that writes this origin's storage directly.
 * Reading takes no lock: a single read is whole in itself, and nothing is decided on a read alone.
 */

/** The format of a stored record. A record of any other format is not read as one. */
export const PENDING_FORMAT = 1;
const KEY_PREFIX = 'my-finances:card-payment-recovery:pending:v1:';

/** What the last attempt to find out said. None of these is an outcome. */
export type PendingLastCheck = 'none' | 'no_record' | 'unreachable' | 'try_again';

export interface PendingRecoveryOperation {
  format: typeof PENDING_FORMAT;
  /** The signed-in user who sent the request. Bookkeeping, never authority. */
  ownerUserId: string;
  operationId: string;
  /** The words the screen showed for the change ("Match these two"). */
  label: string;
  /** The request exactly as it was sent. It is replayed as it is: never rebuilt from what is on screen later. */
  request: RecoveryActionRequest;
  /**
   * `sending`: recorded, and the request was handed to the network (or was about to be). `unknown`: it ended with
   * no usable answer. After a reload both mean the same: no answer is known.
   */
  status: 'sending' | 'unknown';
  last: PendingLastCheck;
  /** When it was recorded (ISO 8601). For the user's information only: nothing expires. */
  recordedAt: string;
}

export type PendingRead =
  | { kind: 'none' }
  | { kind: 'pending'; operation: PendingRecoveryOperation }
  /**
   * `storage_unavailable`: the browser gives this page no storage. `unreadable_record`: an entry exists for this
   * user and is not a record this version can read. In both cases nothing new may be sent.
   */
  | { kind: 'unusable'; reason: 'storage_unavailable' | 'unreadable_record' };

export type PendingWrite =
  | { ok: true }
  /**
   * `coordination_unavailable`: the exclusive lock of this user's journal could not be had (no Web Locks, refused,
   * not in time). Nothing was read for a decision and nothing was written or removed.
   */
  | { ok: false; reason: 'storage_unavailable' | 'storage_failed' | 'unreadable_record' | 'another_operation_pending' | 'not_this_operation' | 'coordination_unavailable' };

export const pendingStorageKey = (ownerUserId: string): string => `${KEY_PREFIX}${ownerUserId}`;

// ---- One change at a time, across tabs -----------------------------------------------------------------------
const LOCK_PREFIX = 'my-finances:card-payment-recovery:pending-journal:v1:';
/** The lock of one user's journal. Every change of that user's entry is made while holding it, in every tab. */
export const pendingLockName = (ownerUserId: string): string => `${LOCK_PREFIX}${ownerUserId}`;
/**
 * How long a change waits for its turn. The work under the lock is a few synchronous storage calls, so a wait
 * this long means the lock cannot be had in practice. Giving up changes nothing: see `exclusively`.
 */
export const COORDINATION_WAIT_MS = 5000;

function lockManager(): LockManager | null {
  try {
    const locks = globalThis.navigator?.locks;
    return locks && typeof locks.request === 'function' ? locks : null;
  } catch {
    return null;
  }
}

/**
 * Runs one change of this user's entry while holding that user's journal lock, and returns what it returned.
 * `change` is synchronous and reads the entry itself, inside the lock. If the lock cannot be had, `change` is
 * NOT run — not now and not later — and the answer is `coordination_unavailable`.
 */
async function exclusively(ownerUserId: string, change: () => PendingWrite): Promise<PendingWrite> {
  const locks = lockManager();
  if (locks === null) return { ok: false, reason: 'coordination_unavailable' };
  const made: { result: PendingWrite | null } = { result: null };
  const waiting = new AbortController();
  // A request that is still waiting when this fires is withdrawn by the browser and never granted afterwards.
  const giveUp = setTimeout(() => waiting.abort(), COORDINATION_WAIT_MS);
  try {
    await locks.request(pendingLockName(ownerUserId), { mode: 'exclusive', signal: waiting.signal }, () => {
      clearTimeout(giveUp);
      try {
        made.result = change();
      } catch {
        made.result = { ok: false, reason: 'storage_failed' };
      }
    });
  } catch {
    // Not granted: withdrawn after waiting, or refused by the browser. (If the change ran, its own answer stands.)
  } finally {
    clearTimeout(giveUp);
  }
  return made.result ?? { ok: false, reason: 'coordination_unavailable' };
}

function storage(): Storage | null {
  try {
    const store = globalThis.localStorage;
    return store ?? null;
  } catch {
    // Storage blocked for this page (a browser setting, an embedded context): reading the property itself throws.
    return null;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const hasExactly = (value: Record<string, unknown>, keys: string[]): boolean => Object.keys(value).length === keys.length && keys.every((key) => key in value);

/** The action exactly as the API takes it; anything else is not a request this version could have sent. */
function readAction(value: unknown): RecoveryActionInput | null {
  if (!isObject(value)) return null;
  switch (value.type) {
    case 'pair_current':
      return hasExactly(value, ['type', 'transactionId', 'counterpartTransactionId', 'acceptedDifferenceCents']) && isId(value.transactionId) && isId(value.counterpartTransactionId) && typeof value.acceptedDifferenceCents === 'number' && Number.isSafeInteger(value.acceptedDifferenceCents)
        ? { type: 'pair_current', transactionId: value.transactionId, counterpartTransactionId: value.counterpartTransactionId, acceptedDifferenceCents: value.acceptedDifferenceCents }
        : null;
    case 'confirm_unlinked':
      return hasExactly(value, ['type', 'transactionId']) && isId(value.transactionId) ? { type: 'confirm_unlinked', transactionId: value.transactionId } : null;
    case 'dismiss_candidate':
      return hasExactly(value, ['type', 'transactionId', 'candidateTransactionId']) && isId(value.transactionId) && isId(value.candidateTransactionId)
        ? { type: 'dismiss_candidate', transactionId: value.transactionId, candidateTransactionId: value.candidateTransactionId }
        : null;
    case 'undo_decision':
      return hasExactly(value, ['type', 'decisionId']) && isId(value.decisionId) ? { type: 'undo_decision', decisionId: value.decisionId } : null;
    case 'reject_suggestion':
      return hasExactly(value, ['type', 'transactionId', 'candidateTransactionId']) && isId(value.transactionId) && isId(value.candidateTransactionId)
        ? { type: 'reject_suggestion', transactionId: value.transactionId, candidateTransactionId: value.candidateTransactionId }
        : null;
    case 'defer':
      return hasExactly(value, ['type', 'transactionId']) && isId(value.transactionId) ? { type: 'defer', transactionId: value.transactionId } : null;
    default:
      return null;
  }
}

function readRequest(value: unknown, operationId: string): RecoveryActionRequest | null {
  if (!isObject(value) || !hasExactly(value, ['operationId', 'expectedInputVersion', 'expectedReviewRevision', 'action'])) return null;
  if (value.operationId !== operationId || !isVersion(value.expectedInputVersion) || !isVersion(value.expectedReviewRevision)) return null;
  const action = readAction(value.action);
  if (action === null) return null;
  return { operationId, expectedInputVersion: value.expectedInputVersion, expectedReviewRevision: value.expectedReviewRevision, action };
}

/** A stored value as a record of THIS user, or null when it is anything else. */
function readRecord(raw: string, ownerUserId: string): PendingRecoveryOperation | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(value) || value.format !== PENDING_FORMAT) return null;
  if (!hasExactly(value, ['format', 'ownerUserId', 'operationId', 'label', 'request', 'status', 'last', 'recordedAt'])) return null;
  // The entry is filed under its user's id; a record that names another user is not this user's record.
  if (value.ownerUserId !== ownerUserId || !isId(value.operationId)) return null;
  if (typeof value.label !== 'string' || value.label.length === 0 || value.label.length > 200) return null;
  if (value.status !== 'sending' && value.status !== 'unknown') return null;
  if (value.last !== 'none' && value.last !== 'no_record' && value.last !== 'unreachable' && value.last !== 'try_again') return null;
  if (typeof value.recordedAt !== 'string' || Number.isNaN(Date.parse(value.recordedAt))) return null;
  const request = readRequest(value.request, value.operationId);
  if (request === null) return null;
  return { format: PENDING_FORMAT, ownerUserId, operationId: value.operationId, label: value.label, request, status: value.status, last: value.last, recordedAt: value.recordedAt };
}

/** The unresolved operation of this user, if any. Reads nothing of any other user. Never throws. */
export function readPendingOperation(ownerUserId: string): PendingRead {
  const store = storage();
  if (store === null) return { kind: 'unusable', reason: 'storage_unavailable' };
  let raw: string | null;
  try {
    raw = store.getItem(pendingStorageKey(ownerUserId));
  } catch {
    return { kind: 'unusable', reason: 'storage_unavailable' };
  }
  if (raw === null) return { kind: 'none' };
  const operation = readRecord(raw, ownerUserId);
  return operation === null ? { kind: 'unusable', reason: 'unreadable_record' } : { kind: 'pending', operation };
}

// ---- Who is told when a record changes ---------------------------------------------------------------------
// Every open review, and the two entries that lead to it, show the same record. A change made by one of them —
// or by an answer that arrives after the review that sent the request was closed — reaches the others here; a
// change made in another tab reaches this one through the browser's `storage` event.
const listeners = new Set<() => void>();
function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // A listener's own failure is not this module's, and must not keep the others from hearing.
    }
  }
}
let listeningToOtherTabs = false;
function onStorageEvent(event: StorageEvent): void {
  if (event.key === null || event.key.startsWith(KEY_PREFIX)) notify();
}
export function subscribePendingOperations(listener: () => void): () => void {
  listeners.add(listener);
  if (!listeningToOtherTabs && typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('storage', onStorageEvent as EventListener);
    listeningToOtherTabs = true;
  }
  return () => {
    listeners.delete(listener);
  };
}

function write(store: Storage, ownerUserId: string, operation: PendingRecoveryOperation): PendingWrite {
  const text = JSON.stringify(operation);
  try {
    store.setItem(pendingStorageKey(ownerUserId), text);
    // Written is not kept until it reads back: a store that accepts and drops would otherwise look like one that keeps.
    if (store.getItem(pendingStorageKey(ownerUserId)) !== text) return { ok: false, reason: 'storage_failed' };
  } catch {
    // Full, or refused by the browser.
    return { ok: false, reason: 'storage_failed' };
  }
  notify();
  return { ok: true };
}

/**
 * Records a change BEFORE it is sent. Refuses — and then the change must not be sent — when the browser cannot
 * keep it, when this user's entry cannot be read, or when this user already has an unresolved operation: that one
 * is never replaced. Recording the same operation again (the same id and the same request) is accepted.
 * Made under the user's journal lock, on the entry as it is THEN: what a tab saw earlier decides nothing.
 */
export function recordPendingOperation(input: { ownerUserId: string; operationId: string; label: string; request: RecoveryActionRequest }): Promise<PendingWrite> {
  return exclusively(input.ownerUserId, () => recordWhileHoldingTheLock(input));
}
function recordWhileHoldingTheLock(input: { ownerUserId: string; operationId: string; label: string; request: RecoveryActionRequest }): PendingWrite {
  const store = storage();
  if (store === null) return { ok: false, reason: 'storage_unavailable' };
  const current = readPendingOperation(input.ownerUserId);
  if (current.kind === 'unusable') return { ok: false, reason: current.reason };
  if (current.kind === 'pending' && (current.operation.operationId !== input.operationId || JSON.stringify(current.operation.request) !== JSON.stringify(input.request))) {
    return { ok: false, reason: 'another_operation_pending' };
  }
  const operation: PendingRecoveryOperation = {
    format: PENDING_FORMAT,
    ownerUserId: input.ownerUserId,
    operationId: input.operationId,
    label: input.label,
    request: input.request,
    status: 'sending',
    last: current.kind === 'pending' ? current.operation.last : 'none',
    recordedAt: current.kind === 'pending' ? current.operation.recordedAt : new Date().toISOString(),
  };
  // What is stored must be what would be read back: a request this version could not read later is not recorded.
  if (readRecord(JSON.stringify(operation), input.ownerUserId) === null) return { ok: false, reason: 'storage_failed' };
  return write(store, input.ownerUserId, operation);
}

/**
 * Notes that no usable answer came (`unknown`) and what the last attempt to find out said. Changes nothing but
 * those two fields, and only on the record of that same operation of that user — as the entry is when the lock
 * is held: if another operation has taken its place since, nothing is written (`not_this_operation`).
 */
export function notePendingOperation(ownerUserId: string, operationId: string, status: 'sending' | 'unknown', last: PendingLastCheck): Promise<PendingWrite> {
  return exclusively(ownerUserId, () => noteWhileHoldingTheLock(ownerUserId, operationId, status, last));
}
function noteWhileHoldingTheLock(ownerUserId: string, operationId: string, status: 'sending' | 'unknown', last: PendingLastCheck): PendingWrite {
  const store = storage();
  if (store === null) return { ok: false, reason: 'storage_unavailable' };
  const current = readPendingOperation(ownerUserId);
  if (current.kind === 'unusable') return { ok: false, reason: current.reason };
  if (current.kind === 'none' || current.operation.operationId !== operationId) return { ok: false, reason: 'not_this_operation' };
  return write(store, ownerUserId, { ...current.operation, status, last });
}

/**
 * The server answered THIS operation (a receipt, a success, a replay, or its refusal): the record of it is
 * removed. Only the record of that user with that operation id; any other record — another operation, another
 * user's, one that cannot be read — is left exactly as it is. Decided on the entry as it is when the lock is
 * held: an answer for X that arrives after X was resolved elsewhere and Y recorded removes nothing.
 */
export function resolvePendingOperation(ownerUserId: string, operationId: string): Promise<PendingWrite> {
  return exclusively(ownerUserId, () => resolveWhileHoldingTheLock(ownerUserId, operationId));
}
function resolveWhileHoldingTheLock(ownerUserId: string, operationId: string): PendingWrite {
  const store = storage();
  if (store === null) return { ok: false, reason: 'storage_unavailable' };
  const current = readPendingOperation(ownerUserId);
  if (current.kind === 'unusable') return { ok: false, reason: current.reason };
  if (current.kind === 'none' || current.operation.operationId !== operationId) return { ok: false, reason: 'not_this_operation' };
  try {
    store.removeItem(pendingStorageKey(ownerUserId));
  } catch {
    return { ok: false, reason: 'storage_failed' };
  }
  notify();
  return { ok: true };
}

// ---- Requests that are on their way in THIS page -----------------------------------------------------------
// A record says "sending" from the moment before the request leaves. Whether that request is still on its way
// is known only to the page that sent it, and only while that page lives: after a reload nothing is on its way.
const inFlight = new Set<string>();
const flightKey = (ownerUserId: string, operationId: string): string => `${ownerUserId}\n${operationId}`;
export function markInFlight(ownerUserId: string, operationId: string, flying: boolean): void {
  if (flying) inFlight.add(flightKey(ownerUserId, operationId));
  else inFlight.delete(flightKey(ownerUserId, operationId));
  notify();
}
export const isInFlight = (ownerUserId: string, operationId: string): boolean => inFlight.has(flightKey(ownerUserId, operationId));
