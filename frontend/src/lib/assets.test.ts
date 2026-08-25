import { describe, expect, it } from 'vitest';
import type { AssetGroup } from './api';
import { computeLiquidCash } from './assets';

function fakeGroup(overrides: Partial<AssetGroup> = {}): AssetGroup {
  return {
    category: 'checking',
    label: 'Checking',
    total: 0,
    accounts: [],
    ...overrides,
  };
}

describe('computeLiquidCash', () => {
  it('sums checking and savings groups', () => {
    const groups = [
      fakeGroup({ category: 'checking', total: 500 }),
      fakeGroup({ category: 'savings', total: 1200 }),
    ];
    expect(computeLiquidCash(groups)).toBe(1700);
  });

  it('excludes investment and other groups', () => {
    const groups = [
      fakeGroup({ category: 'checking', total: 500 }),
      fakeGroup({ category: 'investment', total: 50000 }),
      fakeGroup({ category: 'other', total: 100 }),
    ];
    expect(computeLiquidCash(groups)).toBe(500);
  });

  it('returns 0 for no groups', () => {
    expect(computeLiquidCash([])).toBe(0);
  });

  it('returns 0 when only non-liquid groups are present', () => {
    expect(computeLiquidCash([fakeGroup({ category: 'investment', total: 50000 })])).toBe(0);
  });
});
