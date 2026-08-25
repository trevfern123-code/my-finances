import type { AssetGroup, NetWorthPoint } from '../lib/api';
import { computeLiquidCash } from '../lib/assets';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}

/** Most recent snapshot from a calendar month strictly before the latest snapshot's month —
 *  the "last month" comparison point for the Net Worth delta. Null if there isn't one yet
 *  (e.g. the account has less than a month of net-worth history). */
function findLastMonthSnapshot(history: NetWorthPoint[]): NetWorthPoint | null {
  if (history.length === 0) return null;
  const latestMonth = history[history.length - 1].date.slice(0, 7);
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].date.slice(0, 7) !== latestMonth) return history[i];
  }
  return null;
}

function StatDelta({
  current,
  previous,
  favorableWhenUp,
  label = 'vs last month',
}: {
  current: number;
  previous: number | null;
  favorableWhenUp: boolean;
  label?: string;
}) {
  if (previous === null) return null;
  const diff = current - previous;
  if (diff === 0) return <span className="stat-delta">No change {label}</span>;

  const up = diff > 0;
  const favorable = up === favorableWhenUp;
  return (
    <span className={favorable ? 'stat-delta positive' : 'stat-delta negative'}>
      {up ? '+' : '−'}
      {formatCurrency(Math.abs(diff))} {label}
    </span>
  );
}

export function OverviewStats({
  netWorth,
  netWorthHistory,
  assetGroups,
  monthlySpending,
}: {
  netWorth: number;
  netWorthHistory: NetWorthPoint[];
  assetGroups: AssetGroup[];
  monthlySpending: { month: string; spent: number; income: number }[];
}) {
  const lastMonthSnapshot = findLastMonthSnapshot(netWorthHistory);
  const liquidCash = computeLiquidCash(assetGroups);

  const currentMonth = monthlySpending[monthlySpending.length - 1] ?? null;
  const previousMonth = monthlySpending.length > 1 ? monthlySpending[monthlySpending.length - 2] : null;
  const cashFlow = currentMonth ? currentMonth.income - currentMonth.spent : null;
  const previousCashFlow = previousMonth ? previousMonth.income - previousMonth.spent : null;

  return (
    <div className="overview-stats">
      <div className="stat-card">
        <span className="stat-label">Net worth</span>
        <span className="stat-value">{formatCurrency(netWorth)}</span>
        <StatDelta current={netWorth} previous={lastMonthSnapshot?.net_worth ?? null} favorableWhenUp />
      </div>
      <div className="stat-card">
        <span className="stat-label">Liquid cash</span>
        <span className="stat-value">{formatCurrency(liquidCash)}</span>
        <span className="stat-delta">Checking + savings</span>
      </div>
      <div className="stat-card">
        <span className="stat-label">Monthly cash flow</span>
        <span className={cashFlow !== null && cashFlow < 0 ? 'stat-value negative' : 'stat-value'}>
          {cashFlow !== null ? formatCurrency(cashFlow) : '—'}
        </span>
        {cashFlow !== null && (
          <StatDelta current={cashFlow} previous={previousCashFlow} favorableWhenUp />
        )}
      </div>
    </div>
  );
}
