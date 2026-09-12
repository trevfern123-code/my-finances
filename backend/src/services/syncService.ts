import * as plaidService from './plaidService';
import * as dataService from './dataService';
import * as loansService from './loans';
import { reconcileRelationalRoles } from './roleReconciliation';
import { summarizeErrorSafely } from './errorSanitizer';

/**
 * Syncs one Plaid item's transactions and advances its cursor. Shared by the authenticated
 * manual-sync endpoint and the webhook receiver so both paths behave identically.
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
  await dataService.updateItemCursor(item.id, cursor);
  await dataService.setItemStatus(item.id, 'active');

  // Best-effort (wrapped internally by linkNewTransactionsToManualLoans) — auto-linking loan
  // payments shouldn't fail the sync that triggered it.
  await loansService.linkNewTransactionsToManualLoans(item.user_id, insertedTransactions);

  // Financial Semantics Foundation Phase A, stage 2 (see roleReconciliation.ts's own doc
  // comment): runs immediately after this batch (and any loan auto-linking, which can itself
  // change a row's role) has committed. Best-effort — a failure here shouldn't fail the sync that
  // triggered it, the same reasoning already applied to recurring-stream refresh below. No
  // existing financial calculation reads any of this yet (Phase B+ work).
  try {
    await reconcileRelationalRoles(item.user_id, touchedTransactionIds);
  } catch (err) {
    console.error(`Failed to reconcile relational transaction roles for user ${item.user_id}:`, summarizeErrorSafely(err));
  }

  // Best-effort: recurring-stream detection is a separate Plaid call and a nice-to-have, not
  // core to syncing transactions — a failure here shouldn't fail the sync that triggered it.
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
