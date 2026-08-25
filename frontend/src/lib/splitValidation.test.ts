import { describe, expect, it } from 'vitest';
import { computeSplitBalance, hasIncompleteRow } from './splitValidation';

describe('computeSplitBalance', () => {
  it('is balanced when rows sum exactly to the total', () => {
    const result = computeSplitBalance(
      [
        { budget_category_id: 'a', amount: '30' },
        { budget_category_id: 'b', amount: '20' },
      ],
      50
    );
    expect(result).toEqual({ parsedTotal: 50, remaining: 0, balanced: true });
  });

  it('reports a positive remaining when under-allocated', () => {
    const result = computeSplitBalance([{ budget_category_id: 'a', amount: '30' }], 50);
    expect(result.remaining).toBe(20);
    expect(result.balanced).toBe(false);
  });

  it('reports a negative remaining when over-allocated', () => {
    const result = computeSplitBalance([{ budget_category_id: 'a', amount: '80' }], 50);
    expect(result.remaining).toBe(-30);
    expect(result.balanced).toBe(false);
  });

  it('treats blank/invalid amounts as zero rather than NaN', () => {
    const result = computeSplitBalance(
      [
        { budget_category_id: 'a', amount: '' },
        { budget_category_id: 'b', amount: '50' },
      ],
      50
    );
    expect(result.balanced).toBe(true);
  });

  it("is balanced despite float drift a naive sum would miss (mirrors the backend's own case)", () => {
    // 4.33 split into 3 + 1.33 — plain (3 + 1.33) - 4.33 leaves float dust in raw JS arithmetic.
    const result = computeSplitBalance(
      [
        { budget_category_id: 'a', amount: '3' },
        { budget_category_id: 'b', amount: '1.33' },
      ],
      4.33
    );
    expect(result.balanced).toBe(true);
  });

  it('is never balanced with zero rows unless the total itself is zero', () => {
    expect(computeSplitBalance([], 50).balanced).toBe(false);
    expect(computeSplitBalance([], 0).balanced).toBe(true);
  });
});

describe('hasIncompleteRow', () => {
  it('is false when every row has a category and a positive amount', () => {
    expect(
      hasIncompleteRow([
        { budget_category_id: 'a', amount: '10' },
        { budget_category_id: 'b', amount: '20' },
      ])
    ).toBe(false);
  });

  it('is true when a row is missing a category', () => {
    expect(hasIncompleteRow([{ budget_category_id: '', amount: '10' }])).toBe(true);
  });

  it('is true when a row is missing an amount', () => {
    expect(hasIncompleteRow([{ budget_category_id: 'a', amount: '' }])).toBe(true);
  });

  it('is true when a row has a zero or negative amount', () => {
    expect(hasIncompleteRow([{ budget_category_id: 'a', amount: '0' }])).toBe(true);
    expect(hasIncompleteRow([{ budget_category_id: 'a', amount: '-5' }])).toBe(true);
  });
});
