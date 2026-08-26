import type { AssetGroup, BudgetCategory, Loan, ManualLoan, RecurringStream } from '../lib/api';
import { computeLiquidCash } from '../lib/assets';
import { collectUpcomingItems } from '../lib/upcomingItems';
import { computeRemainingBudget, computeSafeToSpend, splitUpcomingTotals } from '../lib/safeToSpend';
import { formatCurrency } from '../lib/currency';

export function SafeToSpend({
  assetGroups,
  recurringStreams,
  loans,
  manualLoans,
  budgetCategories,
  upcomingBillsDays,
  minimumCashBuffer,
  includeUpcomingBills,
  includeRemainingBudget,
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
  /** Safe to Spend Customization v1 (Settings → Financial preferences) — gates both the generic
   *  "Upcoming bills" line and the "Credit card minimum payments" line together, since the latter
   *  is a breakout of the former, not a separate obligation category. */
  includeUpcomingBills: boolean;
  includeRemainingBudget: boolean;
}) {
  const liquidCash = computeLiquidCash(assetGroups);
  const upcomingItems = collectUpcomingItems(recurringStreams, loans, manualLoans, upcomingBillsDays);
  const { billsTotal, creditCardMinimumsTotal } = splitUpcomingTotals(upcomingItems);
  const remainingBudget = computeRemainingBudget(budgetCategories);
  const safeToSpend = computeSafeToSpend({
    liquidCash,
    upcomingBillsTotal: billsTotal,
    creditCardMinimumsTotal,
    remainingBudget,
    minimumCashBuffer,
    includeUpcomingBills,
    includeRemainingBudget,
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
        <div className={includeUpcomingBills ? 'safe-to-spend-line' : 'safe-to-spend-line excluded'}>
          <span>
            Upcoming bills (next {upcomingBillsDays} days)
            {!includeUpcomingBills && <span className="safe-to-spend-excluded-tag"> — Not included</span>}
          </span>
          <span>−{formatCurrency(includeUpcomingBills ? billsTotal : 0)}</span>
        </div>
        <div className={includeUpcomingBills ? 'safe-to-spend-line' : 'safe-to-spend-line excluded'}>
          <span>
            Credit card minimum payments
            {!includeUpcomingBills && <span className="safe-to-spend-excluded-tag"> — Not included</span>}
          </span>
          <span>−{formatCurrency(includeUpcomingBills ? creditCardMinimumsTotal : 0)}</span>
        </div>
        <div className={includeRemainingBudget ? 'safe-to-spend-line' : 'safe-to-spend-line excluded'}>
          <span>
            Remaining budget
            {!includeRemainingBudget && <span className="safe-to-spend-excluded-tag"> — Not included</span>}
          </span>
          <span>−{formatCurrency(includeRemainingBudget ? remainingBudget : 0)}</span>
        </div>
        <div className="safe-to-spend-line">
          <span>Minimum cash buffer</span>
          <span>−{formatCurrency(minimumCashBuffer)}</span>
        </div>
      </div>
    </div>
  );
}
