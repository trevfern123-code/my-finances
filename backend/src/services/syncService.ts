import * as plaidService from './plaidService';
import * as dataService from './dataService';
import * as loansService from './loans';
import { reconcileRelationalRoles, repairExistingRelationalRoles } from './roleReconciliation';
import { summarizeErrorSafely } from './errorSanitizer';

/**
 * Syncs one Plaid item's transactions and advances its cursor. Shared by the authenticated
 * manual-sync endpoint and the webhook receiver so both paths behave identically.
 *
 * Cursor ordering (Financial Semantics Foundation Phase A, remediation round 2): the cursor is
 * deliberately advanced LAST, only once semantic reconciliation for this batch has actually
 * succeeded — not immediately after persisting. Reconciliation is what resolves
 * transfer/refund relational evidence for the rows just written; if it fails and the cursor had
 * already advanced anyway, that evidence could go permanently unresolved (Plaid's cursor-based
 * sync never re-delivers a batch once its cursor has moved past it). Leaving the cursor
 * unadvanced on a reconciliation failure means the *next* sync attempt for this item —
 * triggered either by the user's own "Sync transactions" action or by Plaid's next webhook
 * delivery for this item — naturally re-requests and reprocesses this exact batch from Plaid,
 * with no new retry machinery needed: `applyTransactionChanges` already upserts by
 * `plaid_transaction_id` (a retry updates the same rows rather than duplicating them), and
 * `linkNewTransactionsToManualLoans` is a no-op on a retry (the rows are no longer new inserts,
 * so it does no work) — the retry is safe purely because both of those were already idempotent.
 * A reconciliation failure here is intentionally NOT caught — it propagates to the caller (the
 * manual-sync endpoint surfaces it as a failed, retryable request; the webhook receiver logs it
 * and lets the next natural webhook/manual sync for this item retry, per its own existing
 * fire-and-forget error handling — see webhookController.ts).
 */
export async function syncItemTransactions(item: {
  id: string;
  user_id: string;
  access_token: string;
  transactions_cursor: string | null;
}) {
  const { added, modified, removed, cursor } = await plaidService.syncTransactions(
    item.access_token,
    item.transactions_cursor
  );

  const accountIdByPlaidId = await dataService.getAccountIdMapForItem(item.id);
  const { insertedTransactions, touchedTransactionIds } = await dataService.applyTransactionChanges({
    userId: item.user_id,
    added,
    modified,
    removed,
    accountIdByPlaidId,
  });
  await dataService.setItemStatus(item.id, 'active');

  // Best-effort (wrapped internally by linkNewTransactionsToManualLoans) — auto-linking loan
  // payments shouldn't fail the sync that triggered it, and per-transaction linking is naturally
  // idempotent on a retry (a row already linked from a prior attempt is no longer a fresh insert,
  // so re-linking it does no work). The REPAIR SWEEP this auto-linking could necessitate is
  // deliberately NOT this function's responsibility (see the `added.length > 0` branch below) —
  // Round 4 remediation §7 found that gating the sweep on "did THIS invocation itself create a
  // new link" breaks retry: once a link from attempt 1 persists, the linked transaction is no
  // longer a fresh insert on a retry, so nothing would ever re-trigger its repair.
  await loansService.linkNewTransactionsToManualLoans(item.user_id, insertedTransactions);

  // Financial Semantics Foundation Phase A, stage 2 (see roleReconciliation.ts's own doc
  // comment) — deliberately NOT wrapped in try/catch (see this function's own doc comment for
  // why a failure here must gate the cursor advance below rather than being swallowed).
  await reconcileRelationalRoles(item.user_id, touchedTransactionIds);

  // Round 3 remediation §2/§3/§4/§6, retry-safety corrected in Round 4 remediation §7: a
  // modified/removed transaction, OR a newly-added transaction that just got auto-linked to a
  // manual loan, may invalidate an EXISTING account_pair_match/refund_match row that depended on
  // its OLD state (or on its now-deleted existence, or on it not having been a debt_payment
  // before) — re-validate every existing relational row against CURRENT data before advancing
  // the cursor. Also deliberately NOT wrapped in try/catch, and deliberately gated on "did this
  // batch contain ANY activity Plaid itself reports" rather than on our own dedup state (whether
  // `insertedTransactions` came back non-empty) — Plaid re-reports the identical added/
  // modified/removed composition on every retry for the same (unadvanced) cursor, so this gate is
  // retry-safe even though our OWN insert/update classification of the same rows can change
  // between attempts (a row inserted in attempt 1 is no longer "new" in attempt 2, but Plaid's
  // `added` array still lists it, so the sweep still re-triggers and still repairs it).
  if (added.length > 0 || modified.length > 0 || removed.length > 0) {
    await repairExistingRelationalRoles(item.user_id);
  }

  await dataService.updateItemCursor(item.id, cursor);

  // Best-effort: recurring-stream detection is a separate Plaid call and a nice-to-have, not
  // core to syncing transactions — a failure here shouldn't fail the sync that triggered it. Runs
  // after the cursor advance since it has no bearing on transaction-semantics correctness.
  try {
    const { inflowStreams, outflowStreams } = await plaidService.getRecurringStreams(item.access_token);
    const streams = [
      ...inflowStreams.map((stream) => ({ direction: 'inflow' as const, stream })),
      ...outflowStreams.map((stream) => ({ direction: 'outflow' as const, stream })),
    ];
    await dataService.upsertRecurringStreams(item.id, streams, accountIdByPlaidId);
  } catch (err) {
    // Never log the raw error — plaidService.getRecurringStreams is a real Plaid API call, and a
    // rejected request's .config carries the outgoing request body (access_token included; see
    // errorSanitizer.ts).
    console.error(`Failed to refresh recurring streams for item ${item.id}:`, summarizeErrorSafely(err));
  }

  return { added: added.length, modified: modified.length, removed: removed.length };
}
