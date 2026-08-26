import type { NetWorthPoint } from '../lib/api';
import { formatCurrencyWhole as formatCurrency } from '../lib/currency';

function formatDate(date: string) {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

const WIDTH = 700;
const HEIGHT = 220;
const PAD_LEFT = 64;
const PAD_RIGHT = 12;
const PAD_TOP = 16;
const PAD_BOTTOM = 26;
const PLOT_WIDTH = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_HEIGHT = HEIGHT - PAD_TOP - PAD_BOTTOM;

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

  const values = history.map((p) => p.net_worth);
  // Always include 0 in the range — this is what keeps a negative net worth from clipping to
  // an invisible 0%-height bar the way the old bar-chart version did.
  const minVal = Math.min(...values, 0);
  const maxVal = Math.max(...values, 0);
  const range = maxVal - minVal || 1;

  const xFor = (i: number) =>
    PAD_LEFT + (history.length === 1 ? PLOT_WIDTH / 2 : (i / (history.length - 1)) * PLOT_WIDTH);
  const yFor = (v: number) => PAD_TOP + (1 - (v - minVal) / range) * PLOT_HEIGHT;

  const zeroY = yFor(0);
  const showZeroLine = minVal < 0 && maxVal > 0;

  const linePath = history
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${xFor(i).toFixed(1)},${yFor(p.net_worth).toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${xFor(history.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${xFor(0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  const latest = history[history.length - 1];

  return (
    <div className="card">
      <div className="section-header">
        <h2>Net worth over time</h2>
        <span className={latest.net_worth >= 0 ? 'stat-value-inline' : 'stat-value-inline negative'}>
          {formatCurrency(latest.net_worth)}
        </span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="networth-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="networth-area-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--info)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--info)" stopOpacity="0.02" />
          </linearGradient>
        </defs>

        <text x={4} y={PAD_TOP + 4} className="networth-axis-label">
          {formatCurrency(maxVal)}
        </text>
        <text x={4} y={HEIGHT - PAD_BOTTOM} className="networth-axis-label">
          {formatCurrency(minVal)}
        </text>

        {showZeroLine && (
          <>
            <line
              x1={PAD_LEFT}
              x2={WIDTH - PAD_RIGHT}
              y1={zeroY}
              y2={zeroY}
              className="networth-zero-line"
            />
            <text x={4} y={zeroY + 4} className="networth-axis-label">
              $0
            </text>
          </>
        )}

        <path d={areaPath} className="networth-area" />
        <path d={linePath} className="networth-line" />

        {history.map((p, i) => (
          <circle
            key={p.date}
            cx={xFor(i)}
            cy={yFor(p.net_worth)}
            r={3}
            className={p.net_worth >= 0 ? 'networth-point' : 'networth-point negative'}
          />
        ))}

        <text x={PAD_LEFT} y={HEIGHT - 6} className="networth-axis-label" textAnchor="start">
          {formatDate(history[0].date)}
        </text>
        <text x={WIDTH - PAD_RIGHT} y={HEIGHT - 6} className="networth-axis-label" textAnchor="end">
          {formatDate(latest.date)}
        </text>
      </svg>
    </div>
  );
}
