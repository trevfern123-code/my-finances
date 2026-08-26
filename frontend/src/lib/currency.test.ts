import { describe, expect, it } from 'vitest';
import { formatCurrency, formatCurrencyWhole } from './currency';

describe('formatCurrency', () => {
  it('formats a positive amount with cents in USD by default', () => {
    expect(formatCurrency(1234.5)).toBe('$1,234.50');
  });

  it('formats a negative amount', () => {
    expect(formatCurrency(-42.1)).toBe('-$42.10');
  });

  it('formats zero', () => {
    expect(formatCurrency(0)).toBe('$0.00');
  });

  it('renders an em dash for a null amount instead of throwing', () => {
    expect(formatCurrency(null)).toBe('—');
  });

  it('respects an explicit currency code', () => {
    expect(formatCurrency(10, 'EUR')).toBe('€10.00');
  });

  it('falls back to USD when currency is null or omitted', () => {
    expect(formatCurrency(10, null)).toBe('$10.00');
    expect(formatCurrency(10)).toBe('$10.00');
  });
});

describe('formatCurrencyWhole', () => {
  it('rounds to whole dollars with no cents', () => {
    expect(formatCurrencyWhole(1234.5)).toBe('$1,235');
  });

  it('formats a negative whole-dollar amount', () => {
    expect(formatCurrencyWhole(-76844.15)).toBe('-$76,844');
  });
});
