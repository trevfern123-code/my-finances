import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aggregateAssetsAndLiabilities,
  getMonthsAgoStart,
  getTodayDateString,
  recordSnapshotForUser,
} from './netWorth';

const mockGetAccountBalancesForUser = vi.hoisted(() => vi.fn());
const mockUpsertNetWorthSnapshot = vi.hoisted(() => vi.fn());
vi.mock('./dataService', () => ({
  getAccountBalancesForUser: mockGetAccountBalancesForUser,
  upsertNetWorthSnapshot: mockUpsertNetWorthSnapshot,
}));

describe('aggregateAssetsAndLiabilities', () => {
  it('counts checking/savings/investment balances as assets', () => {
    const result = aggregateAssetsAndLiabilities([
      { type: 'depository', current_balance: 100 },
      { type: 'investment', current_balance: 50 },
    ]);
    expect(result).toEqual({ assets: 150, liabilities: 0 });
  });

  it('counts credit and loan balances as liabilities, not assets', () => {
    const result = aggregateAssetsAndLiabilities([
      { type: 'credit', current_balance: 200 },
      { type: 'loan', current_balance: 300 },
    ]);
    expect(result).toEqual({ assets: 0, liabilities: 500 });
  });

  it('treats a null balance as zero rather than throwing or skipping', () => {
    const result = aggregateAssetsAndLiabilities([{ type: 'depository', current_balance: null }]);
    expect(result).toEqual({ assets: 0, liabilities: 0 });
  });

  it('returns zeros for no accounts', () => {
    expect(aggregateAssetsAndLiabilities([])).toEqual({ assets: 0, liabilities: 0 });
  });
});

describe('getTodayDateString', () => {
  it('formats a given date as YYYY-MM-DD in UTC', () => {
    expect(getTodayDateString(new Date('2026-08-23T18:45:00Z'))).toBe('2026-08-23');
  });
});

describe('getMonthsAgoStart', () => {
  it('returns the first of the current month for months=1', () => {
    expect(getMonthsAgoStart(1, new Date('2026-08-23T12:00:00Z'))).toBe('2026-08-01');
  });

  it('returns the first of the month N-1 months back for months=6', () => {
    expect(getMonthsAgoStart(6, new Date('2026-08-23T12:00:00Z'))).toBe('2026-03-01');
  });

  it('rolls over the year boundary correctly', () => {
    expect(getMonthsAgoStart(6, new Date('2026-02-15T12:00:00Z'))).toBe('2025-09-01');
  });
});

describe('recordSnapshotForUser', () => {
  beforeEach(() => {
    mockGetAccountBalancesForUser.mockReset();
    mockUpsertNetWorthSnapshot.mockReset();
  });

  it('aggregates live balances and upserts a snapshot dated today', async () => {
    mockGetAccountBalancesForUser.mockResolvedValue([
      { type: 'depository', current_balance: 1000 },
      { type: 'credit', current_balance: 250 },
    ]);

    await recordSnapshotForUser('user-1');

    expect(mockGetAccountBalancesForUser).toHaveBeenCalledWith('user-1');
    expect(mockUpsertNetWorthSnapshot).toHaveBeenCalledWith({
      userId: 'user-1',
      date: getTodayDateString(),
      totalAssets: 1000,
      totalLiabilities: 250,
      netWorth: 750,
    });
  });

  it('propagates a failure instead of silently swallowing it', async () => {
    mockGetAccountBalancesForUser.mockRejectedValue(new Error('db down'));
    await expect(recordSnapshotForUser('user-1')).rejects.toThrow('db down');
    expect(mockUpsertNetWorthSnapshot).not.toHaveBeenCalled();
  });
});
