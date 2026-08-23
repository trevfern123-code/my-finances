import * as dataService from './dataService';

const LIABILITY_ACCOUNT_TYPES = new Set(['credit', 'loan']);

export interface BalanceRow {
  type: string;
  current_balance: number | null;
}

export interface AssetLiabilityTotals {
  assets: number;
  liabilities: number;
}

/** Splits account balances into assets vs. liabilities. Credit cards and loans are debt (money
 *  owed), so their balances count against net worth rather than toward it; everything else
 *  (checking, savings, investment, etc.) counts as an asset. */
export function aggregateAssetsAndLiabilities(accounts: BalanceRow[]): AssetLiabilityTotals {
  return accounts.reduce<AssetLiabilityTotals>(
    (totals, account) => {
      const balance = account.current_balance ?? 0;
      if (LIABILITY_ACCOUNT_TYPES.has(account.type)) {
        totals.liabilities += balance;
      } else {
        totals.assets += balance;
      }
      return totals;
    },
    { assets: 0, liabilities: 0 }
  );
}

/** Today's date as YYYY-MM-DD in UTC — matches the plain SQL `date` column with no timezone. */
export function getTodayDateString(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** The first day of the month `months` back from `now` (inclusive of the current month), as YYYY-MM-DD. */
export function getMonthsAgoStart(months: number, now: Date = new Date()): string {
  const since = new Date(now);
  since.setUTCDate(1);
  since.setUTCMonth(since.getUTCMonth() - (months - 1));
  return since.toISOString().slice(0, 10);
}

/**
 * Recomputes a user's current net worth from live account balances and records it as today's
 * snapshot (upserted, so repeated calls the same day just update that day's row). Called
 * whenever we've just fetched fresh balances from Plaid — initial link and manual refresh —
 * since that's the only time `accounts.current_balance` actually changes.
 */
export async function recordSnapshotForUser(userId: string): Promise<void> {
  const accounts = await dataService.getAccountBalancesForUser(userId);
  const { assets, liabilities } = aggregateAssetsAndLiabilities(accounts);

  await dataService.upsertNetWorthSnapshot({
    userId,
    date: getTodayDateString(),
    totalAssets: assets,
    totalLiabilities: liabilities,
    netWorth: assets - liabilities,
  });
}
