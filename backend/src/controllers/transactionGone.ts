import type { Response } from 'express';
import * as dataService from '../services/dataService';

/**
 * Pending → posted continuity (design §8): a mutation whose transaction is gone is not simply a 404.
 * If Plaid replaced the pending row with a posted one, the client is told which row now holds its
 * state (409 `transaction_superseded`, with the posted row) so it can re-target; if Plaid withdrew the
 * pending row and it has not (yet) posted, the earlier changes are held in the carry-over and the edit
 * is refused with an explanation (409 `transaction_pending_removed`). The lookup is scoped to the
 * signed-in user: another user's row id falls through to the same 404 as an unknown id, so nothing
 * about other users' rows is ever revealed.
 *
 * Shared by every transaction mutation controller — category, approval, splits, and the manual-loan
 * payment edits (principal, unlink) — so a posting race is answered identically wherever it is lost.
 */
export async function respondTransactionGone(res: Response, userId: string, transactionId: string): Promise<void> {
  const carryover = await dataService.findTransactionCarryover(userId, transactionId);
  if (carryover?.status === 'superseded') {
    const posted = await dataService.getTransactionItemForUser(userId, carryover.postedTransactionId);
    res.status(409).json({
      error: 'This pending transaction has posted. Apply the change to the posted transaction instead.',
      code: 'transaction_superseded',
      superseded_by: posted,
    });
    return;
  }
  if (carryover?.status === 'pending_removed') {
    res.status(409).json({
      error: 'Your bank withdrew this pending transaction. If it posts, your earlier changes will carry over.',
      code: 'transaction_pending_removed',
    });
    return;
  }
  res.status(404).json({ error: 'Transaction not found' });
}
