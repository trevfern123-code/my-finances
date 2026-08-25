import { describe, expect, it } from 'vitest';
import { CATEGORY_COLOR_OPTIONS, isCategoryColorOption } from './categoryColors';

describe('isCategoryColorOption', () => {
  it('accepts every curated swatch', () => {
    for (const color of CATEGORY_COLOR_OPTIONS) {
      expect(isCategoryColorOption(color)).toBe(true);
    }
  });

  it('rejects a value outside the curated set', () => {
    expect(isCategoryColorOption('#000000')).toBe(false);
  });
});
