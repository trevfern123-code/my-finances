import { useState } from 'react';
import { formatPlaidCategoryLabel } from '../lib/categoryLabels';
import { formatCurrency } from '../lib/currency';
import type { ReportingRangeId } from '../lib/reportingRange';
import type { BreakdownExcluded, MonthlyBreakdownView, SemanticCategoryAmount, SemanticMonthBreakdown } from '../lib/semanticModel';
import { formatSigned, formatSpending, incomeInLabel, monthRange, unresolvedCardPaymentsNote } from '../lib/semanticPresentation';
import { EffectsDrilldown } from './EffectsDrilldown';
import { ReportingRangeSelector } from './ReportingRangeSelector';
import { SemanticNotice } from './SemanticNotice';

const CATEGORY_COLORS = [
  '#60a5fa',
  '#f59e0b',
  '#34d399',
  '#c084fc',
  '#f87171',
  '#22d3ee',
  '#a3a380',
  '#f472b6',
];

const UNCATEGORIZED_COLOR = '#6b7280';

function formatMonthLabel(month: string) {
  const [year, monthNum] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatShortMonth(month: string) {
  const [year, monthNum] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNum - 1, 1)).toLocaleDateString('en-US', {
    month: 'short',
    timeZone: 'UTC',
  });
}

/** Assigns each category a color by its name, from a stable alphabetical ordering across every
 *  month in view — not by position within a single month's own sorted list, which is what let
 *  the same category (e.g. FOOD_AND_DRINK) show up as a different color from one month to the
 *  next depending on how it happened to rank that month. */
function buildCategoryColors(months: SemanticMonthBreakdown[]): Map<string, string> {
  const names = Array.from(
    new Set(months.flatMap((m) => m.by_category.map((c) => c.category)))
  )
    .filter((name) => name !== 'Uncategorized')
    .sort();

  const colors = new Map<string, string>();
  names.forEach((name, i) => colors.set(name, CATEGORY_COLORS[i % CATEGORY_COLORS.length]));
  return colors;
}

/** Uncategorized spending isn't a real category the user chose — push it to the bottom
 *  regardless of amount so actual categories aren't crowded out by an catch-all bucket. */
function sortWithUncategorizedLast(categories: SemanticCategoryAmount[]): SemanticCategoryAmount[] {
  return [...categories].sort((a, b) => {
    if (a.category === 'Uncategorized') return 1;
    if (b.category === 'Uncategorized') return -1;
    return b.amount - a.amount;
  });
}

function SpendingTrendChart({ months }: { months: SemanticMonthBreakdown[] }) {
  const maxSpending = Math.max(...months.map((m) => m.spending), 1);

  return (
    <div className="card">
      <h2>Spending trend</h2>
      <div className="spending-chart">
        {months.map((m) => (
          <div key={m.month} className="spending-bar-col">
            <span className="spending-bar-value">{formatSpending(m.spending)}</span>
            <div className="spending-bar-track">
              <div
                className="spending-bar"
                style={{ height: `${Math.max((m.spending / maxSpending) * 100, m.spending > 0 ? 2 : 0)}%` }}
              />
            </div>
            <span className="spending-bar-label">{formatShortMonth(m.month)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** "Not counted as spending: …" (design §5 C5): the month's excluded totals, as the server reports
 *  them. A line with nothing in it is left out. */
function ExcludedFooter({ excluded }: { excluded: BreakdownExcluded }) {
  const parts: string[] = [];
  if (excluded.transfers_internal !== 0) parts.push(`${formatSigned(excluded.transfers_internal)} transfers between your accounts`);
  if (excluded.transfers_external !== 0) {
    parts.push(
      excluded.transfers_external < 0
        ? `${formatCurrency(-excluded.transfers_external)} transferred to untracked accounts`
        : `${formatCurrency(excluded.transfers_external)} transferred in from untracked accounts`
    );
  }
  if (excluded.credit_card_payments_tracked !== 0) parts.push(`${formatSigned(excluded.credit_card_payments_tracked)} card payments to your tracked cards`);
  if (excluded.credit_card_payments_untracked !== 0) parts.push(`${formatSigned(excluded.credit_card_payments_untracked)} untracked card payments`);
  if (excluded.credit_card_payments_returned_untracked !== 0) {
    parts.push(`${formatSigned(excluded.credit_card_payments_returned_untracked)} returned untracked card payments`);
  }
  if (excluded.debt_payments !== 0) parts.push(`${formatSigned(excluded.debt_payments)} debt payments`);
  const unresolved = excluded.card_payments_unresolved;
  if (unresolved.count > 0) parts.push(unresolvedCardPaymentsNote(unresolved.count));

  if (parts.length === 0) return null;
  return <p className="hint month-excluded">Not counted as spending: {parts.join(' · ')}.</p>;
}

function MonthCard({
  month,
  categoryColors,
  expanded,
  onToggle,
  onRefresh,
}: {
  month: SemanticMonthBreakdown;
  categoryColors: Map<string, string>;
  expanded: boolean;
  onToggle: () => void;
  onRefresh?: () => void;
}) {
  const sortedCategories = sortWithUncategorizedLast(month.by_category);
  const [expandedCategory, setExpandedCategory] = useState<string | null>(null);

  return (
    <div className="card month-card">
      <button type="button" className="month-card-header" onClick={onToggle} aria-expanded={expanded}>
        <h2>{formatMonthLabel(month.month)}</h2>
        <div className="month-totals">
          <span className="month-total-spent">{formatSpending(month.spending)} spent</span>
          {/* The server's income for the month, whatever its sign: zero and negative are figures too. */}
          <span className="month-total-income">{incomeInLabel(month.income)}</span>
        </div>
        <span className="month-expand-icon" aria-hidden="true">
          {expanded ? '−' : '+'}
        </span>
      </button>

      {expanded && (
        <div className="month-card-body">
          {sortedCategories.length === 0 ? (
            <p className="hint">No spending recorded.</p>
          ) : (
            <div className="category-breakdown">
              {sortedCategories.map((c) => {
                // A share of the month's spending, for the bar only. Net refunds have no share.
                const pct = month.spending > 0 && c.amount > 0 ? (c.amount / month.spending) * 100 : 0;
                const isUncategorized = c.category === 'Uncategorized';
                const color = isUncategorized ? UNCATEGORIZED_COLOR : categoryColors.get(c.category);
                const isCategoryExpanded = expandedCategory === c.category;
                return (
                  <div key={c.category}>
                    <button
                      type="button"
                      className={isUncategorized ? 'cat-row uncategorized' : 'cat-row'}
                      aria-expanded={isCategoryExpanded}
                      onClick={() => setExpandedCategory(isCategoryExpanded ? null : c.category)}
                    >
                      <span className="cat-dot" style={{ background: color }} />
                      <span className="cat-name">{formatPlaidCategoryLabel(c.category)}</span>
                      <div className="cat-bar-track">
                        <div className="cat-bar-fill" style={{ width: `${Math.min(pct, 100)}%`, background: color }} />
                      </div>
                      <span className="cat-pct">{c.amount > 0 && month.spending > 0 ? `${pct.toFixed(0)}%` : ''}</span>
                      <span className="cat-amount">{formatSpending(c.amount)}</span>
                    </button>
                    {isCategoryExpanded && (
                      <EffectsDrilldown
                        query={{ ...monthRange(month.month), measure: 'spending', bucket: { kind: 'plaid_category', category: c.category } }}
                        parentAmount={c.amount}
                        onRefreshParent={onRefresh}
                        emptyText="No transactions in this category for this month."
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <ExcludedFooter excluded={month.excluded} />
        </div>
      )}
    </div>
  );
}

/**
 * Monthly Breakdown (design §5 C5). Every month, total and category amount is the server's
 * role-aware `semantic` block; the list of months is exactly the one the server returned. Category
 * amounts are signed, and a drill-down lists the server's effect rows for that month and category.
 */
export function MonthlyBreakdown({
  breakdown,
  reportingRange,
  onSetReportingRange,
  onRetry,
}: {
  breakdown: MonthlyBreakdownView;
  /** Date-Range Customization v1 — shared with the Overview tab's charts so switching it in
   *  either place stays in sync everywhere it applies. */
  reportingRange: ReportingRangeId;
  onSetReportingRange: (range: ReportingRangeId) => void;
  /** Reloads the breakdown for the current range. */
  onRetry?: () => void;
}) {
  const months = breakdown.kind === 'ok' ? breakdown.months : [];
  // Most recent month first — that's the one you actually want to check in on, and the only
  // one expanded by default so 6+ months doesn't mean 6+ huge stacked cards on load.
  const ordered = [...months].reverse();
  const [expandedMonth, setExpandedMonth] = useState<string | null | undefined>(undefined);
  // Until the user opens or closes a month, the most recent one is open.
  const openMonth = expandedMonth === undefined ? (ordered[0]?.month ?? null) : expandedMonth;

  if (breakdown.kind !== 'ok') {
    return (
      <div className="tab-panel">
        <ReportingRangeSelector range={reportingRange} onChange={onSetReportingRange} />
        <div className="card">
          <h2>Monthly breakdown</h2>
          <SemanticNotice state={breakdown} onRetry={onRetry} />
        </div>
      </div>
    );
  }

  if (months.length === 0) {
    return (
      <div className="tab-panel">
        <ReportingRangeSelector range={reportingRange} onChange={onSetReportingRange} />
        <div className="card">
          <h2>Monthly breakdown</h2>
          <p className="hint">No transaction history yet.</p>
        </div>
      </div>
    );
  }

  const categoryColors = buildCategoryColors(months);

  return (
    <div className="tab-panel">
      <ReportingRangeSelector range={reportingRange} onChange={onSetReportingRange} />
      {months.length > 1 && <SpendingTrendChart months={months} />}
      <p className="hint">Spending excludes transfers, card payments and debt payments.</p>
      <div className="months-breakdown">
        {ordered.map((m) => (
          <MonthCard
            key={m.month}
            month={m}
            categoryColors={categoryColors}
            expanded={openMonth === m.month}
            onToggle={() => setExpandedMonth(openMonth === m.month ? null : m.month)}
            onRefresh={onRetry}
          />
        ))}
      </div>
    </div>
  );
}
