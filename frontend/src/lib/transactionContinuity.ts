import type { TransactionItem } from './api';

/**
 * Pending → posted continuity (design §8, §9): how the loaded transaction list changes when a mutation
 * is refused because Plaid has since replaced or withdrawn the pending row it targeted.
 *
 * - `transaction_superseded`: the server sends the posted row (`superseded_by`). The dead pending row is
 *   replaced by it; if that posted row is already loaded (a refresh landed in between), the pending row
 *   is simply dropped and the loaded copy is refreshed in place — an ID-deduplicating upsert, so a row
 *   never appears twice. Without a body (it should not happen), the pending row is dropped.
 * - `transaction_pending_removed`: the bank withdrew the pending transaction; the row is dropped. Its
 *   carried state is held server-side and applied if it posts.
 * - anything else: not a continuity outcome; the caller reports the error as before.
 *
 * Pure so every branch is directly testable without rendering App.
 */
export interface TransactionGoneResolution {
  transactions: TransactionItem[];
  message: string;
}

export function resolveTransactionGone(
  transactions: TransactionItem[],
  transactionId: string,
  err: unknown
): TransactionGoneResolution | null {
  const code = (err as { code?: string } | null)?.code;
  const message = err instanceof Error ? err.message : '';

  if (code === 'transaction_superseded') {
    const posted = (err as { superseded_by?: TransactionItem | null }).superseded_by ?? null;
    let next = transactions.filter((t) => t.id !== transactionId);
    if (posted) {
      next = next.some((t) => t.id === posted.id)
        ? next.map((t) => (t.id === posted.id ? posted : t))
        : insertKeepingPosition(transactions, transactionId, posted);
    }
    return { transactions: next, message: message || 'This pending transaction has posted.' };
  }

  if (code === 'transaction_pending_removed') {
    return {
      transactions: transactions.filter((t) => t.id !== transactionId),
      message: message || 'Your bank withdrew this pending transaction.',
    };
  }

  return null;
}

/** The posted row takes the pending row's slot (the feed is date-ordered and both dates are close),
 *  and any other copy of the posted id is removed so the result holds it exactly once. */
function insertKeepingPosition(transactions: TransactionItem[], pendingId: string, posted: TransactionItem): TransactionItem[] {
  const result: TransactionItem[] = [];
  let placed = false;
  for (const t of transactions) {
    if (t.id === pendingId) {
      if (!placed) {
        result.push(posted);
        placed = true;
      }
      continue;
    }
    if (t.id === posted.id) continue;
    result.push(t);
  }
  if (!placed) result.unshift(posted);
  return result;
}
