import type { AssetGroup, BudgetCategory, Loan, ManualLoan, RecurringStream } from '../lib/api';
import { computeLiquidCash } from '../lib/assets';
import { collectUpcomingItems } from '../lib/upcomingItems';
import { computeRemainingBudget, computeSafeToSpend, splitUpcomingTotals } from '../lib/safeToSpend';
import { formatCurrency } from '../lib/currency';
import type { BudgetView } from '../lib/semanticModel';
import { withheldText } from '../lib/semanticPresentation';

export function SafeToSpend({
  assetGroups,
  recurringStreams,
  loans,
  manualLoans,
  budgetCategories,
  budgetSemantics,
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
  /** The role-aware spending per budget category: the input of "Remaining budget" (design §5 C7). */
  budgetSemantics: BudgetView;
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
  // Remaining budget exists only when the budget's role-aware state is `ok` AND every category has
  // its spending. The state decides first: an empty category list is not evidence of anything while
  // the state is withheld (the list on screen may be an earlier read), so it must not turn into a
  // remaining budget of zero. Without a remaining budget — and while that line is included — there
  // is no Safe to Spend figure either: the frozen `spent` is never used in its place.
  const spendingByCategory = budgetSemantics.kind === 'ok' ? budgetSemantics.byCategoryId : null;
  const budgetInputs = budgetCategories.map((c) => ({ budget_amount: c.budget_amount, spending: spendingByCategory?.get(c.id)?.spending }));
  const remainingBudget =
    spendingByCategory !== null && budgetInputs.every((c): c is { budget_amount: number; spending: number } => c.spending !== undefined)
      ? computeRemainingBudget(budgetInputs)
      : null;
  const safeToSpend =
    remainingBudget === null && includeRemainingBudget
      ? null
      : computeSafeToSpend({
          liquidCash,
          upcomingBillsTotal: billsTotal,
          creditCardMinimumsTotal,
          remainingBudget: remainingBudget ?? 0,
          minimumCashBuffer,
          includeUpcomingBills,
          includeRemainingBudget,
        });
  const withheld = withheldText(budgetSemantics.kind === 'ok' ? { kind: 'invalid' } : budgetSemantics);

  return (
    <div className="card safe-to-spend-card">
      <h2>Safe to spend</h2>
      {safeToSpend === null ? (
        <>
          <div className="safe-to-spend-value safe-to-spend-withheld">—</div>
          <p className={withheld.tone === 'alert' ? 'error' : 'hint'} role={withheld.tone === 'alert' ? 'alert' : 'status'}>
            {withheld.short} Remaining budget isn't available, so this can't be worked out yet.
          </p>
        </>
      ) : (
        <div className={safeToSpend < 0 ? 'safe-to-spend-value negative' : 'safe-to-spend-value'}>
          {formatCurrency(safeToSpend)}
        </div>
      )}
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
          <span>{remainingBudget === null && includeRemainingBudget ? '—' : `−${formatCurrency(includeRemainingBudget ? (remainingBudget ?? 0) : 0)}`}</span>
        </div>
        <div className="safe-to-spend-line">
          <span>Minimum cash buffer</span>
          <span>−{formatCurrency(minimumCashBuffer)}</span>
        </div>
      </div>
    </div>
  );
}
