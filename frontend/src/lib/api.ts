import { supabase } from './supabaseClient';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// Local clock drift can put a freshly-minted session token's issued-at a few seconds ahead of
// Supabase's own server clock, which it rejects. We don't control that validation (it happens
// on Supabase's infrastructure, not in our code), but the condition is transient — waiting a
// moment and retrying once almost always succeeds once real time catches up.
const CLOCK_SKEW_RETRY_DELAY_MS = 1500;

function isClockSkewError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('issued at future') || normalized.includes('issued in the future');
}

async function authedFetch(path: string, init: RequestInit = {}, isRetry = false): Promise<any> {
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
    const message = body.error ?? `Request failed: ${response.status}`;

    if (!isRetry && isClockSkewError(message)) {
      await new Promise((resolve) => setTimeout(resolve, CLOCK_SKEW_RETRY_DELAY_MS));
      return authedFetch(path, init, true);
    }

    throw new Error(message);
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
  /** User-entered — only meaningful for type: "credit" accounts, used to compute utilization. */
  credit_limit: number | null;
  /** User-entered target balance — only meaningful for savings accounts, used for goal progress. */
  savings_goal: number | null;
  /** Display override — use accountDisplayName() rather than reading this directly. */
  nickname: string | null;
  color: string | null;
  icon: string | null;
  sort_order: number;
  /** Display-only — never affects net worth, cash flow, sync, or historical data. */
  hidden: boolean;
  exclude_from_net_worth: boolean;
  /** Excludes this account's transactions/recurring streams from personal cash-flow aggregates.
   *  Individual transactions stay visible in the feed; never affects net worth. */
  exclude_from_cash_flow: boolean;
}

export interface LinkedItem {
  id: string;
  institution_id: string | null;
  institution_name: string | null;
  status: 'active' | 'login_required';
  accounts: LinkedAccount[];
}

/** One line item of a split transaction. When a transaction has any splits, they — not its own
 *  budget_category_id — are the source of truth for how its amount is categorized. */
export interface TransactionSplit {
  id: string;
  budget_category_id: string;
  amount: number;
  note: string | null;
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
  /** True until the user approves the transaction — never reset by a later Plaid update. */
  needs_review: boolean;
  splits: TransactionSplit[];
  accounts: { name: string; nickname: string | null; plaid_items: { institution_name: string | null } };
}

export interface BudgetCategory {
  id: string;
  name: string;
  budget_amount: number;
  color: string | null;
  sort_order: number;
  /** Optional single emoji shown next to the category name and on its transactions. */
  emoji: string | null;
  /** Null for an active category; set to when it was archived otherwise. An archived category is
   *  excluded from active budgeting/selection flows but stays attached to its historical
   *  transactions, splits, and spend totals unchanged. */
  archived_at: string | null;
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

export function getLinkedItems(): Promise<{ items: LinkedItem[]; is_sandbox: boolean }> {
  return authedFetch('/api/plaid/items');
}

export function refreshAccountBalances(): Promise<{ items: LinkedItem[]; is_sandbox: boolean }> {
  return authedFetch('/api/plaid/accounts/refresh', { method: 'POST' });
}

export function updateAccountCreditLimit(
  accountId: string,
  creditLimit: number | null
): Promise<{ account: LinkedAccount }> {
  return authedFetch(`/api/plaid/accounts/${accountId}/credit-limit`, {
    method: 'PATCH',
    body: JSON.stringify({ credit_limit: creditLimit }),
  });
}

export function updateAccountCustomization(
  accountId: string,
  fields: Partial<{
    nickname: string | null;
    color: string | null;
    icon: string | null;
    sort_order: number;
    hidden: boolean;
    exclude_from_net_worth: boolean;
    exclude_from_cash_flow: boolean;
  }>
): Promise<{ account: LinkedAccount }> {
  return authedFetch(`/api/plaid/accounts/${accountId}/customization`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
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

export interface RecurringStream {
  id: string;
  description: string;
  merchant_name: string | null;
  direction: 'inflow' | 'outflow';
  frequency: string;
  average_amount: number;
  last_amount: number;
  iso_currency_code: string | null;
  first_date: string;
  last_date: string;
  is_active: boolean;
  status: string;
  category: string | null;
  monthly_amount: number;
}

export function getRecurringStreams(): Promise<{
  streams: RecurringStream[];
  total_monthly_outflow: number;
  total_monthly_inflow: number;
}> {
  return authedFetch('/api/plaid/recurring-streams');
}

export interface Loan {
  id: string;
  loan_type: 'student' | 'mortgage' | 'credit';
  name: string | null;
  account_name: string | null;
  current_balance: number | null;
  iso_currency_code: string | null;
  interest_rate_percentage: number | null;
  origination_principal_amount: number | null;
  origination_date: string | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  is_overdue: boolean | null;
  payoff_progress_pct: number | null;
}

export function getLoans(): Promise<{
  loans: Loan[];
  total_debt: number;
  total_minimum_payment: number;
}> {
  return authedFetch('/api/plaid/loans');
}

export interface ManualLoan {
  id: string;
  name: string;
  loan_type: 'personal' | 'student' | 'mortgage' | 'auto' | 'other';
  current_balance: number;
  origination_principal_amount: number | null;
  interest_rate_percentage: number | null;
  origination_date: string | null;
  term_months: number | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
  notes: string | null;
  /** Case-insensitive substring matched against synced transactions' name/merchant — matches
   *  auto-link and decrement this loan's balance. Null disables auto-linking. */
  match_text: string | null;
  payoff_progress_pct: number | null;
  /** Lifetime sum across both auto-linked and manually-logged payments. */
  lifetime_principal_paid: number;
  lifetime_interest_paid: number;
}

export interface ManualLoanInput {
  name: string;
  loan_type: string;
  current_balance: number;
  origination_principal_amount: number | null;
  interest_rate_percentage: number | null;
  origination_date: string | null;
  term_months: number | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
  notes: string | null;
  match_text: string | null;
}

export function getManualLoans(): Promise<{ loans: ManualLoan[] }> {
  return authedFetch('/api/manual-loans');
}

export function createManualLoan(input: ManualLoanInput): Promise<{ loan: ManualLoan }> {
  return authedFetch('/api/manual-loans', { method: 'POST', body: JSON.stringify(input) });
}

export function updateManualLoan(
  id: string,
  input: Partial<ManualLoanInput>
): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${id}`, { method: 'PATCH', body: JSON.stringify(input) });
}

export function deleteManualLoan(id: string): Promise<void> {
  return authedFetch(`/api/manual-loans/${id}`, { method: 'DELETE' });
}

export interface LoanPayment {
  id: string;
  /** "linked" = auto-detected from a synced bank transaction (interest is amount-minus-principal,
   *  editable via principal only). "manual" = logged by hand with both portions entered directly. */
  source: 'linked' | 'manual';
  date: string;
  name: string;
  merchant_name: string | null;
  principal_portion: number;
  interest_portion: number;
  notes: string | null;
}

export function getLoanPayments(loanId: string): Promise<{ payments: LoanPayment[] }> {
  return authedFetch(`/api/manual-loans/${loanId}/payments`);
}

export function updateLinkedLoanPayment(
  loanId: string,
  transactionId: string,
  principalPortion: number
): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${loanId}/payments/${transactionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ principal_portion: principalPortion }),
  });
}

export function unlinkLoanPayment(loanId: string, transactionId: string): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${loanId}/payments/${transactionId}`, { method: 'DELETE' });
}

export interface ManualPaymentInput {
  date: string;
  principal_portion: number;
  interest_portion: number;
  notes: string | null;
}

export function createManualPayment(
  loanId: string,
  input: ManualPaymentInput
): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${loanId}/manual-payments`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function updateManualPayment(
  loanId: string,
  paymentId: string,
  input: Partial<ManualPaymentInput>
): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${loanId}/manual-payments/${paymentId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export function deleteManualPayment(loanId: string, paymentId: string): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${loanId}/manual-payments/${paymentId}`, { method: 'DELETE' });
}

export interface AssetAccountSummary {
  id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  current_balance: number | null;
  iso_currency_code: string | null;
  institution_name: string | null;
  /** User-entered target balance for a savings account — null unless the user set one. */
  savings_goal: number | null;
  /** Display override — use accountDisplayName() rather than reading this directly. */
  nickname: string | null;
  color: string | null;
  icon: string | null;
  sort_order: number;
  /** Included here (accounts hidden entirely are already excluded by the backend, so this is
   *  always false for anything in an AssetGroup) — kept for type-symmetry with LinkedAccount. */
  hidden: boolean;
  /** True when this account's balance is shown but excluded from its group's total. */
  exclude_from_net_worth: boolean;
}

export interface AssetGroup {
  category: 'checking' | 'savings' | 'investment' | 'other';
  label: string;
  total: number;
  accounts: AssetAccountSummary[];
}

export function getAssetsSummary(): Promise<{ groups: AssetGroup[]; total_assets: number }> {
  return authedFetch('/api/plaid/assets-summary');
}

export function updateAccountSavingsGoal(
  accountId: string,
  savingsGoal: number | null
): Promise<{ account: LinkedAccount }> {
  return authedFetch(`/api/plaid/accounts/${accountId}/savings-goal`, {
    method: 'PATCH',
    body: JSON.stringify({ savings_goal: savingsGoal }),
  });
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

export function approveTransaction(transactionId: string): Promise<{ transaction: TransactionItem }> {
  return authedFetch(`/api/plaid/transactions/${transactionId}/approve`, { method: 'PATCH' });
}

export function saveTransactionSplits(
  transactionId: string,
  splits: { budget_category_id: string; amount: number }[]
): Promise<{ splits: TransactionSplit[] }> {
  return authedFetch(`/api/plaid/transactions/${transactionId}/splits`, {
    method: 'PUT',
    body: JSON.stringify({ splits }),
  });
}

export function clearTransactionSplits(transactionId: string): Promise<void> {
  return authedFetch(`/api/plaid/transactions/${transactionId}/splits`, { method: 'DELETE' });
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
  emoji?: string | null;
}): Promise<{ category: BareBudgetCategory }> {
  return authedFetch('/api/budget-categories', { method: 'POST', body: JSON.stringify(params) });
}

export function updateBudgetCategory(
  id: string,
  fields: Partial<{
    name: string;
    budget_amount: number;
    color: string | null;
    sort_order: number;
    emoji: string | null;
    archived: boolean;
  }>
): Promise<{ category: BareBudgetCategory; removed_mapping_ids?: string[] }> {
  return authedFetch(`/api/budget-categories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  });
}

export function deleteBudgetCategory(id: string): Promise<void> {
  return authedFetch(`/api/budget-categories/${id}`, { method: 'DELETE' });
}

/** Maps one of Plaid's own category values (a transaction's `category` field, e.g.
 *  "FOOD_AND_DRINK") to one of the user's own budget categories, so a newly-synced transaction
 *  in that category gets auto-assigned without the user touching it. */
export interface CategoryMapping {
  id: string;
  plaid_category: string;
  budget_category_id: string;
}

export function getCategoryMappings(): Promise<{ mappings: CategoryMapping[] }> {
  return authedFetch('/api/category-mappings');
}

/** The distinct Plaid categories seen across the user's own synced transactions — the set of
 *  values a mapping can usefully target. */
export function getPlaidCategories(): Promise<{ categories: string[] }> {
  return authedFetch('/api/category-mappings/plaid-categories');
}

export function saveCategoryMapping(
  plaidCategory: string,
  budgetCategoryId: string,
  backfill: boolean
): Promise<{ mapping: CategoryMapping; backfilled_count: number }> {
  return authedFetch('/api/category-mappings', {
    method: 'POST',
    body: JSON.stringify({
      plaid_category: plaidCategory,
      budget_category_id: budgetCategoryId,
      backfill,
    }),
  });
}

export function deleteCategoryMapping(id: string): Promise<void> {
  return authedFetch(`/api/category-mappings/${id}`, { method: 'DELETE' });
}

/** One card's saved state in a user's dashboard layout. `id` is a plain string on the wire —
 *  it's `lib/dashboardLayout.ts`'s job to reconcile it against the known set of card ids (a
 *  saved id might be stale/unknown after an app update), not this file's. */
export interface DashboardCardEntry {
  id: string;
  visible: boolean;
}

export interface DashboardLayout {
  cards: DashboardCardEntry[];
}

export interface UserPreferences {
  /** Null means the user has never customized anything — the caller falls back to the built-in
   *  default layout, not an empty one. */
  dashboard_layout: DashboardLayout | null;
  /** Raw strings on the wire, same reasoning as DashboardCardEntry.id above — lib/theme.ts's
   *  normalizeTheme/normalizeAccent own turning these into real, known-good ids. */
  theme: string;
  accent_color: string;
  /** Financial Preferences v1 — raw numbers on the wire, lib/financialPreferences.ts's clamp*
   *  functions own validating/defaulting them, same reasoning as theme/accent above. */
  minimum_cash_buffer: number;
  upcoming_bills_days: number;
  recent_avg_months: number;
  savings_rate_target: number;
}

export function getUserPreferences(): Promise<UserPreferences> {
  return authedFetch('/api/user-preferences');
}

export function updateDashboardLayout(layout: DashboardLayout): Promise<{ dashboard_layout: DashboardLayout }> {
  return authedFetch('/api/user-preferences/dashboard-layout', {
    method: 'PUT',
    body: JSON.stringify(layout),
  });
}

export function updateAppearance(appearance: {
  theme: string;
  accent_color: string;
}): Promise<{ theme: string; accent_color: string }> {
  return authedFetch('/api/user-preferences/appearance', {
    method: 'PUT',
    body: JSON.stringify(appearance),
  });
}

export function updateFinancialPreferences(prefs: {
  minimum_cash_buffer: number;
  upcoming_bills_days: number;
  recent_avg_months: number;
  savings_rate_target: number;
}): Promise<{
  minimum_cash_buffer: number;
  upcoming_bills_days: number;
  recent_avg_months: number;
  savings_rate_target: number;
}> {
  return authedFetch('/api/user-preferences/financial', {
    method: 'PUT',
    body: JSON.stringify(prefs),
  });
}
