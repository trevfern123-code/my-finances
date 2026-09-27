import { describe, expect, it } from 'vitest';
import type { TransactionItem } from './api';
import { resolveTransactionGone } from './transactionContinuity';

// Pending → posted continuity (design §8/§9): the feed's reaction to a mutation the server refused
// because the pending row it targeted has posted or been withdrawn — the same reducer serves the
// category, approve, split-save and split-clear handlers.

function item(id: string, overrides: Partial<TransactionItem> = {}): TransactionItem {
  return {
    id,
    amount: 52.1,
    iso_currency_code: 'USD',
    date: '2026-09-10',
    name: id,
    merchant_name: null,
    category: null,
    plaid_category: null,
    pending: false,
    budget_category_id: null,
    needs_review: true,
    splits: [],
    accounts: { name: 'Checking', nickname: null, plaid_items: { institution_name: 'Bank' } },
    ...overrides,
  };
}

const superseded = (posted: TransactionItem | null | undefined) =>
  Object.assign(new Error('This pending transaction has posted. Apply the change to the posted transaction instead.'), {
    code: 'transaction_superseded',
    ...(posted === undefined ? {} : { superseded_by: posted }),
  });
const withdrawn = Object.assign(new Error('Your bank withdrew this pending transaction.'), { code: 'transaction_pending_removed' });

describe('resolveTransactionGone', () => {
  const list = [item('a'), item('pending', { pending: true }), item('c')];

  it('superseded: swaps the posted row into the dead pending row\'s slot and relays the server message', () => {
    const posted = item('posted', { amount: 60.1, pending_transaction_id: 'plaid-p', posted_from_pending_amount: 52.1 });
    const r = resolveTransactionGone(list, 'pending', superseded(posted));
    expect(r?.transactions.map((t) => t.id)).toEqual(['a', 'posted', 'c']);
    expect(r?.message).toMatch(/has posted/);
  });

  it('superseded: when the posted row is already loaded (a refresh landed first), the pending row is dropped and the loaded copy refreshed — never two copies', () => {
    const loaded = [item('a'), item('posted', { needs_review: true }), item('pending', { pending: true })];
    const fresh = item('posted', { needs_review: false, review_note: null });
    const r = resolveTransactionGone(loaded, 'pending', superseded(fresh));
    expect(r?.transactions.map((t) => t.id)).toEqual(['a', 'posted']);
    expect(r?.transactions.find((t) => t.id === 'posted')?.needs_review).toBe(false);
  });

  it('superseded without a body (defensive): the dead pending row is dropped', () => {
    const r = resolveTransactionGone(list, 'pending', superseded(undefined));
    expect(r?.transactions.map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('superseded for a row not in the list (already refreshed away): the posted row is still added once', () => {
    const posted = item('posted');
    const r = resolveTransactionGone([item('a'), item('posted')], 'pending', superseded(posted));
    expect(r?.transactions.filter((t) => t.id === 'posted')).toHaveLength(1);
  });

  it('pending_removed: the withdrawn row is dropped with the server message', () => {
    const r = resolveTransactionGone(list, 'pending', withdrawn);
    expect(r?.transactions.map((t) => t.id)).toEqual(['a', 'c']);
    expect(r?.message).toMatch(/withdrew/);
  });

  it('anything else is not a continuity outcome', () => {
    expect(resolveTransactionGone(list, 'pending', new Error('boom'))).toBeNull();
    expect(resolveTransactionGone(list, 'pending', Object.assign(new Error('x'), { code: 'preview_stale' }))).toBeNull();
    expect(resolveTransactionGone(list, 'pending', null)).toBeNull();
  });
});
