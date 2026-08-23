import { describe, expect, it } from 'vitest';
import { groupAccountsForAssetsSummary, type AssetAccount } from './assetsSummary';

function account(overrides: Partial<AssetAccount> = {}): AssetAccount {
  return {
    id: 'acc-1',
    name: 'Account',
    official_name: null,
    type: 'depository',
    subtype: 'checking',
    current_balance: 100,
    iso_currency_code: 'USD',
    institution_name: 'Chase',
    ...overrides,
  };
}

describe('groupAccountsForAssetsSummary', () => {
  it('buckets a checking account under checking', () => {
    const groups = groupAccountsForAssetsSummary([account({ subtype: 'checking' })]);
    expect(groups.map((g) => g.category)).toEqual(['checking']);
  });

  it('buckets a savings account under savings', () => {
    const groups = groupAccountsForAssetsSummary([account({ subtype: 'savings' })]);
    expect(groups.map((g) => g.category)).toEqual(['savings']);
  });

  it('buckets an investment-type account under investment regardless of subtype (401k, ira, brokerage, ...)', () => {
    const groups = groupAccountsForAssetsSummary([
      account({ id: 'a', type: 'investment', subtype: '401k' }),
      account({ id: 'b', type: 'investment', subtype: 'ira' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe('investment');
    expect(groups[0].accounts).toHaveLength(2);
  });

  it('buckets a depository account with an unrecognized subtype (e.g. money market) under other', () => {
    const groups = groupAccountsForAssetsSummary([account({ subtype: 'money market' })]);
    expect(groups.map((g) => g.category)).toEqual(['other']);
  });

  it('excludes credit and loan account types entirely — they are liabilities, not assets', () => {
    const groups = groupAccountsForAssetsSummary([
      account({ type: 'credit', subtype: 'credit card' }),
      account({ type: 'loan', subtype: 'student' }),
    ]);
    expect(groups).toEqual([]);
  });

  it('sums current_balance per group, treating a null balance as zero', () => {
    const groups = groupAccountsForAssetsSummary([
      account({ id: 'a', current_balance: 100 }),
      account({ id: 'b', current_balance: 50 }),
      account({ id: 'c', current_balance: null }),
    ]);
    expect(groups[0].total).toBe(150);
  });

  it('omits empty categories rather than returning them with a zero total', () => {
    const groups = groupAccountsForAssetsSummary([account({ subtype: 'checking' })]);
    expect(groups.find((g) => g.category === 'savings')).toBeUndefined();
  });

  it('returns an empty array for no accounts', () => {
    expect(groupAccountsForAssetsSummary([])).toEqual([]);
  });
});
