import type { ManualLoanInput } from './api';

/**
 * A manual-loan creation that has been sent at least once but not yet confirmed successful.
 *
 * Kept OUTSIDE the create form, scoped to the authenticated user, and persisted across reloads,
 * because a create failure is ambiguous: the backend commits the loan before running
 * backfillMatchesForLoan, so an error response (or a network drop, or the page going away
 * mid-request) can mean the loan already exists. The only safe retry resends the IDENTICAL
 * idempotency key and payload — which the server replays onto the loan it already created. If the
 * key lived only in the form's own state, any unmount (Cancel, switching tabs, a reload, an auth
 * remount) would discard it and the user's natural retry would mint a new key and create a
 * duplicate. The entry is removed only once a create using its key is confirmed successful, or when
 * the user explicitly discards the attempt.
 */
export interface PendingManualLoanCreation {
  idempotencyKey: string;
  input: ManualLoanInput;
}

const STORAGE_PREFIX = 'myfinances.pendingManualLoanCreation.';

// Fallback for when localStorage is unavailable (private browsing, quota, disabled storage): the
// pending attempt then at least survives unmounts within this page's lifetime, though not a reload.
const memoryFallback = new Map<string, PendingManualLoanCreation>();

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
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw);
      return isPending(parsed) ? parsed : null;
    }
  } catch {
    // Unreadable or corrupt storage — fall through to the in-memory copy.
  }
  return memoryFallback.get(userId) ?? null;
}

export function savePendingManualLoanCreation(userId: string, pending: PendingManualLoanCreation): void {
  memoryFallback.set(userId, pending);
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(pending));
  } catch {
    // See memoryFallback.
  }
}

/** Clears the pending attempt — but only if it is still the one identified by `idempotencyKey`,
 *  when given, so a late success for an older attempt can never erase a newer one. */
export function clearPendingManualLoanCreation(userId: string, idempotencyKey?: string): void {
  const current = loadPendingManualLoanCreation(userId);
  if (idempotencyKey !== undefined && current !== null && current.idempotencyKey !== idempotencyKey) return;
  memoryFallback.delete(userId);
  try {
    localStorage.removeItem(storageKey(userId));
  } catch {
    // See memoryFallback.
  }
}
