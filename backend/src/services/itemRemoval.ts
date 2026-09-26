import * as dataService from './dataService';
import * as plaidService from './plaidService';
import * as netWorthService from './netWorth';
import { classifyItemRemoveError } from './plaidErrors';
import { reconcileRelationalRoles, repairExistingRelationalRoles } from './roleReconciliation';
import { PlaidCredentialError } from './tokenEncryption';
import { summarizeErrorSafely } from './errorSanitizer';
import type { ItemRemovalRecord, LoanAdjustment } from './dataService';

/**
 * Linked Institution Management V1: destructive removal of one linked institution (Plaid item).
 *
 * The persisted state machine (20260926120000_linked_institution_management.sql) is the source of
 * truth; this drives it as far as it can in one request and resumes from whatever state is recorded,
 * so a retry, a double submit or a request cut short by a reload all converge on the same operation:
 *
 *   requested      -> call Plaid /item/remove. Success or ITEM_NOT_FOUND -> plaid_removed. A timeout,
 *                     network error or 5xx is an UNKNOWN outcome: recorded, stays requested, nothing
 *                     local is touched; the next attempt simply calls Plaid again (a removal that did
 *                     succeed then answers ITEM_NOT_FOUND).
 *   plaid_removed  -> remove_plaid_item_local: one transaction restores every manual-loan balance by
 *                     exactly the recorded applied amounts of the item's linked transactions and deletes
 *                     the item (cascading to accounts, transactions, splits, streams, liabilities).
 *   cleaned        -> follow-ups that cannot run inside that transaction (the classifier is TypeScript):
 *                     re-validate relational roles of the surviving rows (their transfer/refund partner
 *                     may have been deleted), forward-reconcile the rows that sweep reset, and recompute
 *                     today's net-worth snapshot. Then reconciled.
 *
 * Local data is never deleted before Plaid has confirmed the Item is gone, and an operation is never
 * cancelled or restarted — only resumed.
 */

export interface ItemRemovalView {
  item_id: string;
  institution_name: string | null;
  status: ItemRemovalRecord['status'];
  /** True once every follow-up finished — the removal is complete. */
  finished: boolean;
  attempts: number;
  /** Why the last Plaid attempt did not confirm removal (null once it did). */
  last_outcome: ItemRemovalRecord['last_outcome'];
  last_error_code: string | null;
  plaid_outcome: ItemRemovalRecord['plaid_outcome'];
  loan_adjustments: LoanAdjustment[] | null;
  deleted_counts: Record<string, number> | null;
  requested_at: string;
  cleaned_at: string | null;
}

/** What the API returns about an operation. Never includes user ids, the Plaid item id or the digest. */
export function toRemovalView(record: ItemRemovalRecord): ItemRemovalView {
  return {
    item_id: record.item_id,
    institution_name: record.institution_name,
    status: record.status,
    finished: record.status === 'cleaned' && record.reconciled_at !== null,
    attempts: record.attempts,
    last_outcome: record.last_outcome,
    last_error_code: record.last_error_code,
    plaid_outcome: record.plaid_outcome,
    loan_adjustments: record.loan_adjustments,
    deleted_counts: record.deleted_counts,
    requested_at: record.requested_at,
    cleaned_at: record.cleaned_at,
  };
}

export type RunItemRemovalResult =
  | { kind: 'not_found' }
  | { kind: 'preview_stale' }
  | { kind: 'connection_needs_attention' }
  | { kind: 'manual_loan_reconciliation_required' }
  /** A transaction of this item is linked to a manual loan that is not this user's. */
  | { kind: 'manual_loan_ownership_mismatch' }
  /** `removal.finished` tells complete from stopped-at-a-retryable-point. */
  | { kind: 'progressed'; removal: ItemRemovalView };

/** A step after begin failed unexpectedly (database, repair sweep, snapshot). The operation's persisted
 *  state is intact and retryable; `removal` is that state as last read. */
export class ItemRemovalIncompleteError extends Error {
  constructor(
    readonly removal: ItemRemovalView,
    readonly cause: unknown
  ) {
    super('The institution removal did not finish');
    this.name = 'ItemRemovalIncompleteError';
  }
}

async function readRemoval(userId: string, itemId: string): Promise<ItemRemovalRecord> {
  const removal = await dataService.getItemRemoval(userId, itemId);
  if (!removal) throw new Error(`Institution removal for item ${itemId} disappeared`);
  return removal;
}

/**
 * Starts (with the confirmed preview's digest) or resumes the removal of `itemId` for `userId`, and
 * drives it as far as possible. The digest is only checked when starting a new operation.
 */
export async function runItemRemoval(userId: string, itemId: string, previewDigest: string | null): Promise<RunItemRemovalResult> {
  let removal = await dataService.getItemRemoval(userId, itemId);

  if (!removal) {
    // Refuse up front when the credential cannot be read: without it Plaid removal is impossible, and
    // V1 never removes locally alone (that would leave a billed, orphaned Item at Plaid).
    let item;
    try {
      item = await dataService.getPlaidItemForUser(itemId, userId);
    } catch (err) {
      if (err instanceof PlaidCredentialError) {
        console.error(`Plaid credential error before removing item ${itemId}:`, err.name);
        await dataService.transitionItemStatus(itemId, 'credential_error');
        return { kind: 'connection_needs_attention' };
      }
      throw err;
    }
    if (!item) return { kind: 'not_found' };

    const begun = await dataService.beginItemRemoval(userId, itemId, previewDigest);
    if (begun.outcome !== 'started' && begun.outcome !== 'existing') return { kind: begun.outcome };
    removal = begun.removal;
  }

  try {
    if (removal.status === 'requested') {
      removal = await removeAtPlaid(userId, itemId);
      if (removal.status === 'requested') return { kind: 'progressed', removal: toRemovalView(removal) };
    }

    if (removal.status === 'plaid_removed') {
      await dataService.removeItemLocally(userId, itemId);
      removal = await readRemoval(userId, itemId);
    }

    if (removal.status === 'cleaned' && removal.reconciled_at === null) {
      await runRemovalFollowUps(userId);
      await dataService.markItemRemovalReconciled(userId, itemId);
      removal = await readRemoval(userId, itemId);
    }
  } catch (err) {
    const latest = await dataService.getItemRemoval(userId, itemId).catch(() => null);
    throw new ItemRemovalIncompleteError(toRemovalView(latest ?? removal), err);
  }

  return { kind: 'progressed', removal: toRemovalView(removal) };
}

/** One Plaid /item/remove attempt for a requested operation, recorded whatever its outcome. */
async function removeAtPlaid(userId: string, itemId: string): Promise<ItemRemovalRecord> {
  // begin_plaid_item_removal refused these under its lock; they are re-checked before EVERY Plaid
  // attempt (a retry of a requested operation included), so the irreversible Plaid removal never
  // happens when the local cleanup is already known to be impossible. No write path creates either
  // condition, so this only fires if data was written some other way.
  const blocker = await dataService.getItemRemovalBlocker(userId, itemId);
  if (blocker) {
    console.error(`Institution removal for item ${itemId} stopped before Plaid: ${blocker}`);
    return dataService.recordItemRemovalAttempt(userId, itemId, 'needs_attention', blocker.toUpperCase());
  }

  let accessToken: string;
  try {
    const item = await dataService.getPlaidItemForUser(itemId, userId);
    if (!item) throw new Error(`Item ${itemId} is missing while its removal is only requested`);
    accessToken = item.access_token;
  } catch (err) {
    if (err instanceof PlaidCredentialError) {
      // The token became unreadable after the removal began: Plaid cannot be called. The operation
      // stays requested (the item stays frozen as removing); see README "Linked institution management".
      console.error(`Plaid credential error removing item ${itemId}:`, err.name);
      return dataService.recordItemRemovalAttempt(userId, itemId, 'needs_attention', 'CREDENTIAL_UNREADABLE');
    }
    throw err;
  }

  try {
    await plaidService.removeItem(accessToken);
  } catch (err) {
    const classified = classifyItemRemoveError(err);
    if (classified.outcome !== 'already_removed') {
      // Never log the raw error: a Plaid/Axios rejection carries the outgoing request (access token).
      console.error(`Plaid /item/remove did not confirm removal of item ${itemId}:`, summarizeErrorSafely(err));
    }
    return dataService.recordItemRemovalAttempt(userId, itemId, classified.outcome, classified.code);
  }
  return dataService.recordItemRemovalAttempt(userId, itemId, 'removed', null);
}

/**
 * After the item's rows are gone: surviving rows whose transfer counterpart or refund original was
 * deleted are reset by the repair sweep (deletion-safe by design); the rows it reset get a forward
 * pass, since they may now pair with another valid partner — the same two directions manual-loan
 * deletion runs. Then today's net-worth snapshot (historical snapshots stay as recorded). All
 * idempotent: a retry reruns them.
 */
export async function runRemovalFollowUps(userId: string): Promise<void> {
  const repaired = await repairExistingRelationalRoles(userId);
  const resetIds = [...new Set(repaired.resolved.map((r) => r.id))];
  if (resetIds.length > 0) {
    await reconcileRelationalRoles(userId, resetIds);
  }
  await netWorthService.recordSnapshotForUser(userId);
}
