import type { BudgetCategory } from '../lib/api';
import { currentMonthRange } from '../lib/budgetDrilldown';
import { formatCurrency } from '../lib/currency';
import { totalBudgetSpending, type BudgetView, type CashFlowFigures, type SummaryView } from '../lib/semanticModel';
import { formatAmountRange, formatSigned, formatSpending, unresolvedCardPaymentsNote } from '../lib/semanticPresentation';
import { CashFlowDetails } from './CashFlowDetails';
import { SemanticNotice } from './SemanticNotice';

/** How far the current calendar month has progressed, as a 0..1 fraction — the baseline "pace"
 *  a budget should be tracking against (e.g. day 15 of a 30-day month is 0.5). */
function monthProgress(now: Date): number {
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  return now.getDate() / daysInMonth;
}

/** Same tiering thresholds as the per-category budget bars (BudgetCategories.tsx) — green under
 *  pace, amber a little ahead, red meaningfully ahead of where the month's progress says spend
 *  should be. */
function paceTier(pctBudgetSpent: number, pctMonthElapsed: number): 'good' | 'warn' | 'over' {
  const aheadBy = pctBudgetSpent - pctMonthElapsed;
  if (aheadBy > 0.2) return 'over';
  if (aheadBy > 0.05) return 'warn';
  return 'good';
}

/** The bars of the current month (design §5 C2): Income and Spending always; Debt payments, Untracked
 *  card payments and Transfers out only when there is something to show. Every amount is the
 *  server's. A bar's length is its size on screen; the text beside it is the figure. */
function CashFlowBars({ figures }: { figures: CashFlowFigures }) {
  const bars: { label: string; amount: number; text: string; kind: 'income' | 'spending' }[] = [
    { label: 'Income this month', amount: figures.income_semantic, text: formatSigned(figures.income_semantic), kind: 'income' },
    { label: 'Spending this month', amount: figures.spending, text: formatSpending(figures.spending), kind: 'spending' },
  ];
  if (figures.debt_payments !== 0) {
    bars.push({ label: 'Debt payments', amount: figures.debt_payments, text: formatSigned(figures.debt_payments), kind: 'spending' });
  }
  if (figures.credit_card_payments_untracked !== 0) {
    bars.push({
      label: 'Untracked card payments',
      amount: figures.credit_card_payments_untracked,
      text: formatSigned(figures.credit_card_payments_untracked),
      kind: 'spending',
    });
  }
  if (figures.transfers_external < 0) {
    bars.push({ label: 'Transfers out', amount: -figures.transfers_external, text: formatCurrency(-figures.transfers_external), kind: 'spending' });
  }
  const longest = Math.max(...bars.map((bar) => bar.amount), 1);

  return (
    <div className="cash-flow-bars">
      {bars.map((bar) => (
        <div className="cash-flow-row" key={bar.label}>
          <span className="stat-label">{bar.label}</span>
          <div className="cash-flow-bar-track">
            <div className={`cash-flow-bar-fill ${bar.kind}`} style={{ width: `${(Math.max(bar.amount, 0) / longest) * 100}%` }} />
          </div>
          <span className="cash-flow-amount">{bar.text}</span>
        </div>
      ))}
    </div>
  );
}

export function CashFlowPace({
  budgetCategories,
  semantics,
  budgetSemantics,
  onRetry,
  onRetryBudget,
}: {
  /** The active budget categories (their names and budgeted amounts). */
  budgetCategories: BudgetCategory[];
  /** The summary's role-aware figures; this card shows the real current calendar month. */
  semantics: SummaryView;
  /** The role-aware spending per budget category. */
  budgetSemantics: BudgetView;
  onRetry?: () => void;
  onRetryBudget?: () => void;
}) {
  const totalBudget = budgetCategories.reduce((sum, c) => sum + c.budget_amount, 0);
  const totalBudgetSpent =
    budgetSemantics.kind === 'ok' ? totalBudgetSpending(budgetSemantics.byCategoryId, budgetCategories.map((c) => c.id)) : null;

  const pctMonthElapsed = monthProgress(new Date());

  return (
    <div className="card">
      <h2>Cash flow &amp; budget pace</h2>

      {semantics.kind !== 'ok' ? (
        <SemanticNotice state={semantics} onRetry={onRetry} />
      ) : (
        <>
          <CashFlowBars figures={semantics.currentMonth} />
          <p className="cash-flow-result">
            Cash flow this month:{' '}
            {semantics.currentMonth.cash_flow !== null ? (
              <strong>{formatSigned(semantics.currentMonth.cash_flow)}</strong>
            ) : (
              <>
                <strong>{formatAmountRange(semantics.currentMonth.cash_flow_range)}</strong> ·{' '}
                {unresolvedCardPaymentsNote(semantics.currentMonth.card_payments_unresolved.count)}
              </>
            )}
          </p>
          <CashFlowDetails figures={semantics.currentMonth} period={currentMonthRange()} onRefresh={onRetry} />
        </>
      )}

      {totalBudget <= 0 ? (
        <p className="hint budget-pace-hint">
          Set up budget categories (on the Budget tab) to track your spending pace against them.
        </p>
      ) : totalBudgetSpent === null ? (
        <div className="budget-pace">
          <div className="section-header">
            <span className="stat-label">Budget pace</span>
            <span className="budget-category-summary">— of {formatCurrency(totalBudget)} budgeted</span>
          </div>
          <SemanticNotice state={budgetSemantics.kind === 'ok' ? { kind: 'invalid' } : budgetSemantics} onRetry={onRetryBudget} />
        </div>
      ) : (
        <BudgetPace totalBudget={totalBudget} totalBudgetSpent={totalBudgetSpent} pctMonthElapsed={pctMonthElapsed} />
      )}
    </div>
  );
}

function BudgetPace({ totalBudget, totalBudgetSpent, pctMonthElapsed }: { totalBudget: number; totalBudgetSpent: number; pctMonthElapsed: number }) {
  const pctBudgetSpent = totalBudgetSpent / totalBudget;
  const tier = paceTier(pctBudgetSpent, pctMonthElapsed);
  const projectedSpend = pctMonthElapsed > 0 ? totalBudgetSpent / pctMonthElapsed : totalBudgetSpent;

  return (
    <div className="budget-pace">
      <div className="section-header">
        <span className="stat-label">Budget pace</span>
        <span className={`budget-category-summary budget-category-summary-${tier}`}>
          {formatSpending(totalBudgetSpent)} of {formatCurrency(totalBudget)} budgeted
        </span>
      </div>
      <div className="progress-track">
        <div className={`progress-fill progress-${tier}`} style={{ width: `${Math.min(Math.max(pctBudgetSpent, 0) * 100, 100)}%` }} />
        <div
          className="recent-avg-marker"
          style={{ left: `${Math.min(pctMonthElapsed * 100, 100)}%` }}
          title={`${Math.round(pctMonthElapsed * 100)}% of the month elapsed`}
        />
      </div>
      <p className="hint budget-pace-hint">
        {Math.round(pctMonthElapsed * 100)}% of the month elapsed ·{' '}
        {tier === 'good' ? 'on pace to stay within budget' : `projected to spend ${formatCurrency(projectedSpend)} by month end`}
      </p>
      <p className="hint">Spending excludes transfers, card payments and debt payments.</p>
    </div>
  );
}
