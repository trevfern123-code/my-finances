import type { ManualLoanInput } from './api';

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
 */
export interface PendingManualLoanCreation {
  idempotencyKey: string;
  input: ManualLoanInput;
}

/** Durable storage could not be written and verified, so a create request must not be sent. */
export class PendingCreationPersistenceError extends Error {}

const STORAGE_PREFIX = 'myfinances.pendingManualLoanCreation.';

function storageKey(userId: string): string {
  return `${STORAGE_PREFIX}${userId}`;
}

function isPending(value: unknown): value is PendingManualLoanCreation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.idempotencyKey === 'string' &&
    candidate.idempotencyKey.length > 0 &&
    typeof candidate.input === 'object' &&
    candidate.input !== null
  );
}

export function loadPendingManualLoanCreation(userId: string): PendingManualLoanCreation | null {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isPending(parsed) ? parsed : null;
  } catch {
    // Unreadable storage cannot be written either, so persistPendingManualLoanCreation will refuse
    // to authorize any new request — reporting "nothing pending" here cannot lead to a send.
    return null;
  }
}

/**
 * Makes `pending` durable and PROVES it, or throws PendingCreationPersistenceError. Callers must
 * not send a create request unless this returns.
 *
 * Round 12 remediation: this used to swallow storage failures and fall back to an in-memory copy
 * while the request went out anyway. That copy dies with the page, so an ambiguous failure followed
 * by a reload lost the key and the next attempt could duplicate the loan. Now the exact serialized
 * record must read back identically from localStorage before a request is allowed. A record that is
 * already stored verbatim (a retry of an attempt that was persisted earlier) is accepted without
 * rewriting, so a retry still works when storage has since become full.
 */
export function persistPendingManualLoanCreation(userId: string, pending: PendingManualLoanCreation): void {
  const key = storageKey(userId);
  const serialized = JSON.stringify(pending);
  try {
    if (localStorage.getItem(key) !== serialized) {
      localStorage.setItem(key, serialized);
    }
    if (localStorage.getItem(key) !== serialized) {
      throw new PendingCreationPersistenceError('stored value did not read back identically');
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new PendingCreationPersistenceError(
      `This browser isn't letting the app save data on this device (${reason}), so the loan was not sent — ` +
        'without that, a failed save could not be safely retried. Turn off private browsing or allow site data, then try again.'
    );
  }
}

/** Removes the record once the server has confirmed the attempt's outcome — and only if it is still
 *  the attempt identified by `idempotencyKey`, so a late confirmation for an older attempt never
 *  erases a newer one. Best-effort: if removal fails the record survives, and retrying it only
 *  replays the already-confirmed result. */
export function clearPendingManualLoanCreation(userId: string, idempotencyKey: string): void {
  const current = loadPendingManualLoanCreation(userId);
  if (current === null || current.idempotencyKey !== idempotencyKey) return;
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // See doc comment.
  }
}
