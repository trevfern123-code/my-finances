// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

import type {
  AssetAccountSummary,
  AssetGroup,
  BudgetCategory,
  Loan,
  ManualLoan,
  NetWorthPoint,
  RecurringStream,
  TransactionItem,
} from '../lib/api';
import { collectUpcomingItems } from '../lib/upcomingItems';
import { AccountQuickView } from './AccountQuickView';
import { NetWorthChart } from './NetWorthChart';
import { RecentActivity } from './RecentActivity';
import { UpcomingBills } from './UpcomingBills';

// Command Center V2.1, UI Packet 03 — the four Overview support cards say only what their existing
// props can prove. These tests pin the source labels and the states that must never read as complete
// or current. Every name and amount is synthetic. Nothing here asserts how a missing balance is
// treated in a total: that is an open financial-contract question (MF-ACC-BALANCE-NULL-COVERAGE-01).

const NO_FRESHNESS_OR_HEALTH_CLAIM = /refreshed|synced|all accounts|all banks|healthy|verified|fully covered|last updated/i;

const account = (overrides: Partial<AssetAccountSummary> = {}): AssetAccountSummary => ({
  id: 'a1',
  name: 'Synthetic Checking',
  official_name: null,
  type: 'depository',
  subtype: 'checking',
  current_balance: 1200.5,
  iso_currency_code: 'USD',
  institution_name: 'Example Bank',
  savings_goal: null,
  nickname: null,
  color: null,
  icon: null,
  sort_order: 0,
  hidden: false,
  exclude_from_net_worth: false,
  ...overrides,
});

const group = (category: AssetGroup['category'], accounts: AssetAccountSummary[], total = 0): AssetGroup => ({
  category,
  label: category,
  total,
  accounts,
});

describe('Accounts at a glance', () => {
  afterEach(cleanup);

  const rows = (container: HTMLElement) => [...container.querySelectorAll('.account-quick-row')];

  it('lists visible checking and savings accounts and leaves others out', () => {
    const { container } = render(
      <AccountQuickView
        assetGroups={[
          group('checking', [account({ id: 'c', name: 'Visible Checking' }), account({ id: 'h', name: 'Hidden Checking', hidden: true })]),
          group('savings', [account({ id: 's', name: 'Visible Savings', current_balance: 300 })]),
          group('investment', [account({ id: 'i', name: 'Brokerage' })]),
        ]}
      />
    );
    expect(rows(container).map((r) => r.querySelector('.account-quick-name')?.textContent)).toEqual([
      'Visible Checking',
      'Visible Savings',
    ]);
    expect(screen.queryByText('Hidden Checking')).toBeNull();
    expect(screen.queryByText('Brokerage')).toBeNull();
  });

  it('says hidden accounts can still count, without claiming coverage or freshness', () => {
    const { container } = render(<AccountQuickView assetGroups={[group('checking', [account()])]} />);
    expect(screen.getByText(/Hidden accounts can still count toward your totals\./)).toBeTruthy();
    expect(container.textContent).not.toMatch(NO_FRESHNESS_OR_HEALTH_CLAIM);
  });

  it('shows a dash and says so for an account with no balance, never an amount', () => {
    const { container } = render(
      <AccountQuickView assetGroups={[group('checking', [account({ current_balance: null, name: 'No Balance Checking' })])]} />
    );
    const [row] = rows(container);
    expect(row.querySelector('.balance')?.textContent).toBe('—');
    expect(row.textContent).toContain('Balance unavailable');
    expect(row.textContent).not.toContain('$0.00');
  });

  it('shows a real zero as an amount, not as unavailable', () => {
    const { container } = render(<AccountQuickView assetGroups={[group('savings', [account({ current_balance: 0 })])]} />);
    const [row] = rows(container);
    expect(row.querySelector('.balance')?.textContent).toBe('$0.00');
    expect(row.textContent).not.toContain('Balance unavailable');
  });

  it('keeps the exclusion label, institution, nickname, icon, negative balance and currency', () => {
    const { container } = render(
      <AccountQuickView
        assetGroups={[
          group('checking', [
            account({ name: 'Plaid Name', nickname: 'My Nickname', icon: '🏦', exclude_from_net_worth: true, current_balance: -24.18, iso_currency_code: 'EUR' }),
          ]),
        ]}
      />
    );
    const [row] = rows(container);
    expect(row.querySelector('.account-quick-name')?.textContent).toBe('🏦My Nickname');
    expect(row.querySelector('.account-type')?.textContent).toBe('Example Bank · Excluded from net worth');
    expect(row.querySelector('.balance')?.textContent).toBe('-€24.18');
  });

  it('omits the detail line when there is nothing to say', () => {
    const { container } = render(<AccountQuickView assetGroups={[group('checking', [account({ institution_name: null })])]} />);
    expect(rows(container)[0].querySelector('.account-type')).toBeNull();
  });

  it.each([
    ['no groups', []],
    ['every account hidden', [group('checking', [account({ hidden: true })])]],
    ['only other categories', [group('investment', [account()])]],
  ] as [string, AssetGroup[]][])('uses the neutral empty message with %s', (_label, assetGroups) => {
    const { container } = render(<AccountQuickView assetGroups={assetGroups} />);
    expect(screen.getByText('No checking or savings accounts to display.')).toBeTruthy();
    expect(container.textContent).not.toMatch(/linked/i);
    expect(rows(container)).toHaveLength(0);
  });
});

describe('Net worth over time', () => {
  afterEach(cleanup);

  const point = (date: string, net_worth: number): NetWorthPoint => ({ date, net_worth, total_assets: 0, total_liabilities: 0 });
  const value = (container: HTMLElement) => container.querySelector('.stat-value-inline');

  it('explains an empty history without drawing a chart or a value', () => {
    const { container } = render(<NetWorthChart history={[]} />);
    expect(screen.getByText(/No recorded snapshots yet\./)).toBeTruthy();
    expect(container.querySelector('svg')).toBeNull();
    expect(value(container)).toBeNull();
    expect(container.textContent).not.toMatch(NO_FRESHNESS_OR_HEALTH_CLAIM);
  });

  it('labels a single snapshot as one point, with one date and no trend', () => {
    const { container } = render(<NetWorthChart history={[point('2026-10-29', 5000)]} />);
    expect(container.querySelectorAll('circle')).toHaveLength(1);
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('One recorded snapshot so far, from Oct 29, 2026. Latest snapshot: $5,000.');
    const dates = [...container.querySelectorAll('text')].filter((t) => t.textContent === 'Oct 29');
    expect(dates).toHaveLength(1);
    expect(screen.getByText(/One recorded snapshot so far/, { selector: 'p' })).toBeTruthy();
  });

  it('names the recorded range and treats the latest value as a snapshot', () => {
    const { container } = render(
      <NetWorthChart history={[point('2025-12-31', 1000), point('2026-06-30', 2000), point('2026-10-29', 3500)]} />
    );
    expect(container.querySelectorAll('circle')).toHaveLength(3);
    expect(screen.getByText('Latest snapshot')).toBeTruthy();
    expect(value(container)?.textContent).toBe('$3,500');
    const note = screen.getByText(/Recorded snapshots from Dec 31, 2025 to Oct 29, 2026\./, { selector: 'p' });
    expect(note.textContent).toContain('not confirmation that every balance was up to date');
    expect(container.textContent).not.toMatch(NO_FRESHNESS_OR_HEALTH_CLAIM);
  });

  it('keeps negative history negative, with its zero line when the range crosses zero', () => {
    const { container } = render(<NetWorthChart history={[point('2026-09-30', 800), point('2026-10-29', -1200)]} />);
    expect(value(container)?.className).toContain('negative');
    expect(value(container)?.textContent).toBe('-$1,200');
    expect(container.querySelector('.networth-zero-line')).toBeTruthy();
    expect(container.querySelectorAll('.networth-point.negative')).toHaveLength(1);
  });

  it('draws an all-zero history as a real zero with valid geometry', () => {
    const { container } = render(<NetWorthChart history={[point('2026-09-30', 0), point('2026-10-29', 0)]} />);
    expect(value(container)?.textContent).toBe('$0');
    expect(value(container)?.className).not.toContain('negative');
    for (const path of container.querySelectorAll('path')) expect(path.getAttribute('d')).not.toContain('NaN');
  });
});

describe('Upcoming bills', () => {
  // A fixed "today", 2026-10-30 UTC, so estimated dates are deterministic. Only Date is faked.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-30T12:00:00Z'));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  const stream = (overrides: Partial<RecurringStream> = {}): RecurringStream => ({
    id: 's1',
    description: 'Synthetic Utility',
    merchant_name: null,
    direction: 'outflow',
    frequency: 'MONTHLY',
    average_amount: 50,
    last_amount: 61.8,
    iso_currency_code: 'USD',
    first_date: '2025-01-01',
    last_date: '2026-10-05',
    is_active: true,
    status: 'MATURE',
    category: null,
    monthly_amount: 50,
    ...overrides,
  });
  const loan = (overrides: Partial<Loan> = {}) =>
    ({ id: 'l1', name: 'Synthetic Student Loan', account_name: null, loan_type: 'student', minimum_payment_amount: 248.17, next_payment_due_date: '2026-11-07', ...overrides }) as unknown as Loan;
  const manualLoan = (overrides: Partial<ManualLoan> = {}) =>
    ({ id: 'm1', name: 'Synthetic Car Loan', minimum_payment_amount: 412.36, next_payment_due_date: '2026-11-10', ...overrides }) as unknown as ManualLoan;

  const rows = (container: HTMLElement) => [...container.querySelectorAll('.upcoming-bill-row')];

  it('labels a recurring item as estimated and a loan and card minimum by kind, in due-date order', () => {
    const { container } = render(
      <UpcomingBills
        recurringStreams={[stream()]}
        loans={[loan(), loan({ id: 'l2', name: 'Synthetic Card', loan_type: 'credit', minimum_payment_amount: 45, next_payment_due_date: '2026-11-01' })]}
        manualLoans={[manualLoan()]}
        daysAhead={14}
      />
    );
    const read = rows(container).map((r) => [
      r.querySelector('.upcoming-bill-title')?.textContent,
      r.querySelector('.account-type')?.textContent,
      r.querySelector('.due-badge')?.textContent,
      r.querySelector('.balance')?.textContent,
    ]);
    expect(read).toEqual([
      ['Synthetic Card', 'Card minimum payment', 'in 2 days', '$45.00'],
      ['Synthetic Utility', 'Estimated date and amount', 'in 6 days', '$61.80'],
      ['Synthetic Student Loan', 'Loan payment', 'in 8 days', '$248.17'],
      ['Synthetic Car Loan', 'Loan payment', 'in 11 days', '$412.36'],
    ]);
    expect(rows(container)[0].querySelector('.due-badge')?.className).toContain('soon');
    expect(rows(container)[1].querySelector('.due-badge')?.className).not.toContain('soon');
  });

  it('totals exactly the items the shared Safe to Spend source returns', () => {
    const streams = [stream()];
    const loans = [loan()];
    const manualLoans = [manualLoan()];
    const { container } = render(<UpcomingBills recurringStreams={streams} loans={loans} manualLoans={manualLoans} daysAhead={14} />);
    const expected = collectUpcomingItems(streams, loans, manualLoans, 14);
    expect(rows(container)).toHaveLength(expected.length);
    expect(screen.getByText('$722.33 due within 14 days')).toBeTruthy();
    expect(expected.reduce((sum, i) => sum + i.amount, 0)).toBeCloseTo(722.33, 2);
  });

  it('says the list may not include every bill', () => {
    const { container } = render(<UpcomingBills recurringStreams={[stream()]} loans={[]} manualLoans={[]} daysAhead={14} />);
    expect(screen.getByText(/may not include every bill\./)).toBeTruthy();
    expect(container.textContent).not.toMatch(NO_FRESHNESS_OR_HEALTH_CLAIM);
  });

  it('leaves out inactive, incoming, unknown-cadence and out-of-window items', () => {
    const { container } = render(
      <UpcomingBills
        recurringStreams={[
          stream({ id: 'a', is_active: false }),
          stream({ id: 'b', direction: 'inflow' }),
          stream({ id: 'c', frequency: 'UNKNOWN', last_date: '2026-09-01' }),
        ]}
        loans={[loan({ next_payment_due_date: '2026-12-25' })]}
        manualLoans={[manualLoan({ minimum_payment_amount: null })]}
        daysAhead={14}
      />
    );
    expect(rows(container)).toHaveLength(0);
  });

  it('never presents an empty list as proof that nothing is due', () => {
    const { container } = render(<UpcomingBills recurringStreams={[]} loans={[]} manualLoans={[]} daysAhead={21} />);
    expect(screen.getByText(/No upcoming items detected in the next 21 days\./).textContent).toContain('other bills may still be due');
    expect(container.textContent).not.toMatch(/nothing due/i);
    expect(container.querySelector('.monthly-total-badge')).toBeNull();
    expect(container.querySelector('.card-source-note')).toBeNull();
  });
});

describe('Recent activity', () => {
  afterEach(cleanup);

  const txn = (id: string, amount: number, overrides: Partial<TransactionItem> = {}): TransactionItem => ({
    id,
    amount,
    iso_currency_code: 'USD',
    date: '2026-10-28',
    name: `Raw ${id}`,
    merchant_name: `Merchant ${id}`,
    category: null,
    plaid_category: null,
    pending: false,
    budget_category_id: null,
    needs_review: false,
    splits: [],
    accounts: { name: 'Synthetic Checking', nickname: null, plaid_items: { institution_name: 'Example Bank' } },
    ...overrides,
  });
  const CATEGORIES = [{ id: 'cat-1', emoji: '🛒' }] as unknown as BudgetCategory[];
  const rows = (container: HTMLElement) => [...container.querySelectorAll('.recent-activity-row')];

  it('shows the first five in the order supplied and discloses how many are loaded', () => {
    const transactions = ['1', '2', '3', '4', '5', '6', '7'].map((id) => txn(id, 10));
    const { container } = render(<RecentActivity transactions={transactions} budgetCategories={[]} onViewAll={vi.fn()} />);
    expect(rows(container).map((r) => r.querySelector('.transaction-name')?.textContent)).toEqual([
      'Merchant 1',
      'Merchant 2',
      'Merchant 3',
      'Merchant 4',
      'Merchant 5',
    ]);
    expect(screen.getByText(/Showing 5 of 7 loaded transactions, not a complete history\./)).toBeTruthy();
    expect(container.textContent).not.toMatch(NO_FRESHNESS_OR_HEALTH_CLAIM);
  });

  it('uses the singular for one loaded transaction', () => {
    render(<RecentActivity transactions={[txn('1', 10)]} budgetCategories={[]} onViewAll={vi.fn()} />);
    expect(screen.getByText(/Showing 1 of 1 loaded transaction, not a complete history\./)).toBeTruthy();
  });

  it('keeps the sign convention: money out is negative, money in is positive, zero is unchanged', () => {
    const { container } = render(
      <RecentActivity
        transactions={[txn('out', 54.18), txn('in', -38.5), txn('zero', 0)]}
        budgetCategories={[]}
        onViewAll={vi.fn()}
      />
    );
    const [out, moneyIn, zero] = rows(container);
    expect(out.querySelector('.amount-debit')?.textContent).toBe('-$54.18');
    expect(moneyIn.querySelector('.amount-credit')?.textContent).toBe('+$38.50');
    expect(zero.querySelector('.amount-debit')?.textContent).toBe('-$0.00');
  });

  it('keeps the category emoji, the merchant fallback and the date', () => {
    const { container } = render(
      <RecentActivity
        transactions={[txn('1', 10, { budget_category_id: 'cat-1', merchant_name: null, date: '2026-10-05' })]}
        budgetCategories={CATEGORIES}
        onViewAll={vi.fn()}
      />
    );
    const [row] = rows(container);
    expect(row.querySelector('.transaction-emoji')?.textContent).toBe('🛒');
    expect(row.querySelector('.transaction-name')?.textContent).toBe('🛒Raw 1');
    expect(within(row as HTMLElement).getByText('Oct 5')).toBeTruthy();
  });

  it('keeps View all working, with or without transactions', () => {
    const onViewAll = vi.fn();
    render(<RecentActivity transactions={[]} budgetCategories={[]} onViewAll={onViewAll} />);
    fireEvent.click(screen.getByRole('button', { name: 'View all' }));
    expect(onViewAll).toHaveBeenCalledTimes(1);
  });

  it('uses a neutral empty message with no count', () => {
    const { container } = render(<RecentActivity transactions={[]} budgetCategories={[]} onViewAll={vi.fn()} />);
    expect(screen.getByText('No transactions to show.')).toBeTruthy();
    expect(container.querySelector('.card-source-note')).toBeNull();
  });
});
