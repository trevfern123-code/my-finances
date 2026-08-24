import type { BudgetCategory } from '../lib/api';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

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

export function CashFlowPace({
  budgetCategories,
  currentMonthIncome,
  currentMonthSpent,
}: {
  budgetCategories: BudgetCategory[];
  currentMonthIncome: number;
  currentMonthSpent: number;
}) {
  const totalBudget = budgetCategories.reduce((sum, c) => sum + c.budget_amount, 0);
  const totalBudgetSpent = budgetCategories.reduce((sum, c) => sum + c.spent, 0);

  const pctMonthElapsed = monthProgress(new Date());
  const pctBudgetSpent = totalBudget > 0 ? totalBudgetSpent / totalBudget : 0;
  const tier = paceTier(pctBudgetSpent, pctMonthElapsed);
  const projectedSpend = pctMonthElapsed > 0 ? totalBudgetSpent / pctMonthElapsed : totalBudgetSpent;

  const maxFlow = Math.max(currentMonthIncome, currentMonthSpent, 1);

  return (
    <div className="card">
      <h2>Cash flow &amp; budget pace</h2>

      <div className="cash-flow-bars">
        <div className="cash-flow-row">
          <span className="stat-label">Income this month</span>
          <div className="cash-flow-bar-track">
            <div
              className="cash-flow-bar-fill income"
              style={{ width: `${(currentMonthIncome / maxFlow) * 100}%` }}
            />
          </div>
          <span className="cash-flow-amount">{formatCurrency(currentMonthIncome)}</span>
        </div>
        <div className="cash-flow-row">
          <span className="stat-label">Spending this month</span>
          <div className="cash-flow-bar-track">
            <div
              className="cash-flow-bar-fill spending"
              style={{ width: `${(currentMonthSpent / maxFlow) * 100}%` }}
            />
          </div>
          <span className="cash-flow-amount">{formatCurrency(currentMonthSpent)}</span>
        </div>
      </div>

      {totalBudget <= 0 ? (
        <p className="hint budget-pace-hint">
          Set up budget categories (on the Budget tab) to track your spending pace against them.
        </p>
      ) : (
        <div className="budget-pace">
          <div className="section-header">
            <span className="stat-label">Budget pace</span>
            <span className={`budget-category-summary budget-category-summary-${tier}`}>
              {formatCurrency(totalBudgetSpent)} of {formatCurrency(totalBudget)} budgeted
            </span>
          </div>
          <div className="progress-track">
            <div
              className={`progress-fill progress-${tier}`}
              style={{ width: `${Math.min(pctBudgetSpent * 100, 100)}%` }}
            />
            <div
              className="recent-avg-marker"
              style={{ left: `${Math.min(pctMonthElapsed * 100, 100)}%` }}
              title={`${Math.round(pctMonthElapsed * 100)}% of the month elapsed`}
            />
          </div>
          <p className="hint budget-pace-hint">
            {Math.round(pctMonthElapsed * 100)}% of the month elapsed ·{' '}
            {tier === 'good'
              ? 'on pace to stay within budget'
              : `projected to spend ${formatCurrency(projectedSpend)} by month end`}
          </p>
        </div>
      )}
    </div>
  );
}
