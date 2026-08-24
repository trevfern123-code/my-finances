import type { NetWorthPoint, SpendingSummary } from '../lib/api';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatMonth(month: string) {
  const [year, monthNum] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
}

/** Most recent snapshot from a calendar month strictly before the latest snapshot's month —
 *  the "last month" comparison point for the stat-card deltas. Null if there isn't one yet
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
}: {
  current: number;
  previous: number | null;
  favorableWhenUp: boolean;
}) {
  if (previous === null) return null;
  const diff = current - previous;
  if (diff === 0) return <span className="stat-delta">No change vs last month</span>;

  const up = diff > 0;
  const favorable = up === favorableWhenUp;
  return (
    <span className={favorable ? 'stat-delta positive' : 'stat-delta negative'}>
      {up ? '+' : '−'}
      {formatCurrency(Math.abs(diff))} vs last month
    </span>
  );
}

export function SpendingOverview({
  summary,
  netWorthHistory,
}: {
  summary: SpendingSummary;
  netWorthHistory: NetWorthPoint[];
}) {
  const maxSpent = Math.max(...summary.monthly_spending.map((m) => m.spent), 1);
  const lastMonth = findLastMonthSnapshot(netWorthHistory);

  return (
    <div className="card">
      <h2>Overview</h2>
      <div className="overview-stats">
        <div className="stat-card">
          <span className="stat-label">Net worth</span>
          <span className="stat-value">{formatCurrency(summary.net_worth)}</span>
          <StatDelta current={summary.net_worth} previous={lastMonth?.net_worth ?? null} favorableWhenUp />
        </div>
        <div className="stat-card">
          <span className="stat-label">Assets</span>
          <span className="stat-value">{formatCurrency(summary.total_assets)}</span>
          <StatDelta
            current={summary.total_assets}
            previous={lastMonth?.total_assets ?? null}
            favorableWhenUp
          />
        </div>
        <div className="stat-card">
          <span className="stat-label">Liabilities</span>
          <span className="stat-value">{formatCurrency(summary.total_liabilities)}</span>
          <StatDelta
            current={summary.total_liabilities}
            previous={lastMonth?.total_liabilities ?? null}
            favorableWhenUp={false}
          />
        </div>
      </div>

      {summary.monthly_spending.length === 0 ? (
        <p className="hint">No transaction history yet.</p>
      ) : (
        <div className="spending-chart">
          {summary.monthly_spending.map((m) => (
            <div key={m.month} className="spending-bar-col">
              <span className="spending-bar-value">{formatCurrency(m.spent)}</span>
              <div className="spending-bar-track">
                <div
                  className="spending-bar"
                  style={{ height: `${Math.max((m.spent / maxSpent) * 100, m.spent > 0 ? 2 : 0)}%` }}
                />
              </div>
              <span className="spending-bar-label">{formatMonth(m.month)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
