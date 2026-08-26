import type { Loan, ManualLoan, RecurringStream } from '../lib/api';
import { dueLabel } from '../lib/recurringDates';
import { collectUpcomingItems } from '../lib/upcomingItems';
import { formatCurrency } from '../lib/currency';

export const UPCOMING_BILLS_DAYS_AHEAD = 14;

export function UpcomingBills({
  recurringStreams,
  loans,
  manualLoans,
}: {
  recurringStreams: RecurringStream[];
  loans: Loan[];
  manualLoans: ManualLoan[];
}) {
  const items = collectUpcomingItems(recurringStreams, loans, manualLoans, UPCOMING_BILLS_DAYS_AHEAD);
  const total = items.reduce((sum, i) => sum + i.amount, 0);

  return (
    <div className="card">
      <div className="section-header">
        <h2>Upcoming bills</h2>
        {items.length > 0 && (
          <span className="monthly-total-badge">{formatCurrency(total)} due in 14 days</span>
        )}
      </div>
      {items.length === 0 ? (
        <p className="hint">Nothing due in the next 14 days.</p>
      ) : (
        <ul className="quick-view-list">
          {items.map((item) => (
            <li key={item.id} className="upcoming-bill-row">
              <span className="upcoming-bill-name">
                {item.name}
                {item.kind === 'loan' && <span className="account-type"> — loan payment</span>}
              </span>
              <span className={item.days <= 2 ? 'due-badge soon' : 'due-badge'}>{dueLabel(item.days)}</span>
              <span className="balance">{formatCurrency(item.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
