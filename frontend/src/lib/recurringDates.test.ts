import { describe, expect, it } from 'vitest';
import { daysBetween, dueLabel, estimateNextDueDate, parseDate } from './recurringDates';

const TODAY = new Date('2026-08-15T00:00:00.000Z');

describe('estimateNextDueDate', () => {
  it('steps a monthly stream forward until it reaches today or later', () => {
    // Last charged 2026-06-20 — one MONTHLY step lands on 2026-07-20 (still past), a second on
    // 2026-08-20 (>= today), so that's the projected next date.
    const result = estimateNextDueDate('2026-06-20', 'MONTHLY', TODAY);
    expect(result).toEqual(parseDate('2026-08-20'));
  });

  it('returns the last date unchanged if it is already today or in the future', () => {
    const result = estimateNextDueDate('2026-08-20', 'MONTHLY', TODAY);
    expect(result).toEqual(parseDate('2026-08-20'));
  });

  it('steps a weekly stream forward by 7 days at a time', () => {
    const result = estimateNextDueDate('2026-08-01', 'WEEKLY', TODAY);
    // 08-01 -> 08-08 -> 08-15 (>= today)
    expect(result).toEqual(parseDate('2026-08-15'));
  });

  it('steps an annual stream forward by full years', () => {
    // 2025-08-01 -> 2026-08-01 is still before TODAY (2026-08-15), so it needs a second step.
    const result = estimateNextDueDate('2025-08-01', 'ANNUALLY', TODAY);
    expect(result).toEqual(parseDate('2027-08-01'));
  });

  it('returns null for an unknown/irregular cadence rather than guessing', () => {
    expect(estimateNextDueDate('2026-01-01', 'UNKNOWN', TODAY)).toBeNull();
  });
});

describe('daysBetween', () => {
  it('counts whole days between two UTC dates', () => {
    expect(daysBetween(parseDate('2026-08-10'), parseDate('2026-08-15'))).toBe(5);
  });

  it('returns a negative number when the second date is earlier', () => {
    expect(daysBetween(parseDate('2026-08-15'), parseDate('2026-08-10'))).toBe(-5);
  });

  it('returns zero for the same date', () => {
    expect(daysBetween(parseDate('2026-08-15'), parseDate('2026-08-15'))).toBe(0);
  });
});

describe('dueLabel', () => {
  it('labels a negative day count as overdue', () => {
    expect(dueLabel(-1)).toBe('overdue');
  });

  it('labels zero as today and one as tomorrow', () => {
    expect(dueLabel(0)).toBe('today');
    expect(dueLabel(1)).toBe('tomorrow');
  });

  it('labels anything further out with a day count', () => {
    expect(dueLabel(5)).toBe('in 5 days');
  });
});
