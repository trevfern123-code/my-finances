import { useId, type ReactNode } from 'react';
import type { AssetGroup, NetWorthPoint } from '../lib/api';
import { computeLiquidCash } from '../lib/assets';
import { formatCurrencyWhole as formatCurrency } from '../lib/currency';
import type { SummaryView } from '../lib/semanticModel';
import { unresolvedCardPaymentsNote } from '../lib/semanticPresentation';
import { WithheldFigure } from './SemanticNotice';

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

/** One figure of the summary, announced as a group named by its label. */
function StatCard({ label, children }: { label: string; children: ReactNode }) {
  const labelId = useId();
  return (
    <div className="stat-card" role="group" aria-labelledby={labelId}>
      <span className="stat-label" id={labelId}>
        {label}
      </span>
      {children}
    </div>
  );
}

export function OverviewStats({
  netWorth,
  netWorthHistory,
  assetGroups,
  semantics,
}: {
  netWorth: number;
  netWorthHistory: NetWorthPoint[];
  assetGroups: AssetGroup[];
  /** The role-aware figures of the summary, or the state in which none is shown. Net worth and
   *  liquid cash are balance-based and do not depend on it. */
  semantics: SummaryView;
}) {
  const lastMonthSnapshot = findLastMonthSnapshot(netWorthHistory);
  const liquidCash = computeLiquidCash(assetGroups);

  // Cash flow is the server's figure for the latest month of the range. It is never rebuilt here
  // from income and spending.
  const months = semantics.kind === 'ok' ? semantics.months : [];
  const currentMonth = months[months.length - 1] ?? null;
  const previousMonth = months.length > 1 ? months[months.length - 2] : null;
  const cashFlow = currentMonth?.cash_flow ?? null;
  const headingId = useId();

  // `stat-value-withheld` marks a dash that stands in place of a figure, so it is styled as a
  // placeholder rather than as an amount. The dash and the state's word are unchanged.
  return (
    <section className="overview-at-a-glance" aria-labelledby={headingId}>
      <h2 className="overview-section-title" id={headingId}>
        At a glance
      </h2>
      <div className="overview-stats">
        <StatCard label="Net worth">
          <span className="stat-value">{formatCurrency(netWorth)}</span>
          <StatDelta current={netWorth} previous={lastMonthSnapshot?.net_worth ?? null} favorableWhenUp />
        </StatCard>
        <StatCard label="Liquid cash">
          <span className="stat-value">{formatCurrency(liquidCash)}</span>
          <span className="stat-delta">Checking + savings</span>
        </StatCard>
        <StatCard label="Monthly cash flow">
          {semantics.kind !== 'ok' ? (
            <WithheldFigure state={semantics} valueClassName="stat-value stat-value-withheld" />
          ) : currentMonth === null ? (
            <span className="stat-value stat-value-withheld">—</span>
          ) : cashFlow !== null ? (
            <>
              <span className={cashFlow < 0 ? 'stat-value negative' : 'stat-value'}>{formatCurrency(cashFlow)}</span>
              {/* A change is shown only between two months that are each a single figure. */}
              <StatDelta current={cashFlow} previous={previousMonth?.cash_flow ?? null} favorableWhenUp />
            </>
          ) : (
            <>
              <span className="stat-value">
                {formatCurrency(currentMonth.cash_flow_range.low)} – {formatCurrency(currentMonth.cash_flow_range.high)}
              </span>
              <span className="stat-delta">{unresolvedCardPaymentsNote(currentMonth.card_payments_unresolved.count)}</span>
            </>
          )}
        </StatCard>
      </div>
    </section>
  );
}
