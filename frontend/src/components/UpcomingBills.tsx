import type { Loan, ManualLoan, RecurringStream } from '../lib/api';
import { dueLabel } from '../lib/recurringDates';
import { collectUpcomingItems, type UpcomingItem } from '../lib/upcomingItems';
import { formatCurrency } from '../lib/currency';

/** Where a row's date comes from: recurring dates and amounts are estimated from the last charge
 *  and its cadence; loan and card payments carry a due date on their own record. */
const KIND_LABEL: Record<UpcomingItem['kind'], string> = {
  bill: 'Estimated date and amount',
  loan: 'Loan payment',
  credit_card_minimum: 'Card minimum payment',
};

export function UpcomingBills({
  recurringStreams,
  loans,
  manualLoans,
  daysAhead,
}: {
  recurringStreams: RecurringStream[];
  loans: Loan[];
  manualLoans: ManualLoan[];
  /** User-configurable look-ahead window (Settings → Financial preferences) — also drives Safe to
   *  Spend's "Upcoming bills" figure, so the two always agree on what "upcoming" means. */
  daysAhead: number;
}) {
  const items = collectUpcomingItems(recurringStreams, loans, manualLoans, daysAhead);
  const total = items.reduce((sum, i) => sum + i.amount, 0);

  return (
    <div className="card upcoming-bills-card">
      <div className="section-header">
        <h2>Upcoming bills</h2>
        {items.length > 0 && (
          <span className="monthly-total-badge">
            {formatCurrency(total)} due within {daysAhead} days
          </span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="hint">
          No upcoming items detected in the next {daysAhead} days. This checks recurring transactions
          and saved loan and card due dates, so other bills may still be due.
        </p>
      ) : (
        <>
          <ul className="quick-view-list">
            {items.map((item) => (
              <li key={item.id} className="upcoming-bill-row">
                <span className="upcoming-bill-name">
                  <span className="upcoming-bill-title">{item.name}</span>
                  <span className="account-type">{KIND_LABEL[item.kind]}</span>
                </span>
                <span className={item.days <= 2 ? 'due-badge soon' : 'due-badge'}>{dueLabel(item.days)}</span>
                <span className="balance">{formatCurrency(item.amount)}</span>
              </li>
            ))}
          </ul>
          <p className="hint card-source-note">
            Based on recurring transactions we've detected and saved loan and card due dates, so it
            may not include every bill.
          </p>
        </>
      )}
    </div>
  );
}
