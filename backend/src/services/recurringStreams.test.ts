import { describe, expect, it } from 'vitest';
import { normalizeToMonthlyAmount } from './recurringStreams';

describe('normalizeToMonthlyAmount', () => {
  it('leaves a monthly amount unchanged', () => {
    expect(normalizeToMonthlyAmount(100, 'MONTHLY')).toBe(100);
  });

  it('converts weekly to its monthly equivalent', () => {
    expect(normalizeToMonthlyAmount(10, 'WEEKLY')).toBeCloseTo(43.33, 1);
  });

  it('converts biweekly to its monthly equivalent', () => {
    expect(normalizeToMonthlyAmount(50, 'BIWEEKLY')).toBeCloseTo(108.33, 1);
  });

  it('converts semi-monthly to double the per-occurrence amount', () => {
    expect(normalizeToMonthlyAmount(20, 'SEMI_MONTHLY')).toBe(40);
  });

  it('converts annually to a twelfth of the amount', () => {
    expect(normalizeToMonthlyAmount(120, 'ANNUALLY')).toBe(10);
  });

  it('treats an unknown frequency as already-monthly rather than excluding it', () => {
    expect(normalizeToMonthlyAmount(75, 'UNKNOWN')).toBe(75);
  });
});
