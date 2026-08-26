import { supabaseAdmin } from '../config/supabase';
import { roundToCents } from './money';
import type {
  AccountRow,
  BudgetCategoryRow,
  CategoryMappingRow,
  InsertedTransaction,
  LoanRow,
  ManualLoanPaymentRow,
  ManualLoanRow,
  PlaidItemRow,
  RecurringStreamRow,
  TransactionRow,
  TransactionSplitRow,
  UserPreferencesRow,
} from '../types';
import type {
  AccountBase,
  RemovedTransaction,
  Transaction as PlaidTransaction,
  TransactionStream,
} from 'plaid';
import type { NormalizedLoan } from './loans';

// ---- Plaid items -----------------------------------------------------------

export async function insertPlaidItem(params: {
  userId: string;
  itemId: string;
  accessToken: string;
  institutionId: string | null;
  institutionName: string | null;
}): Promise<PlaidItemRow> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .insert({
      user_id: params.userId,
      plaid_item_id: params.itemId,
      access_token: params.accessToken,
      institution_id: params.institutionId,
      institution_name: params.institutionName,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to store Plaid item: ${error.message}`);
  return data as PlaidItemRow;
}

export async function getPlaidItemsForUser(
  userId: string
): Promise<Pick<PlaidItemRow, 'id' | 'user_id' | 'access_token' | 'transactions_cursor'>[]> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .select('id, user_id, access_token, transactions_cursor')
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to load Plaid items: ${error.message}`);
  return data;
}

export async function updateItemCursor(itemRowId: string, cursor: string) {
  const { error } = await supabaseAdmin
    .from('plaid_items')
    .update({ transactions_cursor: cursor })
    .eq('id', itemRowId);

  if (error) throw new Error(`Failed to update sync cursor: ${error.message}`);
}

export async function setItemStatus(itemRowId: string, status: 'active' | 'login_required') {
  const { error } = await supabaseAdmin.from('plaid_items').update({ status }).eq('id', itemRowId);
  if (error) throw new Error(`Failed to update item status: ${error.message}`);
}

/** Looks up an item by Plaid's own item_id, which is what webhook payloads identify items by. */
export async function getPlaidItemByPlaidItemId(
  plaidItemId: string
): Promise<Pick<PlaidItemRow, 'id' | 'user_id' | 'access_token' | 'transactions_cursor'> | null> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .select('id, user_id, access_token, transactions_cursor')
    .eq('plaid_item_id', plaidItemId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load Plaid item: ${error.message}`);
  return data;
}

export async function getPlaidItemForUser(
  itemId: string,
  userId: string
): Promise<Pick<PlaidItemRow, 'id' | 'access_token' | 'status'> | null> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .select('id, access_token, status')
    .eq('id', itemId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load Plaid item: ${error.message}`);
  return data;
}

export async function getLinkedItemsForUser(userId: string) {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .select(
      'id, institution_id, institution_name, status, accounts(id, name, official_name, type, subtype, mask, current_balance, available_balance, iso_currency_code, credit_limit, savings_goal, nickname, color, icon, sort_order, hidden, exclude_from_net_worth, exclude_from_cash_flow)'
    )
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to load linked items: ${error.message}`);
  return data;
}

// ---- Accounts ---------------------------------------------------------------

/** Excludes accounts flagged exclude_from_net_worth — net worth and liquid-cash figures should
 *  never include their balances. */
export async function getAccountBalancesForUser(
  userId: string
): Promise<{ type: string; current_balance: number | null }[]> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('type, current_balance, plaid_items!inner(user_id)')
    .eq('plaid_items.user_id', userId)
    .eq('exclude_from_net_worth', false);

  if (error) throw new Error(`Failed to load account balances: ${error.message}`);
  return data;
}

// ---- Net worth snapshots -----------------------------------------------------

export async function upsertNetWorthSnapshot(params: {
  userId: string;
  date: string;
  totalAssets: number;
  totalLiabilities: number;
  netWorth: number;
}): Promise<void> {
  const { error } = await supabaseAdmin.from('net_worth_snapshots').upsert(
    {
      user_id: params.userId,
      date: params.date,
      total_assets: params.totalAssets,
      total_liabilities: params.totalLiabilities,
      net_worth: params.netWorth,
    },
    { onConflict: 'user_id,date' }
  );

  if (error) throw new Error(`Failed to save net worth snapshot: ${error.message}`);
}

export async function getNetWorthHistory(
  userId: string,
  sinceDate: string
): Promise<{ date: string; net_worth: number; total_assets: number; total_liabilities: number }[]> {
  const { data, error } = await supabaseAdmin
    .from('net_worth_snapshots')
    .select('date, net_worth, total_assets, total_liabilities')
    .eq('user_id', userId)
    .gte('date', sinceDate)
    .order('date', { ascending: true });

  if (error) throw new Error(`Failed to load net worth history: ${error.message}`);
  return data;
}

/** Inserts new accounts and updates existing ones (by plaid_account_id) for a Plaid item — used both at initial link and on balance refresh. */
export async function upsertAccountsForItem(
  itemRowId: string,
  plaidAccounts: AccountBase[]
): Promise<AccountRow[]> {
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from('accounts')
    .select('id, plaid_account_id')
    .eq('item_id', itemRowId);

  if (fetchError) throw new Error(`Failed to load existing accounts: ${fetchError.message}`);

  const existingByPlaidId = new Map(existing.map((a) => [a.plaid_account_id, a.id as string]));

  const toInsert: Record<string, unknown>[] = [];
  const toUpdate: { id: string; fields: Record<string, unknown> }[] = [];

  for (const account of plaidAccounts) {
    const fields = {
      plaid_account_id: account.account_id,
      name: account.name,
      official_name: account.official_name,
      type: account.type,
      subtype: account.subtype,
      mask: account.mask,
      current_balance: account.balances.current,
      available_balance: account.balances.available,
      iso_currency_code: account.balances.iso_currency_code ?? 'USD',
    };

    const existingId = existingByPlaidId.get(account.account_id);
    if (existingId) {
      toUpdate.push({ id: existingId, fields });
    } else {
      toInsert.push({ item_id: itemRowId, ...fields });
    }
  }

  if (toInsert.length > 0) {
    const { error } = await supabaseAdmin.from('accounts').insert(toInsert);
    if (error) throw new Error(`Failed to insert accounts: ${error.message}`);
  }

  for (const update of toUpdate) {
    const { error } = await supabaseAdmin.from('accounts').update(update.fields).eq('id', update.id);
    if (error) throw new Error(`Failed to update account: ${error.message}`);
  }

  const { data: final, error: finalError } = await supabaseAdmin
    .from('accounts')
    .select(
      'id, item_id, plaid_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, iso_currency_code, credit_limit, savings_goal, nickname, color, icon, sort_order, hidden, exclude_from_net_worth, exclude_from_cash_flow'
    )
    .eq('item_id', itemRowId);

  if (finalError) throw new Error(`Failed to reload accounts: ${finalError.message}`);
  return final as AccountRow[];
}

async function verifyAccountOwnership(accountId: string, userId: string): Promise<boolean> {
  const { data: owned, error: ownError } = await supabaseAdmin
    .from('accounts')
    .select('id, plaid_items!inner(user_id)')
    .eq('id', accountId)
    .eq('plaid_items.user_id', userId)
    .maybeSingle();

  if (ownError) throw new Error(`Failed to verify account ownership: ${ownError.message}`);
  return !!owned;
}

const ACCOUNT_SELECT_COLUMNS =
  'id, item_id, plaid_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, iso_currency_code, credit_limit, savings_goal, nickname, color, icon, sort_order, hidden, exclude_from_net_worth, exclude_from_cash_flow';

/** credit_limit is user-entered (see AccountRow), never touched by the Plaid balance-refresh
 *  path above — this is the only place it's written. */
export async function updateAccountCreditLimit(
  accountId: string,
  userId: string,
  creditLimit: number | null
): Promise<AccountRow | null> {
  if (!(await verifyAccountOwnership(accountId, userId))) return null;

  const { data, error } = await supabaseAdmin
    .from('accounts')
    .update({ credit_limit: creditLimit })
    .eq('id', accountId)
    .select(ACCOUNT_SELECT_COLUMNS)
    .single();

  if (error) throw new Error(`Failed to update credit limit: ${error.message}`);
  return data as AccountRow;
}

/** savings_goal is user-entered (see AccountRow), never touched by the Plaid balance-refresh
 *  path above — this is the only place it's written. */
export async function updateAccountSavingsGoal(
  accountId: string,
  userId: string,
  savingsGoal: number | null
): Promise<AccountRow | null> {
  if (!(await verifyAccountOwnership(accountId, userId))) return null;

  const { data, error } = await supabaseAdmin
    .from('accounts')
    .update({ savings_goal: savingsGoal })
    .eq('id', accountId)
    .select(ACCOUNT_SELECT_COLUMNS)
    .single();

  if (error) throw new Error(`Failed to update savings goal: ${error.message}`);
  return data as AccountRow;
}

/** Every field here is user-owned (see AccountRow) and never touched by the Plaid sync/refresh
 *  path — this (plus updateAccountCreditLimit/updateAccountSavingsGoal above) is the only place
 *  any of them are written. Partial update — only the provided fields change. */
export async function updateAccountCustomization(
  accountId: string,
  userId: string,
  fields: Partial<{
    nickname: string | null;
    color: string | null;
    icon: string | null;
    sort_order: number;
    hidden: boolean;
    exclude_from_net_worth: boolean;
    exclude_from_cash_flow: boolean;
  }>
): Promise<AccountRow | null> {
  if (!(await verifyAccountOwnership(accountId, userId))) return null;

  const { data, error } = await supabaseAdmin
    .from('accounts')
    .update(fields)
    .eq('id', accountId)
    .select(ACCOUNT_SELECT_COLUMNS)
    .single();

  if (error) throw new Error(`Failed to update account: ${error.message}`);
  return data as AccountRow;
}

export async function getAccountIdMapForItem(itemRowId: string): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('id, plaid_account_id')
    .eq('item_id', itemRowId);

  if (error) throw new Error(`Failed to load accounts: ${error.message}`);
  return new Map(data.map((a) => [a.plaid_account_id as string, a.id as string]));
}

// ---- Transactions -------------------------------------------------------------

function mapPlaidTransaction(transaction: PlaidTransaction, accountId: string) {
  return {
    account_id: accountId,
    plaid_transaction_id: transaction.transaction_id,
    amount: transaction.amount,
    iso_currency_code: transaction.iso_currency_code,
    date: transaction.date,
    name: transaction.name,
    merchant_name: transaction.merchant_name ?? null,
    category: transaction.personal_finance_category?.primary ?? null,
    plaid_category: transaction.category ? transaction.category.join(' > ') : null,
    pending: transaction.pending,
  };
}

/**
 * Applies a batch of Plaid transaction changes (added/modified/removed) against
 * our `transactions` table. `accountIdByPlaidId` maps a Plaid account_id to our
 * accounts.id — transactions we can't match to a known account are skipped.
 * Returns the newly-inserted rows (id/name/merchant_name/amount only) so the caller
 * can run loan-payment matching against them without a second round-trip.
 */
export async function applyTransactionChanges(params: {
  userId: string;
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: RemovedTransaction[];
  accountIdByPlaidId: Map<string, string>;
}): Promise<InsertedTransaction[]> {
  const upsertCandidates = [...params.added, ...params.modified]
    .map((t) => {
      const accountId = params.accountIdByPlaidId.get(t.account_id);
      return accountId ? mapPlaidTransaction(t, accountId) : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  let insertedRows: InsertedTransaction[] = [];

  if (upsertCandidates.length > 0) {
    const plaidIds = upsertCandidates.map((t) => t.plaid_transaction_id);
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('transactions')
      .select('id, plaid_transaction_id')
      .in('plaid_transaction_id', plaidIds);

    if (fetchError) throw new Error(`Failed to load existing transactions: ${fetchError.message}`);

    const existingByPlaidId = new Map(
      existing.map((t) => [t.plaid_transaction_id as string, t.id as string])
    );

    const toInsert = upsertCandidates.filter((t) => !existingByPlaidId.has(t.plaid_transaction_id));
    const toUpdate = upsertCandidates.filter((t) => existingByPlaidId.has(t.plaid_transaction_id));

    if (toInsert.length > 0) {
      // needs_review and budget_category_id (via any matching category mapping) only apply at
      // insert time — added here rather than in mapPlaidTransaction so a later "modified" update
      // (which reuses the same mapped row) never resets an already-reviewed or already-categorized
      // transaction.
      const mappings = await listCategoryMappings(params.userId);
      const budgetCategoryIdByPlaidCategory = new Map(
        mappings.map((m) => [m.plaid_category, m.budget_category_id])
      );
      const rowsToInsert = toInsert.map((t) => ({
        ...t,
        needs_review: true,
        budget_category_id: t.category ? budgetCategoryIdByPlaidCategory.get(t.category) ?? null : null,
      }));
      const { data, error } = await supabaseAdmin
        .from('transactions')
        .insert(rowsToInsert)
        .select('id, name, merchant_name, amount');
      if (error) throw new Error(`Failed to insert transactions: ${error.message}`);
      insertedRows = (data ?? []) as InsertedTransaction[];
    }

    for (const row of toUpdate) {
      const id = existingByPlaidId.get(row.plaid_transaction_id)!;
      const { plaid_transaction_id: _ignored, ...fields } = row;
      const { error } = await supabaseAdmin.from('transactions').update(fields).eq('id', id);
      if (error) throw new Error(`Failed to update transaction: ${error.message}`);
    }
  }

  if (params.removed.length > 0) {
    const removedIds = params.removed.map((t) => t.transaction_id);
    const { error } = await supabaseAdmin
      .from('transactions')
      .delete()
      .in('plaid_transaction_id', removedIds);

    if (error) throw new Error(`Failed to delete removed transactions: ${error.message}`);
  }

  return insertedRows;
}

export async function getRecentTransactionsForUser(userId: string, limit: number) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select(
      'id, amount, iso_currency_code, date, name, merchant_name, category, plaid_category, pending, budget_category_id, needs_review, accounts!inner(name, nickname, plaid_items!inner(user_id, institution_name)), splits:transaction_splits(id, budget_category_id, amount, note)'
    )
    .eq('accounts.plaid_items.user_id', userId)
    .order('date', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to load transactions: ${error.message}`);
  return data;
}

/** Excludes transactions on an account flagged exclude_from_cash_flow — feeds Monthly
 *  Spending/Cash Flow Pace/Savings Rate, all personal cash-flow aggregates. The individual
 *  transactions still appear in the main feed (getRecentTransactionsForUser), which deliberately
 *  has no such filter. */
export async function getTransactionsSince(
  userId: string,
  sinceDate: string
): Promise<{ amount: number; date: string }[]> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('amount, date, accounts!inner(exclude_from_cash_flow, plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
    .eq('accounts.exclude_from_cash_flow', false)
    .gte('date', sinceDate)
    .order('date', { ascending: true });

  if (error) throw new Error(`Failed to load transaction history: ${error.message}`);
  return data;
}

/** Like getTransactionsSince, but also includes Plaid's own category — for the monthly
 *  breakdown view, which groups by Plaid's taxonomy rather than the user's budget categories
 *  (Plaid categorizes essentially every transaction; budget categories are optional/sparse). */
export async function getCategorizedTransactionsSince(
  userId: string,
  sinceDate: string
): Promise<{ amount: number; date: string; category: string | null }[]> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('amount, date, category, accounts!inner(exclude_from_cash_flow, plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
    .eq('accounts.exclude_from_cash_flow', false)
    .gte('date', sinceDate)
    .order('date', { ascending: true });

  if (error) throw new Error(`Failed to load categorized transaction history: ${error.message}`);
  return data;
}

/** Returns the owning user_id for a transaction (via accounts -> plaid_items), or null if it doesn't exist. */
export async function getTransactionOwnerId(transactionId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('id, accounts!inner(plaid_items!inner(user_id))')
    .eq('id', transactionId)
    .maybeSingle();

  if (error) throw new Error(`Failed to look up transaction: ${error.message}`);
  if (!data) return null;

  const accounts = data.accounts as unknown as { plaid_items: { user_id: string } };
  return accounts.plaid_items.user_id;
}

export async function setTransactionCategory(
  transactionId: string,
  budgetCategoryId: string | null
): Promise<TransactionRow> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update({ budget_category_id: budgetCategoryId })
    .eq('id', transactionId)
    .select()
    .single();

  if (error) throw new Error(`Failed to set transaction category: ${error.message}`);
  return data as TransactionRow;
}

export async function approveTransaction(transactionId: string): Promise<TransactionRow> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update({ needs_review: false })
    .eq('id', transactionId)
    .select()
    .single();

  if (error) throw new Error(`Failed to approve transaction: ${error.message}`);
  return data as TransactionRow;
}

/** Outflow (positive-amount) transactions not yet linked to a manual loan — the candidate pool
 *  for backfilling matches when a loan's match_text is set or changed after transactions already
 *  exist (auto-linking during sync only sees newly-added transactions, not history). */
export async function getUnlinkedOutflowTransactionsForUser(
  userId: string
): Promise<InsertedTransaction[]> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('id, name, merchant_name, amount, accounts!inner(plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
    .is('manual_loan_id', null)
    .gt('amount', 0);

  if (error) throw new Error(`Failed to load unlinked transactions: ${error.message}`);
  return data as unknown as InsertedTransaction[];
}

// ---- Recurring streams ---------------------------------------------------------

/** Replaces (upserts by item_id + plaid_stream_id) an item's recurring streams from a fresh Plaid response. */
export async function upsertRecurringStreams(
  itemRowId: string,
  streams: { direction: 'inflow' | 'outflow'; stream: TransactionStream }[],
  accountIdByPlaidId: Map<string, string>
): Promise<void> {
  if (streams.length === 0) return;

  const rows = streams.map(({ direction, stream }) => ({
    item_id: itemRowId,
    account_id: accountIdByPlaidId.get(stream.account_id) ?? null,
    plaid_stream_id: stream.stream_id,
    description: stream.description,
    merchant_name: stream.merchant_name,
    direction,
    frequency: stream.frequency,
    average_amount: stream.average_amount.amount ?? 0,
    last_amount: stream.last_amount.amount ?? 0,
    iso_currency_code: stream.average_amount.iso_currency_code ?? 'USD',
    first_date: stream.first_date,
    last_date: stream.last_date,
    is_active: stream.is_active,
    status: stream.status,
    category: stream.personal_finance_category?.primary ?? null,
  }));

  const { error } = await supabaseAdmin
    .from('recurring_streams')
    .upsert(rows, { onConflict: 'item_id,plaid_stream_id' });

  if (error) throw new Error(`Failed to save recurring streams: ${error.message}`);
}

/** Excludes streams on an account flagged exclude_from_cash_flow — feeds Subscriptions &
 *  Recurring totals, Income & Savings' income breakdown, and Overview's Upcoming Bills, all of
 *  which are personal cash-flow views. account_id is nullable on this table, so the accounts
 *  relation is a left embed (not `!inner`) filtered in application code rather than the query
 *  itself — an inner join/filter here would silently drop any stream with no account_id, which
 *  isn't what exclusion means. */
export async function getRecurringStreamsForUser(userId: string): Promise<RecurringStreamRow[]> {
  const { data, error } = await supabaseAdmin
    .from('recurring_streams')
    .select(
      'id, item_id, account_id, plaid_stream_id, description, merchant_name, direction, frequency, average_amount, last_amount, iso_currency_code, first_date, last_date, is_active, status, category, plaid_items!inner(user_id), accounts(exclude_from_cash_flow)'
    )
    .eq('plaid_items.user_id', userId)
    .eq('is_active', true);

  if (error) throw new Error(`Failed to load recurring streams: ${error.message}`);
  const rows = data as unknown as (RecurringStreamRow & { accounts: { exclude_from_cash_flow: boolean } | null })[];
  return rows
    .filter((row) => !row.accounts?.exclude_from_cash_flow)
    .map(({ accounts: _accounts, ...row }) => row);
}

// ---- Loans ----------------------------------------------------------------------

/** Replaces (upserts by item_id + plaid_account_id) an item's loan/liability details from a fresh Plaid response. */
export async function upsertLoans(
  itemRowId: string,
  loans: NormalizedLoan[],
  accountIdByPlaidId: Map<string, string>
): Promise<void> {
  if (loans.length === 0) return;

  const rows = loans.map((loan) => ({
    item_id: itemRowId,
    account_id: accountIdByPlaidId.get(loan.plaid_account_id) ?? null,
    plaid_account_id: loan.plaid_account_id,
    loan_type: loan.loan_type,
    name: loan.name,
    interest_rate_percentage: loan.interest_rate_percentage,
    origination_principal_amount: loan.origination_principal_amount,
    origination_date: loan.origination_date,
    minimum_payment_amount: loan.minimum_payment_amount,
    next_payment_due_date: loan.next_payment_due_date,
    last_payment_amount: loan.last_payment_amount,
    last_payment_date: loan.last_payment_date,
    is_overdue: loan.is_overdue,
  }));

  const { error } = await supabaseAdmin
    .from('loans')
    .upsert(rows, { onConflict: 'item_id,plaid_account_id' });

  if (error) throw new Error(`Failed to save loans: ${error.message}`);
}

export interface LoanWithAccount extends LoanRow {
  account_name: string | null;
  current_balance: number | null;
  iso_currency_code: string | null;
}

export async function getLoansForUser(userId: string): Promise<LoanWithAccount[]> {
  const { data, error } = await supabaseAdmin
    .from('loans')
    .select(
      'id, item_id, account_id, plaid_account_id, loan_type, name, interest_rate_percentage, origination_principal_amount, origination_date, minimum_payment_amount, next_payment_due_date, last_payment_amount, last_payment_date, is_overdue, plaid_items!inner(user_id), accounts(name, current_balance, iso_currency_code)'
    )
    .eq('plaid_items.user_id', userId);

  if (error) throw new Error(`Failed to load loans: ${error.message}`);

  return (
    data as unknown as (LoanRow & {
      accounts: { name: string; current_balance: number | null; iso_currency_code: string | null } | null;
    })[]
  ).map(({ accounts, ...loan }) => ({
    ...loan,
    account_name: accounts?.name ?? null,
    current_balance: accounts?.current_balance ?? null,
    iso_currency_code: accounts?.iso_currency_code ?? null,
  }));
}

// ---- Manual loans -----------------------------------------------------------------

/** Loans the user enters by hand — for accounts Plaid's Liabilities product doesn't cover
 *  (e.g. a personal loan from an online lender), directly user-owned rather than tied to a
 *  Plaid item, same ownership pattern as budget_categories. */
export async function listManualLoans(userId: string): Promise<ManualLoanRow[]> {
  const { data, error } = await supabaseAdmin
    .from('manual_loans')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });

  if (error) throw new Error(`Failed to load manual loans: ${error.message}`);
  return data as ManualLoanRow[];
}

export async function createManualLoan(
  userId: string,
  params: {
    name: string;
    loanType: string;
    currentBalance: number;
    originationPrincipalAmount: number | null;
    interestRatePercentage: number | null;
    originationDate: string | null;
    termMonths: number | null;
    minimumPaymentAmount: number | null;
    nextPaymentDueDate: string | null;
    notes: string | null;
    matchText: string | null;
  }
): Promise<ManualLoanRow> {
  const { data, error } = await supabaseAdmin
    .from('manual_loans')
    .insert({
      user_id: userId,
      name: params.name,
      loan_type: params.loanType,
      current_balance: params.currentBalance,
      origination_principal_amount: params.originationPrincipalAmount,
      interest_rate_percentage: params.interestRatePercentage,
      origination_date: params.originationDate,
      term_months: params.termMonths,
      minimum_payment_amount: params.minimumPaymentAmount,
      next_payment_due_date: params.nextPaymentDueDate,
      notes: params.notes,
      match_text: params.matchText,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create manual loan: ${error.message}`);
  return data as ManualLoanRow;
}

export async function updateManualLoan(
  id: string,
  userId: string,
  fields: Partial<{
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
  }>
): Promise<ManualLoanRow | null> {
  const { data, error } = await supabaseAdmin
    .from('manual_loans')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to update manual loan: ${error.message}`);
  return data as ManualLoanRow | null;
}

export async function deleteManualLoan(id: string, userId: string): Promise<void> {
  const { error } = await supabaseAdmin.from('manual_loans').delete().eq('id', id).eq('user_id', userId);
  if (error) throw new Error(`Failed to delete manual loan: ${error.message}`);
}

export async function getManualLoan(id: string, userId: string): Promise<ManualLoanRow | null> {
  const { data, error } = await supabaseAdmin
    .from('manual_loans')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load manual loan: ${error.message}`);
  return data as ManualLoanRow | null;
}

async function adjustManualLoanBalance(loanId: string, delta: number): Promise<void> {
  const { data: loan, error: fetchError } = await supabaseAdmin
    .from('manual_loans')
    .select('current_balance')
    .eq('id', loanId)
    .single();

  if (fetchError) throw new Error(`Failed to load manual loan balance: ${fetchError.message}`);

  const newBalance = Math.max(0, roundToCents((loan.current_balance as number) + delta));
  const { error: updateError } = await supabaseAdmin
    .from('manual_loans')
    .update({ current_balance: newBalance, updated_at: new Date().toISOString() })
    .eq('id', loanId);

  if (updateError) throw new Error(`Failed to update manual loan balance: ${updateError.message}`);
}

/** Links a transaction to a manual loan and decrements the loan's balance by principalPortion
 *  (the part of the payment that reduces principal, as opposed to interest). */
export async function linkTransactionToLoan(
  transactionId: string,
  loanId: string,
  principalPortion: number
): Promise<void> {
  const { error } = await supabaseAdmin
    .from('transactions')
    .update({ manual_loan_id: loanId, principal_portion: principalPortion })
    .eq('id', transactionId);

  if (error) throw new Error(`Failed to link transaction to loan: ${error.message}`);
  await adjustManualLoanBalance(loanId, -principalPortion);
}

export async function getLinkedPaymentsForLoan(
  loanId: string
): Promise<{ id: string; date: string; name: string; merchant_name: string | null; amount: number; principal_portion: number | null }[]> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('id, date, name, merchant_name, amount, principal_portion')
    .eq('manual_loan_id', loanId)
    .order('date', { ascending: false });

  if (error) throw new Error(`Failed to load linked payments: ${error.message}`);
  return data;
}

/** Edits how much of an already-linked payment counts toward principal, adjusting the loan's
 *  balance by the difference so it stays consistent with the new value. */
export async function updateLinkedPaymentPrincipal(
  transactionId: string,
  loanId: string,
  newPrincipalPortion: number
): Promise<void> {
  const { data: txn, error: fetchError } = await supabaseAdmin
    .from('transactions')
    .select('principal_portion, manual_loan_id')
    .eq('id', transactionId)
    .maybeSingle();

  if (fetchError) throw new Error(`Failed to load payment: ${fetchError.message}`);
  if (!txn || txn.manual_loan_id !== loanId) throw new Error('Payment is not linked to this loan');

  const oldPortion = (txn.principal_portion as number | null) ?? 0;

  const { error: updateError } = await supabaseAdmin
    .from('transactions')
    .update({ principal_portion: newPrincipalPortion })
    .eq('id', transactionId);

  if (updateError) throw new Error(`Failed to update payment: ${updateError.message}`);
  await adjustManualLoanBalance(loanId, oldPortion - newPrincipalPortion);
}

/** Reverses a payment link — restores the loan's balance by the portion that had been applied
 *  and clears the link, e.g. to correct a false-positive text match. */
export async function unlinkPaymentFromLoan(transactionId: string, loanId: string): Promise<void> {
  const { data: txn, error: fetchError } = await supabaseAdmin
    .from('transactions')
    .select('principal_portion, manual_loan_id')
    .eq('id', transactionId)
    .maybeSingle();

  if (fetchError) throw new Error(`Failed to load payment: ${fetchError.message}`);
  if (!txn || txn.manual_loan_id !== loanId) throw new Error('Payment is not linked to this loan');

  const oldPortion = (txn.principal_portion as number | null) ?? 0;

  const { error: updateError } = await supabaseAdmin
    .from('transactions')
    .update({ manual_loan_id: null, principal_portion: null })
    .eq('id', transactionId);

  if (updateError) throw new Error(`Failed to unlink payment: ${updateError.message}`);
  await adjustManualLoanBalance(loanId, oldPortion);
}

/** Sums how much principal and interest have been paid on each of the given loans, combining
 *  both payment sources: auto-linked/backfilled bank transactions (whose interest is implicitly
 *  amount-minus-principal) and manually-logged payments (which store both portions explicitly).
 *  Loans with no payments from either source are simply absent from the returned map. */
export async function getLifetimeTotalsByLoanId(
  loanIds: string[]
): Promise<Map<string, { principalPaid: number; interestPaid: number }>> {
  const totals = new Map<string, { principalPaid: number; interestPaid: number }>();
  if (loanIds.length === 0) return totals;

  function add(loanId: string, principal: number, interest: number) {
    const entry = totals.get(loanId) ?? { principalPaid: 0, interestPaid: 0 };
    entry.principalPaid += principal;
    entry.interestPaid += interest;
    totals.set(loanId, entry);
  }

  const { data: txnRows, error: txnError } = await supabaseAdmin
    .from('transactions')
    .select('manual_loan_id, amount, principal_portion')
    .in('manual_loan_id', loanIds);
  if (txnError) throw new Error(`Failed to load linked payment totals: ${txnError.message}`);

  for (const row of txnRows) {
    const principal = (row.principal_portion as number | null) ?? 0;
    add(row.manual_loan_id as string, principal, (row.amount as number) - principal);
  }

  const { data: manualRows, error: manualError } = await supabaseAdmin
    .from('manual_loan_payments')
    .select('loan_id, principal_portion, interest_portion')
    .in('loan_id', loanIds);
  if (manualError) throw new Error(`Failed to load manual payment totals: ${manualError.message}`);

  for (const row of manualRows) {
    add(row.loan_id as string, row.principal_portion as number, row.interest_portion as number);
  }

  return totals;
}

export async function listManualLoanPayments(loanId: string): Promise<ManualLoanPaymentRow[]> {
  const { data, error } = await supabaseAdmin
    .from('manual_loan_payments')
    .select('*')
    .eq('loan_id', loanId)
    .order('date', { ascending: false });

  if (error) throw new Error(`Failed to load manual payments: ${error.message}`);
  return data as ManualLoanPaymentRow[];
}

export async function createManualLoanPayment(
  userId: string,
  loanId: string,
  params: { date: string; principalPortion: number; interestPortion: number; notes: string | null }
): Promise<ManualLoanPaymentRow> {
  const { data, error } = await supabaseAdmin
    .from('manual_loan_payments')
    .insert({
      user_id: userId,
      loan_id: loanId,
      date: params.date,
      principal_portion: params.principalPortion,
      interest_portion: params.interestPortion,
      notes: params.notes,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create manual payment: ${error.message}`);
  await adjustManualLoanBalance(loanId, -params.principalPortion);
  return data as ManualLoanPaymentRow;
}

export async function updateManualLoanPayment(
  id: string,
  loanId: string,
  fields: Partial<{ date: string; principal_portion: number; interest_portion: number; notes: string | null }>
): Promise<ManualLoanPaymentRow | null> {
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from('manual_loan_payments')
    .select('principal_portion')
    .eq('id', id)
    .eq('loan_id', loanId)
    .maybeSingle();

  if (fetchError) throw new Error(`Failed to load manual payment: ${fetchError.message}`);
  if (!existing) return null;

  const { data, error } = await supabaseAdmin
    .from('manual_loan_payments')
    .update(fields)
    .eq('id', id)
    .eq('loan_id', loanId)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to update manual payment: ${error.message}`);
  if (!data) return null;

  if (fields.principal_portion !== undefined) {
    const oldPortion = existing.principal_portion as number;
    await adjustManualLoanBalance(loanId, oldPortion - fields.principal_portion);
  }

  return data as ManualLoanPaymentRow;
}

export async function deleteManualLoanPayment(id: string, loanId: string): Promise<void> {
  const { data: existing, error: fetchError } = await supabaseAdmin
    .from('manual_loan_payments')
    .select('principal_portion')
    .eq('id', id)
    .eq('loan_id', loanId)
    .maybeSingle();

  if (fetchError) throw new Error(`Failed to load manual payment: ${fetchError.message}`);
  if (!existing) return;

  const { error } = await supabaseAdmin
    .from('manual_loan_payments')
    .delete()
    .eq('id', id)
    .eq('loan_id', loanId);

  if (error) throw new Error(`Failed to delete manual payment: ${error.message}`);
  await adjustManualLoanBalance(loanId, existing.principal_portion as number);
}

// ---- Budget categories ---------------------------------------------------------

export async function listBudgetCategories(userId: string): Promise<BudgetCategoryRow[]> {
  const { data, error } = await supabaseAdmin
    .from('budget_categories')
    .select('*')
    .eq('user_id', userId)
    .order('sort_order', { ascending: true });

  if (error) throw new Error(`Failed to load budget categories: ${error.message}`);
  return data as BudgetCategoryRow[];
}

/** Categorized transaction amounts for a user within [start, end) — the raw material for
 *  per-category spend totals. A transaction with one or more splits contributes its split rows
 *  instead of its own budget_category_id/amount — the splits are the source of truth for how a
 *  split transaction's amount is categorized, so its own row is dropped entirely to avoid
 *  double-counting. */
export async function getCategorySpendRows(
  userId: string,
  range: { start: string; end: string }
): Promise<{ budget_category_id: string | null; amount: number }[]> {
  const { data: transactions, error: txnError } = await supabaseAdmin
    .from('transactions')
    .select('id, budget_category_id, amount, accounts!inner(exclude_from_cash_flow, plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
    .eq('accounts.exclude_from_cash_flow', false)
    .gte('date', range.start)
    .lt('date', range.end);

  if (txnError) throw new Error(`Failed to load category spend: ${txnError.message}`);

  const { data: splits, error: splitError } = await supabaseAdmin
    .from('transaction_splits')
    .select(
      'transaction_id, budget_category_id, amount, transactions!inner(date, accounts!inner(exclude_from_cash_flow, plaid_items!inner(user_id)))'
    )
    .eq('transactions.accounts.plaid_items.user_id', userId)
    .eq('transactions.accounts.exclude_from_cash_flow', false)
    .gte('transactions.date', range.start)
    .lt('transactions.date', range.end);

  if (splitError) throw new Error(`Failed to load split spend: ${splitError.message}`);

  const splitRows = splits as unknown as { transaction_id: string; budget_category_id: string; amount: number }[];
  const splitTransactionIds = new Set(splitRows.map((s) => s.transaction_id));

  const unsplitTransactionRows = (
    transactions as unknown as { id: string; budget_category_id: string | null; amount: number }[]
  )
    .filter((t) => !splitTransactionIds.has(t.id))
    .map((t) => ({ budget_category_id: t.budget_category_id, amount: t.amount }));

  return [
    ...unsplitTransactionRows,
    ...splitRows.map((s) => ({ budget_category_id: s.budget_category_id, amount: s.amount })),
  ];
}

export async function createBudgetCategory(
  userId: string,
  params: { name: string; budgetAmount: number; color: string | null; sortOrder: number; emoji: string | null }
): Promise<BudgetCategoryRow> {
  const { data, error } = await supabaseAdmin
    .from('budget_categories')
    .insert({
      user_id: userId,
      name: params.name,
      budget_amount: params.budgetAmount,
      color: params.color,
      sort_order: params.sortOrder,
      emoji: params.emoji,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create budget category: ${error.message}`);
  return data as BudgetCategoryRow;
}

export async function updateBudgetCategory(
  id: string,
  userId: string,
  fields: Partial<{
    name: string;
    budget_amount: number;
    color: string | null;
    sort_order: number;
    emoji: string | null;
    archived_at: string | null;
  }>
): Promise<BudgetCategoryRow | null> {
  const { data, error } = await supabaseAdmin
    .from('budget_categories')
    .update(fields)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .maybeSingle();

  if (error) throw new Error(`Failed to update budget category: ${error.message}`);
  return data as BudgetCategoryRow | null;
}

export async function budgetCategoryBelongsToUser(id: string, userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('budget_categories')
    .select('id')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Failed to verify budget category: ${error.message}`);
  return data !== null;
}

/** Used where a caller needs more than ownership (e.g. checking archived_at before allowing a new
 *  category mapping) — budgetCategoryBelongsToUser stays boolean-only for its existing call sites,
 *  which must keep accepting archived categories (categorizing/splitting a transaction against an
 *  already-archived category is a historical edit, not a new-mapping action). */
export async function getBudgetCategoryForUser(id: string, userId: string): Promise<BudgetCategoryRow | null> {
  const { data, error } = await supabaseAdmin
    .from('budget_categories')
    .select('*')
    .eq('id', id)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load budget category: ${error.message}`);
  return data as BudgetCategoryRow | null;
}

export async function deleteBudgetCategory(id: string, userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('budget_categories')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to delete budget category: ${error.message}`);
}

// ---- Category mappings ---------------------------------------------------------

export async function listCategoryMappings(userId: string): Promise<CategoryMappingRow[]> {
  const { data, error } = await supabaseAdmin
    .from('category_mappings')
    .select('*')
    .eq('user_id', userId)
    .order('plaid_category', { ascending: true });

  if (error) throw new Error(`Failed to load category mappings: ${error.message}`);
  return data as CategoryMappingRow[];
}

/** The distinct Plaid categories present across the user's own synced transactions — the set of
 *  values a mapping can usefully target, shown as options in the mapping UI. */
export async function listDistinctPlaidCategoriesForUser(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('category, accounts!inner(plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
    .not('category', 'is', null);

  if (error) throw new Error(`Failed to load transaction categories: ${error.message}`);
  const unique = new Set((data as unknown as { category: string }[]).map((row) => row.category));
  return [...unique].sort();
}

export async function upsertCategoryMapping(
  userId: string,
  plaidCategory: string,
  budgetCategoryId: string
): Promise<CategoryMappingRow> {
  const { data, error } = await supabaseAdmin
    .from('category_mappings')
    .upsert(
      { user_id: userId, plaid_category: plaidCategory, budget_category_id: budgetCategoryId },
      { onConflict: 'user_id,plaid_category' }
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to save category mapping: ${error.message}`);
  return data as CategoryMappingRow;
}

export async function deleteCategoryMapping(id: string, userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('category_mappings')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to delete category mapping: ${error.message}`);
}

/** Called when a budget category is archived — mappings exist to drive ongoing auto-categorization
 *  of newly-synced transactions, which should stop once their target category is archived, so the
 *  mapped Plaid category reverts to "Unmapped" until remapped to an active category. Returns the
 *  ids of the mappings removed, so the caller can update its own state without a refetch. */
export async function deleteCategoryMappingsForBudgetCategory(
  budgetCategoryId: string,
  userId: string
): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from('category_mappings')
    .delete()
    .eq('budget_category_id', budgetCategoryId)
    .eq('user_id', userId)
    .select('id');

  if (error) throw new Error(`Failed to remove mappings for archived category: ${error.message}`);
  return (data as { id: string }[] | null ?? []).map((row) => row.id);
}

/** Applies a mapping retroactively to the user's already-synced transactions that match its Plaid
 *  category and have no budget category yet — never overwrites a transaction the user (or a
 *  previous mapping) already categorized. Returns how many rows were updated. */
export async function backfillCategoryMapping(
  userId: string,
  plaidCategory: string,
  budgetCategoryId: string
): Promise<number> {
  const { data: matches, error: fetchError } = await supabaseAdmin
    .from('transactions')
    .select('id, accounts!inner(plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
    .eq('category', plaidCategory)
    .is('budget_category_id', null);

  if (fetchError) throw new Error(`Failed to find transactions to backfill: ${fetchError.message}`);
  const ids = (matches as unknown as { id: string }[]).map((m) => m.id);
  if (ids.length === 0) return 0;

  const { error: updateError } = await supabaseAdmin
    .from('transactions')
    .update({ budget_category_id: budgetCategoryId })
    .in('id', ids);

  if (updateError) throw new Error(`Failed to backfill transactions: ${updateError.message}`);
  return ids.length;
}

// ---- Transaction splits ---------------------------------------------------------

/** Replaces a transaction's splits wholesale (delete-then-insert — there's no natural way to
 *  diff a list of line items against what's already there). Throws if the transaction doesn't
 *  belong to the user, or if the new splits don't sum to the transaction's own amount — a split
 *  reallocates the existing amount across categories, it doesn't change it. */
export async function setTransactionSplits(
  transactionId: string,
  userId: string,
  splits: { budgetCategoryId: string; amount: number; note: string | null }[]
): Promise<TransactionSplitRow[]> {
  const { data: txn, error: fetchError } = await supabaseAdmin
    .from('transactions')
    .select('amount, accounts!inner(plaid_items!inner(user_id))')
    .eq('id', transactionId)
    .maybeSingle();

  if (fetchError) throw new Error(`Failed to load transaction: ${fetchError.message}`);
  if (!txn) throw new Error('Transaction not found');

  const owner = (txn.accounts as unknown as { plaid_items: { user_id: string } }).plaid_items.user_id;
  if (owner !== userId) throw new Error('Transaction not found');

  const total = roundToCents(splits.reduce((sum, s) => sum + s.amount, 0));
  if (total !== roundToCents(txn.amount as number)) {
    throw new Error(`Splits must add up to the transaction's amount (${(txn.amount as number).toFixed(2)})`);
  }

  const { error: deleteError } = await supabaseAdmin
    .from('transaction_splits')
    .delete()
    .eq('transaction_id', transactionId);
  if (deleteError) throw new Error(`Failed to clear existing splits: ${deleteError.message}`);

  const { data, error: insertError } = await supabaseAdmin
    .from('transaction_splits')
    .insert(
      splits.map((s) => ({
        transaction_id: transactionId,
        budget_category_id: s.budgetCategoryId,
        amount: s.amount,
        note: s.note,
      }))
    )
    .select();

  if (insertError) throw new Error(`Failed to save transaction splits: ${insertError.message}`);
  return data as TransactionSplitRow[];
}

export async function clearTransactionSplits(transactionId: string, userId: string): Promise<void> {
  const ownerId = await getTransactionOwnerId(transactionId);
  if (!ownerId || ownerId !== userId) throw new Error('Transaction not found');

  const { error } = await supabaseAdmin.from('transaction_splits').delete().eq('transaction_id', transactionId);
  if (error) throw new Error(`Failed to clear transaction splits: ${error.message}`);
}

// ---- User preferences ---------------------------------------------------------

export async function getUserPreferences(userId: string): Promise<UserPreferencesRow | null> {
  const { data, error } = await supabaseAdmin
    .from('user_preferences')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load user preferences: ${error.message}`);
  return data as UserPreferencesRow | null;
}

/** Upserts just the dashboard_layout column — deliberately not a general "save the whole
 *  preferences row" function, so a future preference (e.g. a dedicated accent_color column) gets
 *  its own equally-narrow update function instead of every caller having to pass every column. */
export async function upsertDashboardLayout(
  userId: string,
  dashboardLayout: { cards: { id: string; visible: boolean }[] }
): Promise<UserPreferencesRow> {
  const { data, error } = await supabaseAdmin
    .from('user_preferences')
    .upsert(
      { user_id: userId, dashboard_layout: dashboardLayout, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to save dashboard layout: ${error.message}`);
  return data as UserPreferencesRow;
}

/** Upserts just theme/accent_color — same narrow-update reasoning as upsertDashboardLayout. */
export async function upsertAppearance(
  userId: string,
  appearance: { theme: string; accentColor: string }
): Promise<UserPreferencesRow> {
  const { data, error } = await supabaseAdmin
    .from('user_preferences')
    .upsert(
      {
        user_id: userId,
        theme: appearance.theme,
        accent_color: appearance.accentColor,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to save appearance: ${error.message}`);
  return data as UserPreferencesRow;
}
