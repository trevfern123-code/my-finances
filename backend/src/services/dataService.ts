import { supabaseAdmin } from '../config/supabase';
import type {
  AccountRow,
  BudgetCategoryRow,
  LoanRow,
  PlaidItemRow,
  RecurringStreamRow,
  TransactionRow,
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
): Promise<Pick<PlaidItemRow, 'id' | 'access_token' | 'transactions_cursor'>[]> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .select('id, access_token, transactions_cursor')
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
): Promise<Pick<PlaidItemRow, 'id' | 'access_token' | 'transactions_cursor'> | null> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .select('id, access_token, transactions_cursor')
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
      'id, institution_id, institution_name, status, accounts(id, name, official_name, type, subtype, mask, current_balance, available_balance, iso_currency_code)'
    )
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to load linked items: ${error.message}`);
  return data;
}

// ---- Accounts ---------------------------------------------------------------

export async function getAccountBalancesForUser(
  userId: string
): Promise<{ type: string; current_balance: number | null }[]> {
  const { data, error } = await supabaseAdmin
    .from('accounts')
    .select('type, current_balance, plaid_items!inner(user_id)')
    .eq('plaid_items.user_id', userId);

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
      'id, item_id, plaid_account_id, name, official_name, type, subtype, mask, current_balance, available_balance, iso_currency_code'
    )
    .eq('item_id', itemRowId);

  if (finalError) throw new Error(`Failed to reload accounts: ${finalError.message}`);
  return final as AccountRow[];
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
 */
export async function applyTransactionChanges(params: {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: RemovedTransaction[];
  accountIdByPlaidId: Map<string, string>;
}) {
  const upsertCandidates = [...params.added, ...params.modified]
    .map((t) => {
      const accountId = params.accountIdByPlaidId.get(t.account_id);
      return accountId ? mapPlaidTransaction(t, accountId) : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

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
      const { error } = await supabaseAdmin.from('transactions').insert(toInsert);
      if (error) throw new Error(`Failed to insert transactions: ${error.message}`);
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
}

export async function getRecentTransactionsForUser(userId: string, limit: number) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select(
      'id, amount, iso_currency_code, date, name, merchant_name, category, plaid_category, pending, budget_category_id, accounts!inner(name, plaid_items!inner(user_id, institution_name))'
    )
    .eq('accounts.plaid_items.user_id', userId)
    .order('date', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Failed to load transactions: ${error.message}`);
  return data;
}

export async function getTransactionsSince(
  userId: string,
  sinceDate: string
): Promise<{ amount: number; date: string }[]> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('amount, date, accounts!inner(plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
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
    .select('amount, date, category, accounts!inner(plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
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

export async function getRecurringStreamsForUser(userId: string): Promise<RecurringStreamRow[]> {
  const { data, error } = await supabaseAdmin
    .from('recurring_streams')
    .select(
      'id, item_id, account_id, plaid_stream_id, description, merchant_name, direction, frequency, average_amount, last_amount, iso_currency_code, first_date, last_date, is_active, status, category, plaid_items!inner(user_id)'
    )
    .eq('plaid_items.user_id', userId)
    .eq('is_active', true);

  if (error) throw new Error(`Failed to load recurring streams: ${error.message}`);
  return data as unknown as RecurringStreamRow[];
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

/** Categorized transaction amounts for a user within [start, end) — the raw material for per-category spend totals. */
export async function getCategorySpendRows(
  userId: string,
  range: { start: string; end: string }
): Promise<{ budget_category_id: string | null; amount: number }[]> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('budget_category_id, amount, accounts!inner(plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
    .not('budget_category_id', 'is', null)
    .gte('date', range.start)
    .lt('date', range.end);

  if (error) throw new Error(`Failed to load category spend: ${error.message}`);
  return data;
}

export async function createBudgetCategory(
  userId: string,
  params: { name: string; budgetAmount: number; color: string | null; sortOrder: number }
): Promise<BudgetCategoryRow> {
  const { data, error } = await supabaseAdmin
    .from('budget_categories')
    .insert({
      user_id: userId,
      name: params.name,
      budget_amount: params.budgetAmount,
      color: params.color,
      sort_order: params.sortOrder,
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create budget category: ${error.message}`);
  return data as BudgetCategoryRow;
}

export async function updateBudgetCategory(
  id: string,
  userId: string,
  fields: Partial<{ name: string; budget_amount: number; color: string | null; sort_order: number }>
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

export async function deleteBudgetCategory(id: string, userId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('budget_categories')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to delete budget category: ${error.message}`);
}
