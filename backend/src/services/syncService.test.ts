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

const item = { id: 'item-row-1', access_token: 'access-token-1', transactions_cursor: 'old-cursor' };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAccountIdMapForItem.mockResolvedValue(new Map([['plaid-acc-1', 'account-row-1']]));
  mockSyncTransactions.mockResolvedValue({ added: [], modified: [], removed: [], cursor: 'new-cursor' });
  mockGetRecurringStreams.mockResolvedValue({ inflowStreams: [], outflowStreams: [] });
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
});
