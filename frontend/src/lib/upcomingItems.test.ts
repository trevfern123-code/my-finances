import { describe, expect, it } from 'vitest';
import type { Loan, ManualLoan, RecurringStream } from './api';
import { collectUpcomingItems } from './upcomingItems';

const TODAY = new Date('2026-08-15T00:00:00.000Z');

function fakeStream(overrides: Partial<RecurringStream> = {}): RecurringStream {
  return {
    id: 'stream-1',
    description: 'Netflix',
    merchant_name: 'Netflix',
    direction: 'outflow',
    frequency: 'MONTHLY',
    average_amount: 15.99,
    last_amount: 15.99,
    iso_currency_code: 'USD',
    first_date: '2026-01-15',
    last_date: '2026-07-15',
    is_active: true,
    status: 'MATURE',
    category: null,
    monthly_amount: 15.99,
    ...overrides,
  };
}

function fakeLoan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 'loan-1',
    loan_type: 'student',
    name: 'Student Loan',
    account_name: null,
    current_balance: 5000,
    iso_currency_code: 'USD',
    interest_rate_percentage: 5,
    origination_principal_amount: 10000,
    origination_date: '2020-01-01',
    minimum_payment_amount: 100,
    next_payment_due_date: '2026-08-20',
    last_payment_amount: 100,
    last_payment_date: '2026-07-20',
    is_overdue: false,
    payoff_progress_pct: 50,
    ...overrides,
  };
}

function fakeManualLoan(overrides: Partial<ManualLoan> = {}): ManualLoan {
  return {
    id: 'manual-loan-1',
    name: 'SoFi Personal Loan',
    loan_type: 'personal',
    current_balance: 2000,
    origination_principal_amount: 5000,
    interest_rate_percentage: 8,
    origination_date: '2024-01-01',
    term_months: 36,
    minimum_payment_amount: 200,
    next_payment_due_date: '2026-08-25',
    notes: null,
    match_text: null,
    payoff_progress_pct: 60,
    lifetime_principal_paid: 3000,
    lifetime_interest_paid: 400,
    ...overrides,
  };
}

describe('collectUpcomingItems', () => {
  it('includes an active outflow stream whose estimated next charge falls within daysAhead', () => {
    // last_date 2026-07-15, MONTHLY -> next estimated occurrence is 2026-08-15 (= today).
    const stream = fakeStream({ last_date: '2026-07-15', frequency: 'MONTHLY' });
    const items = collectUpcomingItems([stream], [], [], 14, TODAY);
    expect(items).toEqual([
      { id: 'stream-stream-1', name: 'Netflix', amount: 15.99, dueDate: new Date('2026-08-15T00:00:00.000Z'), days: 0, kind: 'bill' },
    ]);
  });

  it('excludes an inflow stream (recurring income is not an upcoming bill)', () => {
    const stream = fakeStream({ direction: 'inflow' });
    expect(collectUpcomingItems([stream], [], [], 14, TODAY)).toEqual([]);
  });

  it('excludes an inactive stream', () => {
    const stream = fakeStream({ is_active: false });
    expect(collectUpcomingItems([stream], [], [], 14, TODAY)).toEqual([]);
  });

  it('excludes a stream whose next estimated charge is further out than daysAhead', () => {
    // last_date 2026-07-15, MONTHLY -> next occurrence 2026-08-15; with only a 0-day window
    // anything not due exactly today is excluded.
    const farOut = fakeStream({ last_date: '2026-01-01', frequency: 'ANNUALLY' });
    expect(collectUpcomingItems([farOut], [], [], 7, TODAY)).toEqual([]);
  });

  it('includes a Plaid-linked loan payment due within the window', () => {
    const loan = fakeLoan({ next_payment_due_date: '2026-08-20', minimum_payment_amount: 100 });
    const items = collectUpcomingItems([], [loan], [], 14, TODAY);
    expect(items).toEqual([
      { id: 'loan-loan-1', name: 'Student Loan', amount: 100, dueDate: new Date('2026-08-20T00:00:00.000Z'), days: 5, kind: 'loan' },
    ]);
  });

  it('includes a manual loan payment due within the window', () => {
    const loan = fakeManualLoan({ next_payment_due_date: '2026-08-25', minimum_payment_amount: 200 });
    const items = collectUpcomingItems([], [], [loan], 14, TODAY);
    expect(items).toEqual([
      { id: 'manual-loan-manual-loan-1', name: 'SoFi Personal Loan', amount: 200, dueDate: new Date('2026-08-25T00:00:00.000Z'), days: 10, kind: 'loan' },
    ]);
  });

  it('tags a credit-type Plaid loan as credit_card_minimum, not plain loan', () => {
    const card = fakeLoan({ loan_type: 'credit', name: 'Chase Sapphire', minimum_payment_amount: 35 });
    const items = collectUpcomingItems([], [card], [], 14, TODAY);
    expect(items).toEqual([
      { id: 'loan-loan-1', name: 'Chase Sapphire', amount: 35, dueDate: new Date('2026-08-20T00:00:00.000Z'), days: 5, kind: 'credit_card_minimum' },
    ]);
  });

  it('keeps student/mortgage Plaid loans and manual loans tagged as plain loan, not credit_card_minimum', () => {
    const student = fakeLoan({ loan_type: 'student' });
    const mortgage = fakeLoan({ id: 'loan-2', loan_type: 'mortgage', next_payment_due_date: '2026-08-21' });
    const manual = fakeManualLoan();
    const items = collectUpcomingItems([], [student, mortgage], [manual], 14, TODAY);
    expect(items.every((i) => i.kind === 'loan')).toBe(true);
  });

  it('excludes a loan with no next_payment_due_date or no minimum_payment_amount', () => {
    const noDueDate = fakeLoan({ next_payment_due_date: null });
    const noMinPayment = fakeLoan({ minimum_payment_amount: null });
    expect(collectUpcomingItems([], [noDueDate, noMinPayment], [], 14, TODAY)).toEqual([]);
  });

  it('excludes an already-overdue loan payment (current behavior: only forward-looking items are "upcoming")', () => {
    const overdue = fakeLoan({ next_payment_due_date: '2026-08-01' });
    expect(collectUpcomingItems([], [overdue], [], 14, TODAY)).toEqual([]);
  });

  it('sorts mixed bills and loans by due date ascending, regardless of kind', () => {
    const stream = fakeStream({ last_date: '2026-08-14', frequency: 'WEEKLY' }); // -> 2026-08-21
    const loan = fakeLoan({ next_payment_due_date: '2026-08-16' });
    const manual = fakeManualLoan({ next_payment_due_date: '2026-08-15' });
    const items = collectUpcomingItems([stream], [loan], [manual], 14, TODAY);
    expect(items.map((i) => i.id)).toEqual(['manual-loan-manual-loan-1', 'loan-loan-1', 'stream-stream-1']);
  });
});
