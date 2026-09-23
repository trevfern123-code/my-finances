import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@supabase/supabase-js';

const mockGetSession = vi.hoisted(() => vi.fn());
vi.mock('./supabaseClient', () => ({
  supabase: { auth: { getSession: mockGetSession } },
}));

import * as api from './api';
import { createSessionOwnership, type OwnershipCheck } from './sessionOwnership';

/** A session whose access token is a decodable (unsigned) JWT carrying `sessionId`. */
function fakeSession(userId: string, sessionId: string): Session {
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return {
    user: { id: userId },
    access_token: `${encode({ alg: 'HS256' })}.${encode({ sub: userId, session_id: sessionId })}.sig`,
  } as unknown as Session;
}

// What the app currently considers signed in — App.tsx's userIdRef/sessionIdRef.
let current: { userId: string | null; sessionId: string | null };
const readCurrent = () => current;

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  current = { userId: 'user-a', sessionId: 'sid-a1' };
});

describe('createSessionOwnership', () => {
  it('accepts only the owner user in the owner login lifecycle, while that lifecycle is current', () => {
    const owner = createSessionOwnership('user-a', 'sid-a1', readCurrent);
    expect(owner.isCurrent()).toBe(true);
    expect(owner.verify(fakeSession('user-a', 'sid-a1'))).toBe(true);
    expect(owner.verify(fakeSession('user-b', 'sid-a1'))).toBe(false);
    expect(owner.verify(fakeSession('user-a', 'sid-a2'))).toBe(false);
    expect(owner.verify({ user: { id: 'user-a' }, access_token: 'not-a-jwt' } as unknown as Session)).toBe(false);
  });

  it('logout: once nobody is signed in, the operation is no longer current and verifies nothing', () => {
    const owner = createSessionOwnership('user-a', 'sid-a1', readCurrent);
    current = { userId: null, sessionId: null };
    expect(owner.isCurrent()).toBe(false);
    expect(owner.verify(fakeSession('user-a', 'sid-a1'))).toBe(false);
  });

  it('logout then login as another user, or as the same user again: the old operation is dead', () => {
    const owner = createSessionOwnership('user-a', 'sid-a1', readCurrent);
    current = { userId: 'user-b', sessionId: 'sid-b1' };
    expect(owner.isCurrent()).toBe(false);
    expect(owner.verify(fakeSession('user-b', 'sid-b1'))).toBe(false);
    current = { userId: 'user-a', sessionId: 'sid-a2' };
    expect(owner.isCurrent()).toBe(false);
    expect(owner.verify(fakeSession('user-a', 'sid-a2'))).toBe(false);
    // Even A's original token is refused: that login is no longer the app's current one.
    expect(owner.verify(fakeSession('user-a', 'sid-a1'))).toBe(false);
  });

  it('fails closed when the operation started while signed out', () => {
    for (const owner of [
      createSessionOwnership(null, null, readCurrent),
      createSessionOwnership('user-a', null, readCurrent),
      createSessionOwnership(null, 'sid-a1', readCurrent),
    ]) {
      expect(owner.isCurrent()).toBe(false);
      expect(owner.verify(fakeSession('user-a', 'sid-a1'))).toBe(false);
    }
  });
});

// Every mutation lib/api.ts exports, each called with representative arguments. A mutation added
// later without an entry here (or without an owner check) is caught by the completeness test below.
const MUTATIONS: { name: string; method: string; path: string; call: (verify: OwnershipCheck) => Promise<unknown> }[] = [
  { name: 'createLinkToken', method: 'POST', path: '/api/plaid/link-token', call: (v) => api.createLinkToken(v) },
  { name: 'exchangePublicToken', method: 'POST', path: '/api/plaid/exchange-public-token', call: (v) => api.exchangePublicToken('public-1', 'attempt-1', v) },
  { name: 'refreshAccountBalances', method: 'POST', path: '/api/plaid/accounts/refresh', call: (v) => api.refreshAccountBalances(v) },
  { name: 'updateAccountCreditLimit', method: 'PATCH', path: '/api/plaid/accounts/acc-1/credit-limit', call: (v) => api.updateAccountCreditLimit('acc-1', 100, v) },
  { name: 'updateAccountCustomization', method: 'PATCH', path: '/api/plaid/accounts/acc-1/customization', call: (v) => api.updateAccountCustomization('acc-1', { hidden: true }, v) },
  { name: 'updateAccountSavingsGoal', method: 'PATCH', path: '/api/plaid/accounts/acc-1/savings-goal', call: (v) => api.updateAccountSavingsGoal('acc-1', 50, v) },
  { name: 'createManualLoan', method: 'POST', path: '/api/manual-loans/idempotent', call: (v) => api.createManualLoan({ name: 'Loan', current_balance: 1 } as never, 'key-1', v) },
  { name: 'updateManualLoan', method: 'PATCH', path: '/api/manual-loans/loan-1', call: (v) => api.updateManualLoan('loan-1', { name: 'x' }, v) },
  { name: 'deleteManualLoan', method: 'DELETE', path: '/api/manual-loans/loan-1', call: (v) => api.deleteManualLoan('loan-1', v) },
  { name: 'updateLinkedLoanPayment', method: 'PATCH', path: '/api/manual-loans/loan-1/payments/txn-1', call: (v) => api.updateLinkedLoanPayment('loan-1', 'txn-1', 5, v) },
  { name: 'unlinkLoanPayment', method: 'DELETE', path: '/api/manual-loans/loan-1/payments/txn-1', call: (v) => api.unlinkLoanPayment('loan-1', 'txn-1', v) },
  { name: 'createManualPayment', method: 'POST', path: '/api/manual-loans/loan-1/manual-payments', call: (v) => api.createManualPayment('loan-1', { date: '2026-01-01', principal_portion: 1, interest_portion: 0, notes: null }, v) },
  { name: 'updateManualPayment', method: 'PATCH', path: '/api/manual-loans/loan-1/manual-payments/pay-1', call: (v) => api.updateManualPayment('loan-1', 'pay-1', { notes: 'x' }, v) },
  { name: 'deleteManualPayment', method: 'DELETE', path: '/api/manual-loans/loan-1/manual-payments/pay-1', call: (v) => api.deleteManualPayment('loan-1', 'pay-1', v) },
  { name: 'createReauthLinkToken', method: 'POST', path: '/api/plaid/items/item-1/reauth-link-token', call: (v) => api.createReauthLinkToken('item-1', v) },
  { name: 'completeReauth', method: 'POST', path: '/api/plaid/items/item-1/reauth-complete', call: (v) => api.completeReauth('item-1', v) },
  { name: 'sandboxResetLogin', method: 'POST', path: '/api/plaid/items/item-1/sandbox-reset-login', call: (v) => api.sandboxResetLogin('item-1', v) },
  { name: 'sandboxFireWebhook', method: 'POST', path: '/api/plaid/items/item-1/sandbox-fire-webhook', call: (v) => api.sandboxFireWebhook('item-1', v) },
  { name: 'syncTransactions', method: 'POST', path: '/api/plaid/transactions/sync', call: (v) => api.syncTransactions(v) },
  { name: 'setTransactionCategory', method: 'PATCH', path: '/api/plaid/transactions/txn-1/category', call: (v) => api.setTransactionCategory('txn-1', 'cat-1', v) },
  { name: 'approveTransaction', method: 'PATCH', path: '/api/plaid/transactions/txn-1/approve', call: (v) => api.approveTransaction('txn-1', v) },
  { name: 'saveTransactionSplits', method: 'PUT', path: '/api/plaid/transactions/txn-1/splits', call: (v) => api.saveTransactionSplits('txn-1', [], v) },
  { name: 'clearTransactionSplits', method: 'DELETE', path: '/api/plaid/transactions/txn-1/splits', call: (v) => api.clearTransactionSplits('txn-1', v) },
  { name: 'createBudgetCategory', method: 'POST', path: '/api/budget-categories', call: (v) => api.createBudgetCategory({ name: 'Food', budget_amount: 1, emoji: null, color: null }, v) },
  { name: 'updateBudgetCategory', method: 'PATCH', path: '/api/budget-categories/cat-1', call: (v) => api.updateBudgetCategory('cat-1', { budget_amount: 2 }, v) },
  { name: 'deleteBudgetCategory', method: 'DELETE', path: '/api/budget-categories/cat-1', call: (v) => api.deleteBudgetCategory('cat-1', v) },
  { name: 'saveCategoryMapping', method: 'POST', path: '/api/category-mappings', call: (v) => api.saveCategoryMapping('FOOD', 'cat-1', false, v) },
  { name: 'deleteCategoryMapping', method: 'DELETE', path: '/api/category-mappings/map-1', call: (v) => api.deleteCategoryMapping('map-1', v) },
  { name: 'updateDashboardLayout', method: 'PUT', path: '/api/user-preferences/dashboard-layout', call: (v) => api.updateDashboardLayout({ cards: [] }, v) },
  { name: 'updateNavLayout', method: 'PUT', path: '/api/user-preferences/nav-layout', call: (v) => api.updateNavLayout({ tabs: [] }, v) },
  { name: 'updateAppearance', method: 'PUT', path: '/api/user-preferences/appearance', call: (v) => api.updateAppearance({ theme: 'dark', accent_color: 'green' }, v) },
  { name: 'updateReportingRange', method: 'PUT', path: '/api/user-preferences/reporting-range', call: (v) => api.updateReportingRange({ reporting_range: 'last_6_months' }, v) },
  {
    name: 'updateFinancialPreferences',
    method: 'PUT',
    path: '/api/user-preferences/financial',
    call: (v) =>
      api.updateFinancialPreferences(
        {
          minimum_cash_buffer: 0,
          upcoming_bills_days: 14,
          recent_avg_months: 2,
          savings_rate_target: 15,
          safe_to_spend_include_upcoming_bills: true,
          safe_to_spend_include_remaining_budget: true,
        },
        v
      ),
  },
];

describe.each(MUTATIONS)('$name — a mutation is only ever sent under the session that started it', ({ method, path, call }) => {
  function ownerA() {
    return createSessionOwnership('user-a', 'sid-a1', readCurrent);
  }

  it('sends exactly once, with A\'s own token, while A\'s login is still current', async () => {
    const session = fakeSession('user-a', 'sid-a1');
    mockGetSession.mockResolvedValue({ data: { session } });
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) } as never);

    await call(ownerA().verify);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url.endsWith(path)).toBe(true);
    expect(init.method).toBe(method);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${session.access_token}`);
  });

  it('logout -> login as B while the operation is underway: refused, nothing sent', async () => {
    const owner = ownerA();
    current = { userId: 'user-b', sessionId: 'sid-b1' };
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-b', 'sid-b1') } });

    await expect(call(owner.verify)).rejects.toMatchObject({ code: api.SESSION_OWNER_MISMATCH });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('logout -> login as A again (a new login) while the operation is underway: refused, nothing sent', async () => {
    const owner = ownerA();
    current = { userId: 'user-a', sessionId: 'sid-a2' };
    mockGetSession.mockResolvedValue({ data: { session: fakeSession('user-a', 'sid-a2') } });

    await expect(call(owner.verify)).rejects.toMatchObject({ code: api.SESSION_OWNER_MISMATCH });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses outright without an owner check — not even a session lookup', async () => {
    await expect(call(undefined as unknown as OwnershipCheck)).rejects.toMatchObject({ code: api.SESSION_OWNER_REQUIRED });
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('every exported mutation-named function is covered above', () => {
  // By naming convention: a new create*/update*/delete*/... export must be added to MUTATIONS (and so
  // be proven to require and honor an owner check) before this passes.
  const covered = new Set(MUTATIONS.map((m) => m.name));
  const mutating = Object.entries(api)
    .filter(([, value]) => typeof value === 'function')
    .map(([name]) => name)
    .filter((name) => /^(create|exchange|refresh|update|delete|unlink|complete|sandbox|sync|set|approve|save|clear)[A-Z]/.test(name));
  expect(mutating.sort()).toEqual([...covered].sort());
});
