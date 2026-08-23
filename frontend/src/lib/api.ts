import { supabase } from './supabaseClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

async function authedFetch(path: string, init: RequestInit = {}) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error('Not signed in');
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session.access_token}`,
      ...init.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${response.status}`);
  }

  if (response.status === 204) return undefined;
  return response.json();
}

export interface LinkedAccount {
  id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  current_balance: number | null;
  available_balance: number | null;
  iso_currency_code: string | null;
}

export interface LinkedItem {
  id: string;
  institution_id: string | null;
  institution_name: string | null;
  status: 'active' | 'login_required';
  accounts: LinkedAccount[];
}

export interface TransactionItem {
  id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  name: string;
  merchant_name: string | null;
  category: string | null;
  plaid_category: string | null;
  pending: boolean;
  budget_category_id: string | null;
  accounts: { name: string; plaid_items: { institution_name: string | null } };
}

export interface BudgetCategory {
  id: string;
  name: string;
  budget_amount: number;
  color: string | null;
  sort_order: number;
  /** Sum of positive-amount categorized transactions in the current calendar month — only present on GET /api/budget-categories. */
  spent: number;
  /** Average monthly spend over the most recent full months, excluding the in-progress current month — only present on GET /api/budget-categories. */
  recent_avg_spent: number;
}

export function createLinkToken(): Promise<{ link_token: string }> {
  return authedFetch('/api/plaid/link-token', { method: 'POST' });
}

export function exchangePublicToken(publicToken: string) {
  return authedFetch('/api/plaid/exchange-public-token', {
    method: 'POST',
    body: JSON.stringify({ public_token: publicToken }),
  });
}

export function getLinkedItems(): Promise<{ items: LinkedItem[] }> {
  return authedFetch('/api/plaid/items');
}

export function refreshAccountBalances(): Promise<{ items: LinkedItem[] }> {
  return authedFetch('/api/plaid/accounts/refresh', { method: 'POST' });
}

export interface SpendingSummary {
  net_worth: number;
  total_assets: number;
  total_liabilities: number;
  monthly_spending: { month: string; spent: number; income: number }[];
}

export function getSpendingSummary(months = 6): Promise<SpendingSummary> {
  return authedFetch(`/api/plaid/summary?months=${months}`);
}

export interface NetWorthPoint {
  date: string;
  net_worth: number;
  total_assets: number;
  total_liabilities: number;
}

export function getNetWorthHistory(months = 6): Promise<{ history: NetWorthPoint[] }> {
  return authedFetch(`/api/plaid/net-worth-history?months=${months}`);
}

export interface CategoryAmount {
  category: string;
  amount: number;
}

export interface MonthBreakdown {
  month: string;
  total_spent: number;
  total_income: number;
  by_category: CategoryAmount[];
}

export function getMonthlyBreakdown(months = 6): Promise<{ months: MonthBreakdown[] }> {
  return authedFetch(`/api/plaid/monthly-breakdown?months=${months}`);
}

export function createReauthLinkToken(itemId: string): Promise<{ link_token: string }> {
  return authedFetch(`/api/plaid/items/${itemId}/reauth-link-token`, { method: 'POST' });
}

export function completeReauth(itemId: string): Promise<{ items: LinkedItem[] }> {
  return authedFetch(`/api/plaid/items/${itemId}/reauth-complete`, { method: 'POST' });
}

/** Sandbox-only testing helper — 404s outside Plaid Sandbox. Forces an item into login_required. */
export function sandboxResetLogin(itemId: string): Promise<{ items: LinkedItem[] }> {
  return authedFetch(`/api/plaid/items/${itemId}/sandbox-reset-login`, { method: 'POST' });
}

/** Sandbox-only testing helper — 404s outside Plaid Sandbox. Asks Plaid to actually deliver a test webhook. */
export function sandboxFireWebhook(itemId: string): Promise<{ fired: boolean }> {
  return authedFetch(`/api/plaid/items/${itemId}/sandbox-fire-webhook`, { method: 'POST' });
}

export function syncTransactions(): Promise<{ added: number; modified: number; removed: number }> {
  return authedFetch('/api/plaid/transactions/sync', { method: 'POST' });
}

export function getTransactions(limit = 50): Promise<{ transactions: TransactionItem[] }> {
  return authedFetch(`/api/plaid/transactions?limit=${limit}`);
}

export function setTransactionCategory(
  transactionId: string,
  budgetCategoryId: string | null
): Promise<{ transaction: TransactionItem }> {
  return authedFetch(`/api/plaid/transactions/${transactionId}/category`, {
    method: 'PATCH',
    body: JSON.stringify({ budget_category_id: budgetCategoryId }),
  });
}

export function getBudgetCategories(): Promise<{ categories: BudgetCategory[] }> {
  return authedFetch('/api/budget-categories');
}

// The create/update endpoints return the bare row from Supabase, not the enriched shape —
// only GET /api/budget-categories computes and includes `spent`/`recent_avg_spent`.
type BareBudgetCategory = Omit<BudgetCategory, 'spent' | 'recent_avg_spent'>;

export function createBudgetCategory(params: {
  name: string;
  budget_amount: number;
  color?: string | null;
}): Promise<{ category: BareBudgetCategory }> {
  return authedFetch('/api/budget-categories', { method: 'POST', body: JSON.stringify(params) });
}

export function updateBudgetCategory(
  id: string,
  fields: Partial<{ name: string; budget_amount: number; color: string | null; sort_order: number }>
): Promise<{ category: BareBudgetCategory }> {
  return authedFetch(`/api/budget-categories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

export function deleteBudgetCategory(id: string): Promise<void> {
  return authedFetch(`/api/budget-categories/${id}`, { method: 'DELETE' });
}
