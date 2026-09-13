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
const mockSetItemStatus = vi.hoisted(() => vi.fn());
const mockUpsertRecurringStreams = vi.hoisted(() => vi.fn());
vi.mock('./dataService', () => ({
  getAccountIdMapForItem: mockGetAccountIdMapForItem,
  applyTransactionChanges: mockApplyTransactionChanges,
  updateItemCursor: mockUpdateItemCursor,
  setItemStatus: mockSetItemStatus,
  upsertRecurringStreams: mockUpsertRecurringStreams,
}));

const mockLinkNewTransactionsToManualLoans = vi.hoisted(() => vi.fn());
vi.mock('./loans', () => ({
  linkNewTransactionsToManualLoans: mockLinkNewTransactionsToManualLoans,
}));

const mockReconcileRelationalRoles = vi.hoisted(() => vi.fn());
const mockReconcileAroundTransactionChange = vi.hoisted(() => vi.fn());
vi.mock('./roleReconciliation', () => ({
  reconcileRelationalRoles: mockReconcileRelationalRoles,
  reconcileAroundTransactionChange: mockReconcileAroundTransactionChange,
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
  mockApplyTransactionChanges.mockResolvedValue({ insertedTransactions: [], touchedTransactionIds: [], semanticallyChangedTransactionIds: [] });
  mockGetRecurringStreams.mockResolvedValue({ inflowStreams: [], outflowStreams: [] });
  mockReconcileRelationalRoles.mockResolvedValue(undefined);
  mockReconcileAroundTransactionChange.mockResolvedValue(undefined);
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

  it('marks the item active on a successful sync', async () => {
    await syncItemTransactions(item);
    expect(mockSetItemStatus).toHaveBeenCalledWith('item-row-1', 'active');
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
    expect(mockSetItemStatus).not.toHaveBeenCalled();
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
    expect(mockSetItemStatus).toHaveBeenCalledWith('item-row-1', 'active');
  });

  it('links newly-inserted transactions to the user\'s manual loans', async () => {
    const insertedTransactions = [{ id: 'txn-1', name: 'SoFi Payment', merchant_name: null, amount: 250 }];
    mockApplyTransactionChanges.mockResolvedValue({ insertedTransactions, touchedTransactionIds: ['txn-1'], semanticallyChangedTransactionIds: [] });

    await syncItemTransactions(item);

    expect(mockLinkNewTransactionsToManualLoans).toHaveBeenCalledWith('user-1', insertedTransactions);
  });

  it('runs relational role reconciliation over exactly the transactions touched by this batch, after loan auto-linking', async () => {
    const insertedTransactions = [{ id: 'txn-1', name: 'Transfer', merchant_name: null, amount: 100 }];
    mockApplyTransactionChanges.mockResolvedValue({
      insertedTransactions,
      touchedTransactionIds: ['txn-1', 'txn-2'],
      semanticallyChangedTransactionIds: [],
    });

    await syncItemTransactions(item);

    expect(mockReconcileRelationalRoles).toHaveBeenCalledWith('user-1', ['txn-1', 'txn-2']);
    expect(mockReconcileRelationalRoles.mock.invocationCallOrder[0]).toBeGreaterThan(
      mockLinkNewTransactionsToManualLoans.mock.invocationCallOrder[0]
    );
  });

  it('runs reconcileAroundTransactionChange for every semantically-changed transaction id, in addition to the ordinary forward pass', async () => {
    mockApplyTransactionChanges.mockResolvedValue({
      insertedTransactions: [],
      touchedTransactionIds: ['txn-1', 'txn-2'],
      semanticallyChangedTransactionIds: ['txn-2'],
    });

    await syncItemTransactions(item);

    expect(mockReconcileRelationalRoles).toHaveBeenCalledWith('user-1', ['txn-1', 'txn-2']);
    expect(mockReconcileAroundTransactionChange).toHaveBeenCalledWith('user-1', 'txn-2');
    expect(mockReconcileAroundTransactionChange).toHaveBeenCalledTimes(1);
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
      semanticallyChangedTransactionIds: [],
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
      semanticallyChangedTransactionIds: [],
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
});
