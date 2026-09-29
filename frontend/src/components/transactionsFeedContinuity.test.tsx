// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

afterEach(cleanup);
import { TransactionsFeed } from './TransactionsFeed';
import type { BudgetCategory, TransactionItem } from '../lib/api';

// Pending → posted continuity (design §9): a posted row that replaced a pending one says so when the
// amount changed, and shows why continuity re-flagged it until it is approved.

function item(overrides: Partial<TransactionItem>): TransactionItem {
  return {
    id: 'q1',
    amount: 60.1,
    iso_currency_code: 'USD',
    date: '2026-09-12',
    name: 'Restaurant',
    merchant_name: null,
    category: 'FOOD_AND_DRINK',
    plaid_category: null,
    pending: false,
    budget_category_id: null,
    needs_review: true,
    splits: [],
    accounts: { name: 'Checking', nickname: null, plaid_items: { institution_name: 'Bank' } },
    ...overrides,
  };
}

const categories: BudgetCategory[] = [];

function renderFeed(transactions: TransactionItem[]) {
  return render(
    <TransactionsFeed
      transactions={transactions}
      budgetCategories={categories}
      syncing={false}
      onSync={vi.fn()}
      onCategorize={vi.fn()}
      onApprove={vi.fn()}
      onSaveSplits={vi.fn(async () => undefined)}
      onClearSplits={vi.fn(async () => undefined)}
    />
  );
}

describe('TransactionsFeed — pending → posted continuity', () => {
  it('shows the pending amount a posted row replaced, and the review note while unreviewed', () => {
    renderFeed([
      item({
        pending_transaction_id: 'p1',
        posted_from_pending_amount: 52.1,
        review_note: 'Amount changed from 52.10 to 60.10; splits removed',
      }),
    ]);
    expect(screen.getByText(/Posted · was pending \$52\.10/)).toBeTruthy();
    expect(screen.getByText('Amount changed from 52.10 to 60.10; splits removed')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });

  it('says nothing about pending when the amount did not change, and hides the note once approved', () => {
    renderFeed([
      item({ id: 'q2', pending_transaction_id: 'p2', posted_from_pending_amount: null, review_note: null }),
      item({ id: 'q3', needs_review: false, review_note: 'stale note the server would have cleared' }),
    ]);
    expect(screen.queryByText(/was pending/)).toBeNull();
    expect(screen.queryByText(/stale note/)).toBeNull();
  });
});
