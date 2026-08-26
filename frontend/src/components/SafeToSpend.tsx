import type { AssetGroup, BudgetCategory, Loan, ManualLoan, RecurringStream } from '../lib/api';
import { computeLiquidCash } from '../lib/assets';
import { collectUpcomingItems } from '../lib/upcomingItems';
import { computeRemainingBudget, computeSafeToSpend } from '../lib/safeToSpend';
import { formatCurrency } from '../lib/currency';

export function SafeToSpend({
  assetGroups,
  recurringStreams,
  loans,
  manualLoans,
  budgetCategories,
  upcomingBillsDays,
  minimumCashBuffer,
}: {
  assetGroups: AssetGroup[];
  recurringStreams: RecurringStream[];
  loans: Loan[];
  manualLoans: ManualLoan[];
  budgetCategories: BudgetCategory[];
  /** User-configurable (Settings → Financial preferences) — also drives the Upcoming Bills widget,
   *  so the two always agree on what "upcoming" means. */
  upcomingBillsDays: number;
  /** Money the user never wants counted as spendable, regardless of what's actually in the
   *  account — subtracted alongside upcoming bills and remaining budget. Never alters any actual
   *  account balance, budget target, or transaction — display/calculation only. */
  minimumCashBuffer: number;
}) {
  const liquidCash = computeLiquidCash(assetGroups);
  const upcomingBillsTotal = collectUpcomingItems(
    recurringStreams,
    loans,
    manualLoans,
    upcomingBillsDays
  ).reduce((sum, item) => sum + item.amount, 0);
  const remainingBudget = computeRemainingBudget(budgetCategories);
  const safeToSpend = computeSafeToSpend({
    liquidCash,
    upcomingBillsTotal,
    remainingBudget,
    minimumCashBuffer,
  });

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
          <span>Upcoming bills (next {upcomingBillsDays} days)</span>
          <span>−{formatCurrency(upcomingBillsTotal)}</span>
        </div>
        <div className="safe-to-spend-line">
          <span>Remaining budget</span>
          <span>−{formatCurrency(remainingBudget)}</span>
        </div>
        <div className="safe-to-spend-line">
          <span>Minimum cash buffer</span>
          <span>−{formatCurrency(minimumCashBuffer)}</span>
        </div>
      </div>
    </div>
  );
}
