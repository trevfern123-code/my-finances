import type { Loan, ManualLoan, RecurringStream } from '../lib/api';

const DAYS_AHEAD = 14;

function formatCurrency(amount: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function parseDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

function dueLabel(days: number): string {
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/** Recurring streams have no explicit "next due" date — only when it last occurred and how
 *  often. Estimate the next occurrence from last_date + frequency; irregular/unknown-cadence
 *  streams can't be estimated and are skipped rather than guessed at. */
function estimateNextDueDate(lastDate: string, frequency: string): Date | null {
  const date = parseDate(lastDate);
  switch (frequency) {
    case 'WEEKLY':
      date.setUTCDate(date.getUTCDate() + 7);
      break;
    case 'BIWEEKLY':
      date.setUTCDate(date.getUTCDate() + 14);
      break;
    case 'SEMI_MONTHLY':
      date.setUTCDate(date.getUTCDate() + 15);
      break;
    case 'MONTHLY':
      date.setUTCMonth(date.getUTCMonth() + 1);
      break;
    case 'ANNUALLY':
      date.setUTCFullYear(date.getUTCFullYear() + 1);
      break;
    default:
      return null;
  }
  return date;
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
