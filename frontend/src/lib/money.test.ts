import { describe, expect, it } from 'vitest';
import { roundToCents } from './money';

describe('roundToCents', () => {
  it('corrects float drift from subtraction back to a clean cent value', () => {
    expect(roundToCents(4.33 - 3)).toBe(1.33);
  });

  it('corrects float drift from repeated addition', () => {
    expect(roundToCents(0.1 + 0.2)).toBe(0.3);
  });

  it('leaves an already-clean value unchanged', () => {
    expect(roundToCents(42.5)).toBe(42.5);
    expect(roundToCents(0)).toBe(0);
  });

  it('handles negative amounts (e.g. a credit/refund)', () => {
    expect(roundToCents(-4.999999999999998)).toBe(-5);
  });
});
