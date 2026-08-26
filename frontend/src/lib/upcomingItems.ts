import type { Loan, ManualLoan, RecurringStream } from './api';
import { daysBetween, estimateNextDueDate, parseDate, todayUtc } from './recurringDates';

export interface UpcomingItem {
  id: string;
  name: string;
  amount: number;
  dueDate: Date;
  days: number;
  /** 'credit_card_minimum' is a Plaid-linked loan with loan_type 'credit' — broken out from plain
   *  'loan' (student/mortgage/personal) so Safe to Spend can give it its own breakdown line
   *  without double-counting it in the generic bills total. */
  kind: 'bill' | 'loan' | 'credit_card_minimum';
}

/** Recurring outflows and loan payments due within `daysAhead` days — shared by the Overview
 *  page's Upcoming Bills widget and the Safe to Spend calculation, so both agree on exactly
 *  what counts as "coming up" and by how much. `today` is overridable purely for deterministic
 *  testing, mirroring the same pattern already used by estimateNextDueDate/budgetDrilldown. */
export function collectUpcomingItems(
  recurringStreams: RecurringStream[],
  loans: Loan[],
  manualLoans: ManualLoan[],
  daysAhead: number,
  today: Date = todayUtc()
): UpcomingItem[] {
  const items: UpcomingItem[] = [];

  for (const s of recurringStreams) {
    if (s.direction !== 'outflow' || !s.is_active) continue;
    const due = estimateNextDueDate(s.last_date, s.frequency, today);
    if (!due) continue;
    const days = daysBetween(today, due);
    if (days < 0 || days > daysAhead) continue;
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
    if (days < 0 || days > daysAhead) continue;
    items.push({
      id: `loan-${loan.id}`,
      name: loan.name ?? loan.account_name ?? 'Loan',
      amount: loan.minimum_payment_amount,
      dueDate: due,
      days,
      kind: loan.loan_type === 'credit' ? 'credit_card_minimum' : 'loan',
    });
  }

  for (const loan of manualLoans) {
    if (!loan.next_payment_due_date || !loan.minimum_payment_amount) continue;
    const due = parseDate(loan.next_payment_due_date);
    const days = daysBetween(today, due);
    if (days < 0 || days > daysAhead) continue;
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
