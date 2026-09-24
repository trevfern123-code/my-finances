import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabaseClient';
import type { ReportingRangeId } from './reportingRange';
import type { OwnershipCheck } from './sessionOwnership';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

/** `code` on the error authedFetch throws for a mutation sent without an owner check. */
export const SESSION_OWNER_REQUIRED = 'session_owner_required';
/** `code` on the error authedFetch throws when the session no longer matches the operation's owner —
 *  nothing was sent. */
export const SESSION_OWNER_MISMATCH = 'session_owner_mismatch';

// Local clock drift can put a freshly-minted session token's issued-at a few seconds ahead of
// Supabase's own server clock, which it rejects. We don't control that validation (it happens
// on Supabase's infrastructure, not in our code), but the condition is transient — waiting a
// moment and retrying once almost always succeeds once real time catches up.
const CLOCK_SKEW_RETRY_DELAY_MS = 1500;

function isClockSkewError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('issued at future') || normalized.includes('issued in the future');
}

/**
 * `verifyOwnership`, when given, is called with whatever session Supabase just handed back — on
 * both the first attempt and the clock-skew retry below, not just once up front — and must return
 * true for the request to actually be sent. This exists for callers whose request was *created*
 * under one specific authenticated identity and must never be sent under a *different* one that
 * happens to be current by the time an async session lookup (or its retry, after a real delay)
 * finally resolves — checking ownership once before calling authedFetch is not enough, because the
 * session this function looks up is whatever is current at the moment it actually looks, which can
 * change during either await above.
 *
 * Wave 1: REQUIRED for every mutation (any method other than GET/HEAD) — each exported mutation
 * below takes one, and this refuses to send a mutation without it. Reads may omit it: a read sent
 * under a newer session returns that session's own data, which each caller already discards if its
 * lifecycle has moved on (see App.tsx's session checks).
 */
async function authedFetch(
  path: string,
  init: RequestInit = {},
  isRetry = false,
  verifyOwnership?: OwnershipCheck
): Promise<any> {
  const method = (init.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD' && !verifyOwnership) {
    throw Object.assign(new Error('Refusing to send a change without a signed-in owner'), {
      code: SESSION_OWNER_REQUIRED,
    });
  }

  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error('Not signed in');
  }
  if (verifyOwnership && !verifyOwnership(session)) {
    // The session just looked up no longer belongs to whoever this specific request was created
    // for. Refuse rather than send it anyway under whatever happens to be current now.
    throw Object.assign(new Error('Session no longer matches the expected authenticated owner'), {
      code: SESSION_OWNER_MISMATCH,
    });
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
      // Re-verify on the retry too — the delay here is exactly the window a since-superseded
      // request could otherwise slip through under a different session that became current while
      // it waited.
      return authedFetch(path, init, true, verifyOwnership);
    }

    // A machine-readable `code`, when the server sends one, lets a caller act on a specific outcome
    // without parsing the human-readable message (see isManualLoanCreationResolvedError).
    throw Object.assign(new Error(message), typeof body.code === 'string' ? { code: body.code } : {});
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
  /** 'credential_error' means this app failed to decrypt/read the stored Plaid credential — not
   *  a bank-reconnect situation like 'login_required' (see PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md
   *  §9/§10). Never show a reconnect prompt for it — reconnecting wouldn't fix anything. */
  status: 'active' | 'login_required' | 'credential_error';
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

/** A server-owned Plaid Hosted Link attempt (Wave 1). The Plaid link token stays on the server; this
 *  app only opens `hosted_link_url` and later asks the server to complete `link_attempt_id`. */
export interface HostedLinkAttempt {
  hosted_link_url: string;
  link_attempt_id: string;
  expires_at: string;
}

/** Starts a one-time, 30-minute Hosted Link attempt bound to this user and login session. */
export function createHostedLinkAttempt(verifyOwnership: OwnershipCheck): Promise<HostedLinkAttempt> {
  return authedFetch('/api/plaid/link-token', { method: 'POST' }, false, verifyOwnership);
}

/**
 * Asks the server to finish the attempt: it reads Plaid's result for its OWN stored link token and,
 * the first time Hosted Link has succeeded, exchanges and stores the item. 'pending'/'completing'
 * mean "ask again shortly". Every refusal is a thrown error carrying the server's `code` (e.g.
 * link_attempt_expired, link_attempt_exited, link_attempt_invalid, link_attempt_already_completed).
 * No Plaid token is ever sent or received — this app has no way to submit a public token at all.
 * On 'completed', `follow_up_incomplete` lists linking steps that did not finish (institution,
 * accounts, transactions, net_worth_snapshot, liabilities): the bank IS linked, and Refresh balances
 * / Sync transactions retry them.
 */
export function completeLinkAttempt(
  linkAttemptId: string,
  verifyOwnership: OwnershipCheck
): Promise<{ status: 'pending' | 'completing' } | { status: 'completed'; follow_up_incomplete?: string[] }> {
  return authedFetch(
    `/api/plaid/link-attempts/${encodeURIComponent(linkAttemptId)}/complete`,
    { method: 'POST' },
    false,
    verifyOwnership
  );
}

export function getLinkedItems(): Promise<{ items: LinkedItem[]; is_sandbox: boolean }> {
  return authedFetch('/api/plaid/items');
}

export function refreshAccountBalances(verifyOwnership: OwnershipCheck): Promise<{ items: LinkedItem[]; is_sandbox: boolean }> {
  return authedFetch('/api/plaid/accounts/refresh', { method: 'POST' }, false, verifyOwnership);
}

export function updateAccountCreditLimit(
  accountId: string,
  creditLimit: number | null,
  verifyOwnership: OwnershipCheck
): Promise<{ account: LinkedAccount }> {
  return authedFetch(`/api/plaid/accounts/${accountId}/credit-limit`, {
    method: 'PATCH',
    body: JSON.stringify({ credit_limit: creditLimit }),
  }, false, verifyOwnership);
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
  }>,
  verifyOwnership: OwnershipCheck
): Promise<{ account: LinkedAccount }> {
  return authedFetch(`/api/plaid/accounts/${accountId}/customization`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  }, false, verifyOwnership);
}

export interface SpendingSummary {
  net_worth: number;
  total_assets: number;
  total_liabilities: number;
  /** Follows the reporting-range preference (Date-Range Customization v1). */
  monthly_spending: { month: string; spent: number; income: number }[];
  /** Always the real current calendar month, regardless of the reporting-range preference —
   *  Cash Flow Pace and the Savings Rate card are current-period-intrinsic ("how am I doing this
   *  month") and must never silently follow a historical filter like 'last_month', which would
   *  otherwise exclude the current month from `monthly_spending` entirely. */
  current_month: { income: number; spent: number };
}

export function getSpendingSummary(rangeId?: ReportingRangeId): Promise<SpendingSummary> {
  return authedFetch(`/api/plaid/summary${rangeId ? `?range_id=${rangeId}` : ''}`);
}

export interface NetWorthPoint {
  date: string;
  net_worth: number;
  total_assets: number;
  total_liabilities: number;
}

export function getNetWorthHistory(rangeId?: ReportingRangeId): Promise<{ history: NetWorthPoint[] }> {
  return authedFetch(`/api/plaid/net-worth-history${rangeId ? `?range_id=${rangeId}` : ''}`);
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

export function getMonthlyBreakdown(rangeId?: ReportingRangeId): Promise<{ months: MonthBreakdown[] }> {
  return authedFetch(`/api/plaid/monthly-breakdown${rangeId ? `?range_id=${rangeId}` : ''}`);
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

/**
 * `idempotencyKey` — generated once per create ATTEMPT on the caller's side (see
 * LoanProgress.tsx's `ManualLoanForm`, which mints one per form mount) and sent as the
 * `Idempotency-Key` header. The backend persists it alongside the created loan and replays the
 * same loan on any later request carrying the same key, rather than creating a duplicate — this
 * is what makes a retry (a double-click before the form closes, or a client-side resend after an
 * ambiguous timeout) safe even though loan creation also triggers a same-request backfill step
 * that can itself fail after the loan already persisted.
 */
/**
 * `verifyOwnership` is REQUIRED (Round 14 remediation). A create is initiated under one
 * authenticated user, but the request is only sent after awaits — the cross-tab Web Lock, then
 * authedFetch's own session lookup, and possibly its clock-skew retry delay — and authedFetch sends
 * with whatever session is current when it looks. Without this, a sign-in change during any of
 * those waits sent user A's loan with user B's bearer token, creating it in B's account.
 * authedFetch calls this with the session it is about to use, immediately before the first send and
 * again before any retry, and refuses to send unless it returns true.
 */
export function createManualLoan(
  input: ManualLoanInput,
  idempotencyKey: string,
  verifyOwnership: (session: Session) => boolean
): Promise<{ loan: ManualLoan }> {
  // Round 16: the dedicated idempotent route, which rejects a missing key rather than silently
  // creating a non-idempotent loan. POST /api/manual-loans is kept on the backend only for cached
  // pre-Round-16 bundles, and gives no retry protection — this client must never call it.
  return authedFetch(
    '/api/manual-loans/idempotent',
    {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey },
      body: JSON.stringify(input),
    },
    false,
    verifyOwnership
  );
}

/** True when a createManualLoan failure is the server's DEFINITIVE answer that this idempotency key
 *  already created a loan which has since been deleted — i.e. the attempt is resolved, not failed. */
export function isManualLoanCreationResolvedError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: unknown }).code === 'idempotency_key_loan_deleted';
}

export function updateManualLoan(
  id: string,
  input: Partial<ManualLoanInput>,
  verifyOwnership: OwnershipCheck
): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${id}`, { method: 'PATCH', body: JSON.stringify(input) }, false, verifyOwnership);
}

export function deleteManualLoan(id: string, verifyOwnership: OwnershipCheck): Promise<void> {
  return authedFetch(`/api/manual-loans/${id}`, { method: 'DELETE' }, false, verifyOwnership);
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
  principalPortion: number,
  verifyOwnership: OwnershipCheck
): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${loanId}/payments/${transactionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ principal_portion: principalPortion }),
  }, false, verifyOwnership);
}

export function unlinkLoanPayment(loanId: string, transactionId: string, verifyOwnership: OwnershipCheck): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${loanId}/payments/${transactionId}`, { method: 'DELETE' }, false, verifyOwnership);
}

export interface ManualPaymentInput {
  date: string;
  principal_portion: number;
  interest_portion: number;
  notes: string | null;
}

export function createManualPayment(
  loanId: string,
  input: ManualPaymentInput,
  verifyOwnership: OwnershipCheck
): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${loanId}/manual-payments`, {
    method: 'POST',
    body: JSON.stringify(input),
  }, false, verifyOwnership);
}

export function updateManualPayment(
  loanId: string,
  paymentId: string,
  input: Partial<ManualPaymentInput>,
  verifyOwnership: OwnershipCheck
): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${loanId}/manual-payments/${paymentId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }, false, verifyOwnership);
}

export function deleteManualPayment(loanId: string, paymentId: string, verifyOwnership: OwnershipCheck): Promise<{ loan: ManualLoan }> {
  return authedFetch(`/api/manual-loans/${loanId}/manual-payments/${paymentId}`, { method: 'DELETE' }, false, verifyOwnership);
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
  savingsGoal: number | null,
  verifyOwnership: OwnershipCheck
): Promise<{ account: LinkedAccount }> {
  return authedFetch(`/api/plaid/accounts/${accountId}/savings-goal`, {
    method: 'PATCH',
    body: JSON.stringify({ savings_goal: savingsGoal }),
  }, false, verifyOwnership);
}

export function createReauthLinkToken(itemId: string, verifyOwnership: OwnershipCheck): Promise<{ link_token: string }> {
  return authedFetch(`/api/plaid/items/${itemId}/reauth-link-token`, { method: 'POST' }, false, verifyOwnership);
}

export function completeReauth(itemId: string, verifyOwnership: OwnershipCheck): Promise<{ items: LinkedItem[] }> {
  return authedFetch(`/api/plaid/items/${itemId}/reauth-complete`, { method: 'POST' }, false, verifyOwnership);
}

/** Sandbox-only testing helper — 404s outside Plaid Sandbox. Forces an item into login_required. */
export function sandboxResetLogin(itemId: string, verifyOwnership: OwnershipCheck): Promise<{ items: LinkedItem[] }> {
  return authedFetch(`/api/plaid/items/${itemId}/sandbox-reset-login`, { method: 'POST' }, false, verifyOwnership);
}

/** Sandbox-only testing helper — 404s outside Plaid Sandbox. Asks Plaid to actually deliver a test webhook. */
export function sandboxFireWebhook(itemId: string, verifyOwnership: OwnershipCheck): Promise<{ fired: boolean }> {
  return authedFetch(`/api/plaid/items/${itemId}/sandbox-fire-webhook`, { method: 'POST' }, false, verifyOwnership);
}

export function syncTransactions(verifyOwnership: OwnershipCheck): Promise<{ added: number; modified: number; removed: number }> {
  return authedFetch('/api/plaid/transactions/sync', { method: 'POST' }, false, verifyOwnership);
}

export function getTransactions(limit = 50): Promise<{ transactions: TransactionItem[] }> {
  return authedFetch(`/api/plaid/transactions?limit=${limit}`);
}

export function setTransactionCategory(
  transactionId: string,
  budgetCategoryId: string | null,
  verifyOwnership: OwnershipCheck
): Promise<{ transaction: TransactionItem }> {
  return authedFetch(`/api/plaid/transactions/${transactionId}/category`, {
    method: 'PATCH',
    body: JSON.stringify({ budget_category_id: budgetCategoryId }),
  }, false, verifyOwnership);
}

export function approveTransaction(transactionId: string, verifyOwnership: OwnershipCheck): Promise<{ transaction: TransactionItem }> {
  return authedFetch(`/api/plaid/transactions/${transactionId}/approve`, { method: 'PATCH' }, false, verifyOwnership);
}

export function saveTransactionSplits(
  transactionId: string,
  splits: { budget_category_id: string; amount: number }[],
  verifyOwnership: OwnershipCheck
): Promise<{ splits: TransactionSplit[] }> {
  return authedFetch(`/api/plaid/transactions/${transactionId}/splits`, {
    method: 'PUT',
    body: JSON.stringify({ splits }),
  }, false, verifyOwnership);
}

export function clearTransactionSplits(transactionId: string, verifyOwnership: OwnershipCheck): Promise<void> {
  return authedFetch(`/api/plaid/transactions/${transactionId}/splits`, { method: 'DELETE' }, false, verifyOwnership);
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
}, verifyOwnership: OwnershipCheck): Promise<{ category: BareBudgetCategory }> {
  return authedFetch('/api/budget-categories', { method: 'POST', body: JSON.stringify(params) }, false, verifyOwnership);
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
  }>,
  verifyOwnership: OwnershipCheck
): Promise<{ category: BareBudgetCategory; removed_mapping_ids?: string[] }> {
  return authedFetch(`/api/budget-categories/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(fields),
  }, false, verifyOwnership);
}

export function deleteBudgetCategory(id: string, verifyOwnership: OwnershipCheck): Promise<void> {
  return authedFetch(`/api/budget-categories/${id}`, { method: 'DELETE' }, false, verifyOwnership);
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
  backfill: boolean,
  verifyOwnership: OwnershipCheck
): Promise<{ mapping: CategoryMapping; backfilled_count: number }> {
  return authedFetch('/api/category-mappings', {
    method: 'POST',
    body: JSON.stringify({
      plaid_category: plaidCategory,
      budget_category_id: budgetCategoryId,
      backfill,
    }),
  }, false, verifyOwnership);
}

export function deleteCategoryMapping(id: string, verifyOwnership: OwnershipCheck): Promise<void> {
  return authedFetch(`/api/category-mappings/${id}`, { method: 'DELETE' }, false, verifyOwnership);
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

/** One customizable tab's saved state in a user's navigation layout. `id` is a plain string on the
 *  wire, same reasoning as DashboardCardEntry.id above — lib/navLayout.ts's mergeNavLayout owns
 *  reconciling it against the known customizable-tab set (lib/tabRegistry.ts), not this file. */
export interface NavLayoutEntry {
  id: string;
  visible: boolean;
}

export interface NavLayout {
  tabs: NavLayoutEntry[];
}

export interface UserPreferences {
  /** Null means the user has never customized anything — the caller falls back to the built-in
   *  default layout, not an empty one. */
  dashboard_layout: DashboardLayout | null;
  /** Null means the user has never customized navigation — same fallback reasoning as
   *  dashboard_layout. Only ever contains customizable tabs; Overview and Settings are structural
   *  anchors and are never represented here (see lib/tabRegistry.ts). */
  nav_layout: NavLayout | null;
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
  /** Safe to Spend Customization v1 — whether upcoming bills / remaining budget are subtracted
   *  from Safe to Spend at all. Both default true, matching the calculation's pre-existing
   *  behavior. */
  safe_to_spend_include_upcoming_bills: boolean;
  safe_to_spend_include_remaining_budget: boolean;
  /** Date-Range Customization v1 — raw string on the wire, lib/reportingRange.ts's
   *  normalizeReportingRange owns turning it into a known-good id, same reasoning as theme/accent. */
  reporting_range: string;
}

export function getUserPreferences(): Promise<UserPreferences> {
  return authedFetch('/api/user-preferences');
}

/**
 * `verifyOwnership` is required (not optional) on every update* function in this file, for the
 * same reason it's required on updateNavLayout: each of these saves must be bound to the
 * authenticated identity it was created for, checked at the moment the request is actually about
 * to be sent — including on a clock-skew retry — never merely at the moment the caller decided to
 * save. See authedFetch's own doc comment for exactly what this closes, and App.tsx's
 * PreferencesScope for how each hook's verifyOwnership is assembled.
 */
export function updateDashboardLayout(
  layout: DashboardLayout,
  verifyOwnership: (session: Session) => boolean
): Promise<{ dashboard_layout: DashboardLayout }> {
  return authedFetch(
    '/api/user-preferences/dashboard-layout',
    { method: 'PUT', body: JSON.stringify(layout) },
    false,
    verifyOwnership
  );
}

export function updateNavLayout(
  layout: NavLayout,
  verifyOwnership: (session: Session) => boolean
): Promise<{ nav_layout: NavLayout }> {
  return authedFetch(
    '/api/user-preferences/nav-layout',
    { method: 'PUT', body: JSON.stringify(layout) },
    false,
    verifyOwnership
  );
}

export function updateAppearance(
  appearance: { theme: string; accent_color: string },
  verifyOwnership: (session: Session) => boolean
): Promise<{ theme: string; accent_color: string }> {
  return authedFetch(
    '/api/user-preferences/appearance',
    { method: 'PUT', body: JSON.stringify(appearance) },
    false,
    verifyOwnership
  );
}

export function updateReportingRange(
  prefs: { reporting_range: ReportingRangeId },
  verifyOwnership: (session: Session) => boolean
): Promise<{ reporting_range: string }> {
  return authedFetch(
    '/api/user-preferences/reporting-range',
    { method: 'PUT', body: JSON.stringify(prefs) },
    false,
    verifyOwnership
  );
}

export function updateFinancialPreferences(
  prefs: {
    minimum_cash_buffer: number;
    upcoming_bills_days: number;
    recent_avg_months: number;
    savings_rate_target: number;
    safe_to_spend_include_upcoming_bills: boolean;
    safe_to_spend_include_remaining_budget: boolean;
  },
  verifyOwnership: (session: Session) => boolean
): Promise<{
  minimum_cash_buffer: number;
  upcoming_bills_days: number;
  recent_avg_months: number;
  savings_rate_target: number;
  safe_to_spend_include_upcoming_bills: boolean;
  safe_to_spend_include_remaining_budget: boolean;
}> {
  return authedFetch(
    '/api/user-preferences/financial',
    { method: 'PUT', body: JSON.stringify(prefs) },
    false,
    verifyOwnership
  );
}
