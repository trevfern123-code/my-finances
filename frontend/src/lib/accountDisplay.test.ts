import { describe, expect, it } from 'vitest';
import { accountDisplayName, sortAccountsByOrder } from './accountDisplay';

describe('accountDisplayName', () => {
  it('uses the nickname when one is set', () => {
    expect(accountDisplayName({ name: 'Plaid Checking', nickname: 'Joint checking' })).toBe('Joint checking');
  });

  it('falls back to the Plaid name when there is no nickname', () => {
    expect(accountDisplayName({ name: 'Plaid Checking', nickname: null })).toBe('Plaid Checking');
  });
});

describe('sortAccountsByOrder', () => {
  it('sorts ascending by sort_order', () => {
    const accounts = [{ id: 'c', sort_order: 2 }, { id: 'a', sort_order: 0 }, { id: 'b', sort_order: 1 }];
    expect(sortAccountsByOrder(accounts).map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input array', () => {
    const accounts = [{ id: 'b', sort_order: 1 }, { id: 'a', sort_order: 0 }];
    const original = [...accounts];
    sortAccountsByOrder(accounts);
    expect(accounts).toEqual(original);
  });
});
