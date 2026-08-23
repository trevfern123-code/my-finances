import type { NetWorthPoint } from '../lib/api';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function NetWorthChart({ history }: { history: NetWorthPoint[] }) {
  if (history.length === 0) {
    return (
      <div className="card">
        <h2>Net worth over time</h2>
        <p className="hint">
          No history yet — snapshots are recorded whenever balances are refreshed. Check back
          after your next "Refresh balances."
        </p>
      </div>
    );
  }

  const maxNetWorth = Math.max(...history.map((p) => p.net_worth), 1);

  return (
    <div className="card">
      <h2>Net worth over time</h2>
      <div className="spending-chart">
        {history.map((point) => (
          <div key={point.date} className="spending-bar-col">
            <span className="spending-bar-value">{formatCurrency(point.net_worth)}</span>
            <div className="spending-bar-track">
              <div
                className="spending-bar net-worth-bar"
                style={{
                  height: `${Math.max((point.net_worth / maxNetWorth) * 100, point.net_worth > 0 ? 2 : 0)}%`,
                }}
              />
            </div>
            <span className="spending-bar-label">{formatDate(point.date)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
