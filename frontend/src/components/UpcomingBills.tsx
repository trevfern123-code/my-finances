import type { Loan, ManualLoan, RecurringStream } from '../lib/api';
import { daysBetween, dueLabel, estimateNextDueDate, parseDate, todayUtc } from '../lib/recurringDates';

const DAYS_AHEAD = 14;

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

interface UpcomingItem {
  id: string;
  name: string;
  amount: number;
  dueDate: Date;
  days: number;
  kind: 'bill' | 'loan';
}

function collectUpcoming(
  recurringStreams: RecurringStream[],
  loans: Loan[],
  manualLoans: ManualLoan[]
): UpcomingItem[] {
  const today = todayUtc();
  const items: UpcomingItem[] = [];

  for (const s of recurringStreams) {
    if (s.direction !== 'outflow' || !s.is_active) continue;
    const due = estimateNextDueDate(s.last_date, s.frequency);
    if (!due) continue;
    const days = daysBetween(today, due);
    if (days < 0 || days > DAYS_AHEAD) continue;
    items.push({
      id: `stream-${s.id}`,
      name: s.merchant_name ?? s.description,
      amount: s.last_amount,
      dueDate: due,
      days,
      kind: 'bill',
    });
  }

  for (const loan of loans) {
    if (!loan.next_payment_due_date || !loan.minimum_payment_amount) continue;
    const due = parseDate(loan.next_payment_due_date);
    const days = daysBetween(today, due);
    if (days < 0 || days > DAYS_AHEAD) continue;
    items.push({
      id: `loan-${loan.id}`,
      name: loan.name ?? loan.account_name ?? 'Loan',
      amount: loan.minimum_payment_amount,
      dueDate: due,
      days,
      kind: 'loan',
    });
  }

  for (const loan of manualLoans) {
    if (!loan.next_payment_due_date || !loan.minimum_payment_amount) continue;
    const due = parseDate(loan.next_payment_due_date);
    const days = daysBetween(today, due);
    if (days < 0 || days > DAYS_AHEAD) continue;
    items.push({
      id: `manual-loan-${loan.id}`,
      name: loan.name,
      amount: loan.minimum_payment_amount,
      dueDate: due,
      days,
      kind: 'loan',
    });
  }

  return items.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

export function UpcomingBills({
  recurringStreams,
  loans,
  manualLoans,
}: {
  recurringStreams: RecurringStream[];
  loans: Loan[];
  manualLoans: ManualLoan[];
}) {
  const items = collectUpcoming(recurringStreams, loans, manualLoans);
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
