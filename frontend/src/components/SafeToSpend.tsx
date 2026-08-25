import type { AssetGroup, BudgetCategory, Loan, ManualLoan, RecurringStream } from '../lib/api';
import { computeLiquidCash } from '../lib/assets';
import { collectUpcomingItems } from '../lib/upcomingItems';
import { UPCOMING_BILLS_DAYS_AHEAD } from './UpcomingBills';

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

/** Money still earmarked for a budget category but not yet spent. A category already over
 *  budget contributes 0 here rather than a negative number — the overspend already left the
 *  liquid-cash balance, so subtracting it again would double-count it. */
function computeRemainingBudget(categories: BudgetCategory[]): number {
  return categories.reduce((sum, c) => sum + Math.max(0, c.budget_amount - c.spent), 0);
}

export function SafeToSpend({
  assetGroups,
  recurringStreams,
  loans,
  manualLoans,
  budgetCategories,
}: {
  assetGroups: AssetGroup[];
  recurringStreams: RecurringStream[];
  loans: Loan[];
  manualLoans: ManualLoan[];
  budgetCategories: BudgetCategory[];
}) {
  const liquidCash = computeLiquidCash(assetGroups);
  const upcomingBillsTotal = collectUpcomingItems(
    recurringStreams,
    loans,
    manualLoans,
    UPCOMING_BILLS_DAYS_AHEAD
  ).reduce((sum, item) => sum + item.amount, 0);
  const remainingBudget = computeRemainingBudget(budgetCategories);
  const safeToSpend = liquidCash - upcomingBillsTotal - remainingBudget;

  return (
    <div className="card safe-to-spend-card">
      <h2>Safe to spend</h2>
      <div className={safeToSpend < 0 ? 'safe-to-spend-value negative' : 'safe-to-spend-value'}>
        {formatCurrency(safeToSpend)}
      </div>
      <p className="hint">What's left after upcoming bills and unspent budget are set aside.</p>
      <div className="safe-to-spend-breakdown">
        <div className="safe-to-spend-line">
          <span>Liquid cash</span>
          <span>{formatCurrency(liquidCash)}</span>
        </div>
        <div className="safe-to-spend-line">
          <span>Upcoming bills (next {UPCOMING_BILLS_DAYS_AHEAD} days)</span>
          <span>−{formatCurrency(upcomingBillsTotal)}</span>
        </div>
        <div className="safe-to-spend-line">
          <span>Remaining budget</span>
          <span>−{formatCurrency(remainingBudget)}</span>
        </div>
      </div>
    </div>
  );
}
