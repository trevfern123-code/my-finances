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
    savings_goal: null,
    nickname: null,
    color: null,
    icon: null,
    sort_order: 0,
    hidden: false,
    exclude_from_net_worth: false,
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

  it('never excludes a hidden account from the total — hidden is display-only, not a calculation input', () => {
    const groups = groupAccountsForAssetsSummary([
      account({ id: 'a', current_balance: 100, hidden: false }),
      account({ id: 'b', current_balance: 50, hidden: true }),
    ]);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(['a', 'b']);
    expect(groups[0].total).toBe(150);
  });

  it('keeps a net-worth-excluded account visible in its bucket but leaves it out of the total', () => {
    const groups = groupAccountsForAssetsSummary([
      account({ id: 'a', current_balance: 100, exclude_from_net_worth: false }),
      account({ id: 'b', current_balance: 50, exclude_from_net_worth: true }),
    ]);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(['a', 'b']);
    expect(groups[0].total).toBe(100);
  });

  it('an account that is both hidden and net-worth-excluded is still excluded only from the total, not the list', () => {
    const groups = groupAccountsForAssetsSummary([
      account({ id: 'a', current_balance: 100 }),
      account({ id: 'b', current_balance: 50, hidden: true, exclude_from_net_worth: true }),
    ]);
    expect(groups[0].accounts.map((a) => a.id)).toEqual(['a', 'b']);
    expect(groups[0].total).toBe(100);
  });
});
