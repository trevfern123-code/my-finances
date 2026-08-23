import * as plaidService from './plaidService';
import * as dataService from './dataService';

/**
 * Syncs one Plaid item's transactions and advances its cursor. Shared by the authenticated
 * manual-sync endpoint and the webhook receiver so both paths behave identically.
 */
export async function syncItemTransactions(item: {
  id: string;
  access_token: string;
  transactions_cursor: string | null;
}) {
  const { added, modified, removed, cursor } = await plaidService.syncTransactions(
    item.access_token,
    item.transactions_cursor
  );

  const accountIdByPlaidId = await dataService.getAccountIdMapForItem(item.id);
  await dataService.applyTransactionChanges({ added, modified, removed, accountIdByPlaidId });
  await dataService.updateItemCursor(item.id, cursor);
  await dataService.setItemStatus(item.id, 'active');

  return { added: added.length, modified: modified.length, removed: removed.length };
}
