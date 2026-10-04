import * as plaidService from './plaidService';
import * as dataService from './dataService';
import * as loansService from './loans';
import { reconcileRelationalRoles, repairExistingRelationalRoles } from './roleReconciliation';
import { summarizeErrorSafely } from './errorSanitizer';
import { evaluateCardPaymentsAfterSync } from './cardPaymentEvaluation';

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
 * `linkNewTransactionsToManualLoans` re-derives its candidates from Plaid's own `added` ids fresh
 * on every attempt (Round 6 remediation, blocker 5) rather than from our own insert/update
 * classification, so a link that failed in an earlier attempt is retried rather than silently
 * skipped once the row is no longer a "new insert."
 * A reconciliation failure here is intentionally NOT caught — it propagates to the caller (the
 * manual-sync endpoint surfaces it as a failed, retryable request; the webhook receiver logs it
 * and lets the next natural webhook/manual sync for this item retry, per its own existing
 * fire-and-forget error handling — see webhookController.ts).
 *
 * The sync is NOT one atomic transaction: each step below commits on its own. When a later step fails,
 * the earlier steps' committed writes stay committed. The failure boundaries are:
 * - Before the cursor advances (Plaid, the batch, the status transition, reconciliation, the repair
 *   sweep, or the cursor write itself): the error propagates and the cursor is normally unadvanced,
 *   so the next sync re-delivers the batch. A failed or uncertain cursor write (the request may have
 *   reached the database even though the client saw an error) is not guaranteed to leave the cursor
 *   unchanged.
 * - After the cursor advances (recording last_synced_at): the error still propagates, but the cursor
 *   has already moved on.
 * - Already best-effort (caught here or internally): loan auto-linking, the carry-over sweep, and the
 *   recurring-stream refresh.
 * - Card-payment matching evaluation (Phase B 2b-2a, off unless CARD_PAYMENT_SYNC_EVALUATION_ENABLED
 *   is "true", case-insensitive): best-effort, never throws, never gates or changes the cursor. It is attempted only on
 *   the success path, once every matching-input step has run. A sync that failed earlier leaves
 *   matching stale until a later successful sync evaluates — including a sync with no new transactions,
 *   so an empty batch still attempts it.
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
  const { touchedTransactionIds } = await dataService.applyTransactionChanges({
    userId: item.user_id,
    added,
    modified,
    removed,
    accountIdByPlaidId,
  });
  // Plaid accepted the credential, so a stale login_required/credential_error flag is cleared — but
  // only through the conditional transition: a sync that was already running when the item was
  // revoked or started removing must not write 'active' over that (itemStatus.ts).
  await dataService.transitionItemStatus(item.id, 'synced');

  // Best-effort (wrapped internally by linkNewTransactionsToManualLoans) — auto-linking loan
  // payments shouldn't fail the sync that triggered it. Candidates are re-derived from Plaid's own
  // `added` ids (Round 6 remediation, blocker 5), not from `insertedTransactions` — a link that
  // fails in one attempt is retried on the next, since Plaid keeps reporting the same `added`
  // composition for an unadvanced cursor even though our OWN insert/update classification of the
  // same rows changes between attempts. The REPAIR SWEEP this auto-linking could necessitate is
  // deliberately NOT this function's responsibility (see the `added.length > 0` branch below) —
  // Round 4 remediation §7 found that gating the sweep on "did THIS invocation itself create a
  // new link" breaks retry: once a link from attempt 1 persists, the linked transaction is no
  // longer a fresh insert on a retry, so nothing would ever re-trigger its repair.
  await loansService.linkNewTransactionsToManualLoans(
    item.user_id,
    [...added, ...modified].map((t) => t.transaction_id)
  );

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
  await dataService.recordItemSyncedAt(item.id);

  // Pending → posted continuity housekeeping (design §7): carry-overs that expired unconsumed (the
  // pending transaction never posted) and consumed ones past their audit window. Best-effort — the
  // sync's own correctness never depends on it.
  try {
    await dataService.sweepTransactionCarryovers(item.user_id);
  } catch (err) {
    console.error(`Failed to sweep transaction carry-overs for item ${item.id}:`, summarizeErrorSafely(err));
  }

  // Card-payment matching (Financial Semantics Phase B, packet 2b-2a; CARD_PAYMENT_PAIRING_DESIGN.md
  // §3.7). This is one evaluation of the whole user, run after EVERY matching-input step above: the
  // batch, loan auto-linking, reconciliation, the repair sweep, and the carry-over sweep (whose deletes
  // are inputs too). It still runs when the sweep failed above. It runs before the recurring-stream
  // refresh, which is not an input, so matching never waits on that Plaid request. It is a no-op unless
  // the flag is on, never throws, and never touches the cursor, the sync's response or any input. Its
  // outcome is logged inside, deliberately not returned: success describes that one evaluation, not "fresh
  // after this sync".
  await evaluateCardPaymentsAfterSync(item.user_id);

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
