import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncItemTransactions } from './syncService';

const mockSyncTransactions = vi.hoisted(() => vi.fn());
const mockGetRecurringStreams = vi.hoisted(() => vi.fn());
vi.mock('./plaidService', () => ({
  syncTransactions: mockSyncTransactions,
  getRecurringStreams: mockGetRecurringStreams,
}));

const mockGetAccountIdMapForItem = vi.hoisted(() => vi.fn());
const mockApplyTransactionChanges = vi.hoisted(() => vi.fn());
const mockUpdateItemCursor = vi.hoisted(() => vi.fn());
const mockTransitionItemStatus = vi.hoisted(() => vi.fn());
const mockRecordItemSyncedAt = vi.hoisted(() => vi.fn());
const mockUpsertRecurringStreams = vi.hoisted(() => vi.fn());
const mockSweepTransactionCarryovers = vi.hoisted(() => vi.fn());
vi.mock('./dataService', () => ({
  getAccountIdMapForItem: mockGetAccountIdMapForItem,
  applyTransactionChanges: mockApplyTransactionChanges,
  updateItemCursor: mockUpdateItemCursor,
  transitionItemStatus: mockTransitionItemStatus,
  recordItemSyncedAt: mockRecordItemSyncedAt,
  upsertRecurringStreams: mockUpsertRecurringStreams,
  sweepTransactionCarryovers: mockSweepTransactionCarryovers,
}));

const mockEvaluateCardPaymentsAfterSync = vi.hoisted(() => vi.fn());
vi.mock('./cardPaymentEvaluation', () => ({
  evaluateCardPaymentsAfterSync: mockEvaluateCardPaymentsAfterSync,
}));

const mockLinkNewTransactionsToManualLoans = vi.hoisted(() => vi.fn());
vi.mock('./loans', () => ({
  linkNewTransactionsToManualLoans: mockLinkNewTransactionsToManualLoans,
}));

const mockReconcileRelationalRoles = vi.hoisted(() => vi.fn());
const mockRepairExistingRelationalRoles = vi.hoisted(() => vi.fn());
vi.mock('./roleReconciliation', () => ({
  reconcileRelationalRoles: mockReconcileRelationalRoles,
  repairExistingRelationalRoles: mockRepairExistingRelationalRoles,
}));

const item = {
  id: 'item-row-1',
  user_id: 'user-1',
  access_token: 'access-token-1',
  transactions_cursor: 'old-cursor',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAccountIdMapForItem.mockResolvedValue(new Map([['plaid-acc-1', 'account-row-1']]));
  mockSyncTransactions.mockResolvedValue({ added: [], modified: [], removed: [], cursor: 'new-cursor' });
  mockApplyTransactionChanges.mockResolvedValue({ insertedTransactions: [], touchedTransactionIds: [] });
  mockGetRecurringStreams.mockResolvedValue({ inflowStreams: [], outflowStreams: [] });
  mockReconcileRelationalRoles.mockResolvedValue(undefined);
  mockRepairExistingRelationalRoles.mockResolvedValue(undefined);
  mockSweepTransactionCarryovers.mockResolvedValue(undefined);
  mockEvaluateCardPaymentsAfterSync.mockResolvedValue('disabled');
});

describe('syncItemTransactions', () => {
  it('passes the item access token and existing cursor to Plaid', async () => {
    await syncItemTransactions(item);

    expect(mockSyncTransactions).toHaveBeenCalledWith('access-token-1', 'old-cursor');
  });

  it('applies the returned changes and advances the cursor', async () => {
    const added = [{ transaction_id: 't1' }];
    const modified = [{ transaction_id: 't2' }];
    const removed = [{ transaction_id: 't3' }];
    mockSyncTransactions.mockResolvedValue({ added, modified, removed, cursor: 'new-cursor' });

    await syncItemTransactions(item);

    expect(mockApplyTransactionChanges).toHaveBeenCalledWith({
      userId: 'user-1',
      added,
      modified,
      removed,
      accountIdByPlaidId: await mockGetAccountIdMapForItem.mock.results[0].value,
    });
    expect(mockUpdateItemCursor).toHaveBeenCalledWith('item-row-1', 'new-cursor');
  });

  it('clears a stale login_required through the conditional synced transition — never a blind write of active', async () => {
    await syncItemTransactions(item);
    expect(mockTransitionItemStatus).toHaveBeenCalledWith('item-row-1', 'synced');
  });

  it('records last_synced_at only once the cursor has advanced (a genuinely completed sync)', async () => {
    const order: string[] = [];
    mockUpdateItemCursor.mockImplementation(async () => void order.push('cursor'));
    mockRecordItemSyncedAt.mockImplementation(async () => void order.push('synced_at'));
    await syncItemTransactions(item);
    expect(order).toEqual(['cursor', 'synced_at']);
    expect(mockRecordItemSyncedAt).toHaveBeenCalledWith('item-row-1');
  });

  it('does not record last_synced_at when the sync fails before its cursor advances', async () => {
    mockReconcileRelationalRoles.mockRejectedValueOnce(new Error('reconcile failed'));
    await expect(syncItemTransactions(item)).rejects.toThrow('reconcile failed');
    expect(mockUpdateItemCursor).not.toHaveBeenCalled();
    expect(mockRecordItemSyncedAt).not.toHaveBeenCalled();
  });

  it('returns counts, not the raw arrays', async () => {
    mockSyncTransactions.mockResolvedValue({
      added: [{}, {}],
      modified: [{}],
      removed: [{}, {}, {}],
      cursor: 'c',
    });

    const result = await syncItemTransactions(item);

    expect(result).toEqual({ added: 2, modified: 1, removed: 3 });
  });

  it('propagates a Plaid error without applying changes or marking the item active (the caller classifies it)', async () => {
    const err = new Error('ITEM_LOGIN_REQUIRED');
    mockSyncTransactions.mockRejectedValue(err);

    await expect(syncItemTransactions(item)).rejects.toThrow('ITEM_LOGIN_REQUIRED');
    expect(mockTransitionItemStatus).not.toHaveBeenCalled();
    expect(mockApplyTransactionChanges).not.toHaveBeenCalled();
  });

  it('fetches and upserts recurring streams, tagging inflow/outflow direction', async () => {
    const inflow = { stream_id: 'in-1', account_id: 'plaid-acc-1' };
    const outflow = { stream_id: 'out-1', account_id: 'plaid-acc-1' };
    mockGetRecurringStreams.mockResolvedValue({ inflowStreams: [inflow], outflowStreams: [outflow] });

    await syncItemTransactions(item);

    expect(mockGetRecurringStreams).toHaveBeenCalledWith('access-token-1');
    expect(mockUpsertRecurringStreams).toHaveBeenCalledWith(
      'item-row-1',
      [
        { direction: 'inflow', stream: inflow },
        { direction: 'outflow', stream: outflow },
      ],
      await mockGetAccountIdMapForItem.mock.results[0].value
    );
  });

  it('does not let a recurring-streams failure fail the overall sync', async () => {
    mockGetRecurringStreams.mockRejectedValue(new Error('recurring endpoint down'));

    const result = await syncItemTransactions(item);

    expect(result).toEqual({ added: 0, modified: 0, removed: 0 });
    expect(mockTransitionItemStatus).toHaveBeenCalledWith('item-row-1', 'synced');
  });

  it("passes Plaid's own added+modified transaction ids to linkNewTransactionsToManualLoans (Round 6 remediation, blocker 5) — not our own insertedTransactions dedup, which changes between sync attempts", async () => {
    const added = [{ transaction_id: 'plaid-txn-1' }];
    const modified = [{ transaction_id: 'plaid-txn-2' }];
    mockSyncTransactions.mockResolvedValue({ added, modified, removed: [], cursor: 'new-cursor' });
    mockApplyTransactionChanges.mockResolvedValue({
      insertedTransactions: [{ id: 'txn-1', name: 'SoFi Payment', merchant_name: null, amount: 250 }],
      touchedTransactionIds: ['txn-1'],
    });

    await syncItemTransactions(item);

    expect(mockLinkNewTransactionsToManualLoans).toHaveBeenCalledWith('user-1', ['plaid-txn-1', 'plaid-txn-2']);
  });

  it('runs relational role reconciliation over exactly the transactions touched by this batch, after loan auto-linking', async () => {
    const insertedTransactions = [{ id: 'txn-1', name: 'Transfer', merchant_name: null, amount: 100 }];
    mockApplyTransactionChanges.mockResolvedValue({
      insertedTransactions,
      touchedTransactionIds: ['txn-1', 'txn-2'],
    });

    await syncItemTransactions(item);

    expect(mockReconcileRelationalRoles).toHaveBeenCalledWith('user-1', ['txn-1', 'txn-2']);
    expect(mockReconcileRelationalRoles.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockLinkNewTransactionsToManualLoans.mock.invocationCallOrder[0]
    );
  });

  describe('the relational repair sweep (Round 3 remediation §2/§3/§4/§6)', () => {
    it('runs repairExistingRelationalRoles when the batch contains a modified transaction', async () => {
      mockSyncTransactions.mockResolvedValue({ added: [], modified: [{ transaction_id: 't2' }], removed: [], cursor: 'new-cursor' });

      await syncItemTransactions(item);

      expect(mockRepairExistingRelationalRoles).toHaveBeenCalledWith('user-1');
      expect(mockRepairExistingRelationalRoles).toHaveBeenCalledTimes(1);
    });

    it('runs repairExistingRelationalRoles when the batch contains a removed transaction', async () => {
      mockSyncTransactions.mockResolvedValue({ added: [], modified: [], removed: [{ transaction_id: 't3' }], cursor: 'new-cursor' });

      await syncItemTransactions(item);

      expect(mockRepairExistingRelationalRoles).toHaveBeenCalledWith('user-1');
    });

    it('DOES run the sweep for a pure-insert batch (Round 4 remediation §7) — a newly-inserted row can get auto-linked to a manual loan, and gating the sweep on our OWN insert/update dedup (rather than on Plaid\'s own added/modified/removed report) breaks retry: an already-linked row is no longer "inserted" on a retry, so a narrower gate would never re-trigger its repair', async () => {
      mockSyncTransactions.mockResolvedValue({ added: [{ transaction_id: 't1' }], modified: [], removed: [], cursor: 'new-cursor' });

      await syncItemTransactions(item);

      expect(mockRepairExistingRelationalRoles).toHaveBeenCalledWith('user-1');
    });

    it('does NOT run the sweep when the batch is entirely empty', async () => {
      await syncItemTransactions(item);
      expect(mockRepairExistingRelationalRoles).not.toHaveBeenCalled();
    });

    it('a sweep failure propagates (a retryable sync failure) and does NOT advance the cursor, exactly like an ordinary reconciliation failure', async () => {
      mockSyncTransactions.mockResolvedValue({ added: [], modified: [{ transaction_id: 't2' }], removed: [], cursor: 'new-cursor' });
      mockRepairExistingRelationalRoles.mockRejectedValue(new Error('sweep failed'));

      await expect(syncItemTransactions(item)).rejects.toThrow('sweep failed');
      expect(mockUpdateItemCursor).not.toHaveBeenCalled();
    });

    it('runs the sweep AFTER the ordinary forward pass, before the cursor advances', async () => {
      mockSyncTransactions.mockResolvedValue({ added: [], modified: [{ transaction_id: 't2' }], removed: [], cursor: 'new-cursor' });

      await syncItemTransactions(item);

      expect(mockRepairExistingRelationalRoles.mock.invocationCallOrder[0]).toBeGreaterThan(
        mockReconcileRelationalRoles.mock.invocationCallOrder[0]
      );
      expect(mockRepairExistingRelationalRoles.mock.invocationCallOrder[0]).toBeLessThan(
        mockUpdateItemCursor.mock.invocationCallOrder[0]
      );
    });

    it('is retry-safe: retrying after a sweep failure re-triggers the sweep even though the DB already reflects the new values (Round 3 remediation §6)', async () => {
      mockSyncTransactions.mockResolvedValue({ added: [], modified: [{ transaction_id: 't2' }], removed: [], cursor: 'new-cursor' });
      mockRepairExistingRelationalRoles.mockRejectedValueOnce(new Error('transient failure')).mockResolvedValueOnce(undefined);

      await expect(syncItemTransactions(item)).rejects.toThrow('transient failure');
      expect(mockUpdateItemCursor).not.toHaveBeenCalled();

      // Retry: same old cursor, same Plaid batch — the sweep is gated purely on "did this batch
      // contain a modification," not on a same-attempt before/after comparison, so it re-runs and
      // this time succeeds, advancing the cursor exactly once.
      await syncItemTransactions(item);

      expect(mockRepairExistingRelationalRoles).toHaveBeenCalledTimes(2);
      expect(mockUpdateItemCursor).toHaveBeenCalledTimes(1);
    });
  });

  it('a reconciliation failure propagates (a retryable sync failure) and does NOT advance the cursor', async () => {
    mockReconcileRelationalRoles.mockRejectedValue(new Error('reconciliation query failed'));

    await expect(syncItemTransactions(item)).rejects.toThrow('reconciliation query failed');

    expect(mockUpdateItemCursor).not.toHaveBeenCalled();
  });

  it('cursor advances only after reconciliation has actually succeeded', async () => {
    mockApplyTransactionChanges.mockResolvedValue({
      insertedTransactions: [],
      touchedTransactionIds: ['txn-1'],
    });
    let reconciled = false;
    mockReconcileRelationalRoles.mockImplementation(async () => {
      reconciled = true;
    });
    mockUpdateItemCursor.mockImplementation(async () => {
      expect(reconciled).toBe(true);
    });

    await syncItemTransactions(item);

    expect(mockUpdateItemCursor).toHaveBeenCalledWith('item-row-1', 'new-cursor');
  });

  it('retrying after a reconciliation failure is safe: a retry reprocesses the same batch and advances the cursor exactly once, on the successful attempt', async () => {
    const added = [{ transaction_id: 't1' }];
    mockSyncTransactions.mockResolvedValue({ added, modified: [], removed: [], cursor: 'new-cursor' });
    mockApplyTransactionChanges.mockResolvedValue({
      insertedTransactions: [{ id: 'txn-1', name: 'Store', merchant_name: null, amount: 10 }],
      touchedTransactionIds: ['txn-1'],
    });
    mockReconcileRelationalRoles.mockRejectedValueOnce(new Error('transient failure')).mockResolvedValueOnce(undefined);

    await expect(syncItemTransactions(item)).rejects.toThrow('transient failure');
    expect(mockUpdateItemCursor).not.toHaveBeenCalled();

    // Retry with the SAME (unadvanced) cursor — applyTransactionChanges and loan auto-linking are
    // called again with the identical batch, exactly as a real retry (same old cursor) would
    // naturally re-request the same data from Plaid.
    await syncItemTransactions(item);

    expect(mockUpdateItemCursor).toHaveBeenCalledTimes(1);
    expect(mockUpdateItemCursor).toHaveBeenCalledWith('item-row-1', 'new-cursor');
  });

  describe('end-of-sync card-payment matching evaluation (Phase B 2b-2a)', () => {
    // vi.clearAllMocks keeps implementations: reset every mock these tests reconfigure.
    beforeEach(() => {
      mockUpdateItemCursor.mockReset().mockResolvedValue(undefined);
      mockRecordItemSyncedAt.mockReset().mockResolvedValue(undefined);
      mockLinkNewTransactionsToManualLoans.mockReset().mockResolvedValue(undefined);
      mockApplyTransactionChanges.mockReset().mockResolvedValue({ insertedTransactions: [], touchedTransactionIds: [] });
      mockReconcileRelationalRoles.mockReset().mockResolvedValue(undefined);
      mockRepairExistingRelationalRoles.mockReset().mockResolvedValue(undefined);
      mockSweepTransactionCarryovers.mockReset().mockResolvedValue(undefined);
      mockEvaluateCardPaymentsAfterSync.mockReset().mockResolvedValue('disabled');
      mockGetRecurringStreams.mockReset().mockResolvedValue({ inflowStreams: [], outflowStreams: [] });
    });

    /** Records the order of every step that matters for matching. */
    function recordOrder() {
      const order: string[] = [];
      mockApplyTransactionChanges.mockImplementation(async () => {
        order.push('batch');
        return { insertedTransactions: [], touchedTransactionIds: [] };
      });
      mockLinkNewTransactionsToManualLoans.mockImplementation(async () => void order.push('loan_links'));
      mockReconcileRelationalRoles.mockImplementation(async () => void order.push('reconcile'));
      mockRepairExistingRelationalRoles.mockImplementation(async () => void order.push('repair'));
      mockUpdateItemCursor.mockImplementation(async () => void order.push('cursor'));
      mockRecordItemSyncedAt.mockImplementation(async () => void order.push('synced_at'));
      mockSweepTransactionCarryovers.mockImplementation(async () => void order.push('carryover_sweep'));
      mockEvaluateCardPaymentsAfterSync.mockImplementation(async () => {
        order.push('evaluate');
        return 'evaluated';
      });
      mockGetRecurringStreams.mockImplementation(async () => {
        order.push('recurring');
        return { inflowStreams: [], outflowStreams: [] };
      });
      return order;
    }

    it('attempts exactly one evaluation, for the synced item\'s user (the wrapper evaluates the whole user)', async () => {
      await syncItemTransactions(item);
      expect(mockEvaluateCardPaymentsAfterSync).toHaveBeenCalledTimes(1);
      expect(mockEvaluateCardPaymentsAfterSync).toHaveBeenCalledWith('user-1');
    });

    it('runs after every matching-input step (batch, loan links, reconciliation, repair, cursor, carry-over sweep) and before the recurring-stream refresh', async () => {
      mockSyncTransactions.mockResolvedValue({ added: [{ transaction_id: 't1' }], modified: [], removed: [], cursor: 'new-cursor' });
      const order = recordOrder();
      await syncItemTransactions(item);
      expect(order).toEqual(['batch', 'loan_links', 'reconcile', 'repair', 'cursor', 'synced_at', 'carryover_sweep', 'evaluate', 'recurring']);
    });

    it('a caught carry-over sweep failure still reaches the evaluation', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockSweepTransactionCarryovers.mockRejectedValueOnce(new Error('sweep down'));
      const result = await syncItemTransactions(item);
      expect(result).toEqual({ added: 0, modified: 0, removed: 0 });
      expect(mockEvaluateCardPaymentsAfterSync).toHaveBeenCalledTimes(1);
      errorLog.mockRestore();
    });

    it.each(['disabled', 'evaluated', 'evaluation_failed', 'rpc_missing', 'rpc_error', 'timeout', 'request_failed', 'unexpected_response'])(
      'evaluation outcome %s: the cursor advanced exactly once beforehand and the sync response is unchanged',
      async (outcome) => {
        mockSyncTransactions.mockResolvedValue({ added: [{}, {}], modified: [{}], removed: [], cursor: 'new-cursor' });
        mockEvaluateCardPaymentsAfterSync.mockResolvedValue(outcome);
        const result = await syncItemTransactions(item);
        expect(result).toEqual({ added: 2, modified: 1, removed: 0 });
        expect(mockUpdateItemCursor).toHaveBeenCalledTimes(1);
        expect(mockUpdateItemCursor).toHaveBeenCalledWith('item-row-1', 'new-cursor');
        expect(mockUpdateItemCursor.mock.invocationCallOrder[0]).toBeLessThan(mockEvaluateCardPaymentsAfterSync.mock.invocationCallOrder[0]);
        expect(mockGetRecurringStreams).toHaveBeenCalledTimes(1);
      }
    );

    it('pre-cursor failure (reconciliation): the error propagates as before, the cursor does not advance, and no evaluation is attempted', async () => {
      mockReconcileRelationalRoles.mockRejectedValueOnce(new Error('reconciliation query failed'));
      await expect(syncItemTransactions(item)).rejects.toThrow('reconciliation query failed');
      expect(mockUpdateItemCursor).not.toHaveBeenCalled();
      expect(mockEvaluateCardPaymentsAfterSync).not.toHaveBeenCalled();
    });

    it('a failed cursor write propagates and no evaluation is attempted (the cursor write may or may not have reached the database)', async () => {
      mockUpdateItemCursor.mockRejectedValueOnce(new Error('Failed to update sync cursor: connection reset'));
      await expect(syncItemTransactions(item)).rejects.toThrow('Failed to update sync cursor');
      expect(mockEvaluateCardPaymentsAfterSync).not.toHaveBeenCalled();
    });

    it('post-cursor failure (recording last_synced_at): the error still propagates AFTER the cursor advanced, and no evaluation is attempted — as before this packet', async () => {
      mockRecordItemSyncedAt.mockRejectedValueOnce(new Error('synced_at write failed'));
      await expect(syncItemTransactions(item)).rejects.toThrow('synced_at write failed');
      expect(mockUpdateItemCursor).toHaveBeenCalledWith('item-row-1', 'new-cursor');
      expect(mockEvaluateCardPaymentsAfterSync).not.toHaveBeenCalled();
    });

    it('an empty batch still attempts evaluation, so a later sync with nothing new recovers an earlier failed evaluation', async () => {
      mockSyncTransactions.mockResolvedValue({ added: [{ transaction_id: 't1' }], modified: [], removed: [], cursor: 'c1' });
      mockEvaluateCardPaymentsAfterSync.mockResolvedValueOnce('timeout');
      await syncItemTransactions(item);

      mockSyncTransactions.mockResolvedValue({ added: [], modified: [], removed: [], cursor: 'c1' });
      mockEvaluateCardPaymentsAfterSync.mockResolvedValueOnce('evaluated');
      const second = await syncItemTransactions({ ...item, transactions_cursor: 'c1' });

      expect(second).toEqual({ added: 0, modified: 0, removed: 0 });
      expect(mockEvaluateCardPaymentsAfterSync).toHaveBeenCalledTimes(2);
      expect(mockEvaluateCardPaymentsAfterSync).toHaveBeenNthCalledWith(2, 'user-1');
    });

    it('a recurring-stream failure stays independent: the evaluation already ran and the sync still succeeds', async () => {
      const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
      const order = recordOrder();
      mockGetRecurringStreams.mockImplementation(async () => {
        order.push('recurring');
        throw new Error('recurring endpoint down');
      });
      const result = await syncItemTransactions(item);
      expect(result).toEqual({ added: 0, modified: 0, removed: 0 });
      expect(order.indexOf('evaluate')).toBeGreaterThan(-1);
      expect(order.indexOf('evaluate')).toBeLessThan(order.indexOf('recurring'));
      errorLog.mockRestore();
    });

    it('the evaluation does not wait for, or depend on, the recurring-stream Plaid request', async () => {
      let releaseRecurring: () => void = () => {};
      mockGetRecurringStreams.mockImplementation(
        () => new Promise((resolve) => {
          releaseRecurring = () => resolve({ inflowStreams: [], outflowStreams: [] });
        })
      );
      const syncing = syncItemTransactions(item);
      await vi.waitFor(() => expect(mockGetRecurringStreams).toHaveBeenCalled());
      expect(mockEvaluateCardPaymentsAfterSync).toHaveBeenCalledTimes(1);
      releaseRecurring();
      await syncing;
    });
  });
});
