import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '../config/supabase';
import { roundToCents } from './money';
import { classifyRowLevel, CURRENT_CLASSIFIER_VERSION, type SemanticRole } from './transactionClassifier';
import {
  normalizePrincipalPortion,
  normalizeNonNegativeMoneyAmount,
  assertLinkedPaymentAmountIsCompatible,
} from './semanticEffects';
import {
  decryptAccessToken,
  encryptAccessToken,
  getKeyRing,
  MissingEncryptedRepresentationError,
  PartialEncryptedRepresentationError,
  type EncryptedAccessToken,
} from './tokenEncryption';
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

/** `PlaidItemRow.access_token` is `string | null` at the schema level (a row can be
 *  encrypted-only), but every function below always resolves it to a real string before
 *  returning (`resolveAccessToken` never returns null) — this narrows just the one field back to
 *  non-nullable for callers, none of which should ever need to null-check it (§6.1: callers stay
 *  exactly as unaware of encryption as they were before this migration). */
type ResolvedPlaidItem<K extends keyof PlaidItemRow> = Omit<Pick<PlaidItemRow, K>, 'access_token'> & {
  access_token: string;
};

/** Columns needed to resolve a row's effective access token — every Plaid-item read function
 *  below selects at least these, in addition to whatever else it needs. */
const ENCRYPTED_TOKEN_COLUMNS =
  'access_token, access_token_ciphertext, access_token_nonce, access_token_auth_tag, access_token_key_id, access_token_enc_version';

interface EncryptedTokenRow {
  access_token: string | null;
  access_token_ciphertext: string | null;
  access_token_nonce: string | null;
  access_token_auth_tag: string | null;
  access_token_key_id: string | null;
  access_token_enc_version: number | null;
}

/** Exactly one of `access_token_ciphertext`/`_nonce`/`_auth_tag`/`_key_id`/`_enc_version` — never
 *  inferred from any single one of them (§27, Phase 2b revision). The Phase 1
 *  `plaid_items_encrypted_token_complete` check constraint already guarantees these five columns
 *  are NULL or non-NULL *together* at the database level, but `resolveAccessToken` below checks
 *  all five explicitly anyway rather than trusting that constraint alone — a schema constraint
 *  guaranteeing a shape is not the same thing as application code proving it before acting on it,
 *  and this is the one place in the codebase that decides whether a stored credential is safe to
 *  decrypt. */
type EncryptedFieldsState = 'none' | 'partial' | 'complete';

function classifyEncryptedFields(row: EncryptedTokenRow): EncryptedFieldsState {
  const fields = [
    row.access_token_ciphertext,
    row.access_token_nonce,
    row.access_token_auth_tag,
    row.access_token_key_id,
    row.access_token_enc_version,
  ];
  const present = fields.filter((f) => f !== null).length;
  if (present === 5) return 'complete';
  if (present === 0) return 'none';
  return 'partial';
}

/** Dual-read (PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md §7 Phases 2-5, §8's fail-closed rule, §27's
 *  Phase 2b revision): the encrypted representation is preferred whenever fully present,
 *  decrypted here so every caller keeps receiving a plain string exactly as before (§6.1) — none
 *  of them need to become "encryption-aware." A decryption failure (any `PlaidCredentialError`
 *  subclass) propagates straight up, uncaught — there is deliberately no `catch` here that would
 *  fall back to the plaintext column once a complete encrypted representation exists, which is
 *  the one thing §8 forbids. A *partial* representation (1-4 of the 5 fields — should be
 *  unreachable given the Phase 1 constraint, but never assumed impossible) fails closed the same
 *  way, and also never falls back to plaintext, regardless of whether plaintext happens to still
 *  be present. */
function resolveAccessToken(itemRowId: string, row: EncryptedTokenRow): string {
  const state = classifyEncryptedFields(row);

  if (state === 'partial') {
    throw new PartialEncryptedRepresentationError(itemRowId);
  }

  if (state === 'complete') {
    const enc: EncryptedAccessToken = {
      ciphertextBase64: row.access_token_ciphertext!,
      nonceBase64: row.access_token_nonce!,
      authTagBase64: row.access_token_auth_tag!,
      keyId: row.access_token_key_id!,
      // Non-null is guaranteed by `state === 'complete'` — no `?? 1` coercion. A null version
      // alongside four populated fields is a `partial` state, caught above, before this line.
      encVersion: row.access_token_enc_version!,
    };
    return decryptAccessToken(enc, getKeyRing(), itemRowId);
  }

  // state === 'none': legacy plaintext-only fallback, explicit and intentional (§27) — this is
  // the *only* branch that ever returns plaintext, and only when zero encrypted fields exist.
  if (row.access_token === null) {
    throw new MissingEncryptedRepresentationError(itemRowId);
  }
  return row.access_token;
}

export async function insertPlaidItem(params: {
  userId: string;
  itemId: string;
  accessToken: string;
  institutionId: string | null;
  institutionName: string | null;
}): Promise<PlaidItemRow> {
  // The AAD binds ciphertext to this row's own id (design doc §4), but `id` is normally generated
  // by the database's own `gen_random_uuid()` default at insert time, so it isn't known yet when
  // encryption needs to happen. Generating it here instead and passing it explicitly lets
  // encryption and row creation happen atomically in one insert, rather than needing a separate
  // encrypt-then-update step after the row already exists.
  const id = randomUUID();
  const enc = encryptAccessToken(params.accessToken, getKeyRing(), id);

  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .insert({
      id,
      user_id: params.userId,
      plaid_item_id: params.itemId,
      // Phase 2b (encrypted-only writes, design doc §27): plaintext is deliberately never sent
      // for a new row — the `access_token` key is omitted here entirely, not set to `null`, so
      // there is no plaintext value anywhere in this insert payload to leak, log, or serialize.
      // The database's own default for the now-nullable column (Phase 1) is what actually leaves
      // it null; this insert simply never supplies a value for it. Existing rows created under
      // the earlier Phase 2a dual-write are untouched — this only changes what *new* rows get.
      access_token_ciphertext: enc.ciphertextBase64,
      access_token_nonce: enc.nonceBase64,
      access_token_auth_tag: enc.authTagBase64,
      access_token_key_id: enc.keyId,
      access_token_enc_version: enc.encVersion,
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
): Promise<ResolvedPlaidItem<'id' | 'user_id' | 'transactions_cursor'>[]> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .select(`id, user_id, ${ENCRYPTED_TOKEN_COLUMNS}, transactions_cursor`)
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to load Plaid items: ${error.message}`);

  // access_token is a *lazy*, memoized getter here rather than resolved eagerly — this function
  // returns every one of a user's items in a single batch call, and both of its callers
  // (refreshAccounts, syncTransactions) loop over the result with a per-item try/catch that's
  // meant to isolate one item's failure from the rest (the same way an existing re-auth error on
  // one item today doesn't abort refreshing everyone else's). Resolving every token eagerly, up
  // front, would mean one undecryptable row throws before that per-item loop even starts,
  // silently defeating that isolation for every item in the batch. Deferring the decrypt to the
  // first read of `.access_token` keeps a bad item's failure scoped to whichever loop iteration
  // actually touches it — exactly where the existing per-item catch already lives.
  return (data as (EncryptedTokenRow & { id: string; user_id: string; transactions_cursor: string | null })[]).map(
    (row) => {
      let cached: string | undefined;
      return {
        id: row.id,
        user_id: row.user_id,
        get access_token(): string {
          if (cached === undefined) cached = resolveAccessToken(row.id, row);
          return cached;
        },
        transactions_cursor: row.transactions_cursor,
      };
    }
  );
}

export async function updateItemCursor(itemRowId: string, cursor: string) {
  const { error } = await supabaseAdmin
    .from('plaid_items')
    .update({ transactions_cursor: cursor })
    .eq('id', itemRowId);

  if (error) throw new Error(`Failed to update sync cursor: ${error.message}`);
}

export async function setItemStatus(
  itemRowId: string,
  status: 'active' | 'login_required' | 'credential_error'
) {
  const { error } = await supabaseAdmin.from('plaid_items').update({ status }).eq('id', itemRowId);
  if (error) throw new Error(`Failed to update item status: ${error.message}`);
}

/** Looks up an item by Plaid's own item_id, which is what webhook payloads identify items by. */
export async function getPlaidItemByPlaidItemId(
  plaidItemId: string
): Promise<ResolvedPlaidItem<'id' | 'user_id' | 'transactions_cursor'> | null> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .select(`id, user_id, ${ENCRYPTED_TOKEN_COLUMNS}, transactions_cursor`)
    .eq('plaid_item_id', plaidItemId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load Plaid item: ${error.message}`);
  if (!data) return null;
  const row = data as EncryptedTokenRow & { id: string; user_id: string; transactions_cursor: string | null };
  return {
    id: row.id,
    user_id: row.user_id,
    access_token: resolveAccessToken(row.id, row),
    transactions_cursor: row.transactions_cursor,
  };
}

export async function getPlaidItemForUser(
  itemId: string,
  userId: string
): Promise<ResolvedPlaidItem<'id' | 'status'> | null> {
  const { data, error } = await supabaseAdmin
    .from('plaid_items')
    .select(`id, ${ENCRYPTED_TOKEN_COLUMNS}, status`)
    .eq('id', itemId)
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load Plaid item: ${error.message}`);
  if (!data) return null;
  const row = data as EncryptedTokenRow & { id: string; status: string };
  return {
    id: row.id,
    access_token: resolveAccessToken(row.id, row),
    status: row.status,
  };
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
  sinceDate: string,
  /** Exclusive upper bound (YYYY-MM-DD) — omitted for an open-ended range through today, used by
   *  the reporting-range presets that deliberately include the current in-progress period. */
  untilDate?: string
): Promise<{ date: string; net_worth: number; total_assets: number; total_liabilities: number }[]> {
  let query = supabaseAdmin
    .from('net_worth_snapshots')
    .select('date, net_worth, total_assets, total_liabilities')
    .eq('user_id', userId)
    .gte('date', sinceDate);
  if (untilDate) query = query.lt('date', untilDate);

  const { data, error } = await query.order('date', { ascending: true });

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
    // Financial Semantics Foundation Phase A: Plaid already sends these two fields on every
    // transaction — .detailed is what actually distinguishes a credit-card payment from a car
    // payment from an account transfer (the coarser .primary above can't), and .confidence_level
    // is what the classifier gates on before trusting .detailed. Both were previously discarded;
    // no new Plaid API call is involved in persisting them now. See transactionClassifier.ts.
    personal_finance_category_detailed: transaction.personal_finance_category?.detailed ?? null,
    personal_finance_category_confidence: transaction.personal_finance_category?.confidence_level ?? null,
    plaid_category: transaction.category ? transaction.category.join(' > ') : null,
    pending: transaction.pending,
  };
}

interface ExistingTransactionForClassification {
  id: string;
  plaid_transaction_id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name: string | null;
  category: string | null;
  personal_finance_category_detailed: string | null;
  personal_finance_category_confidence: string | null;
  manual_loan_id: string | null;
  auto_role: string | null;
  principal_portion: number | null;
}

/** auto_role/role_source/role_confidence/classifier_version for a row-level classification —
 *  Financial Semantics Foundation Phase A (see transactionClassifier.ts). Named distinctly from
 *  the DB's snake_case columns so call sites can spread this directly into an insert/update
 *  payload. */
function roleFieldsFor(classification: ReturnType<typeof classifyRowLevel>) {
  return {
    auto_role: classification.autoRole,
    role_source: classification.roleSource,
    role_confidence: classification.roleConfidence,
    classifier_version: classification.classifierVersion,
  };
}

/**
 * The complete set of inputs the classifier's OUTPUT can actually depend on (Round 2 remediation
 * §3) — not just category/detailed/confidence. Amount/sign, account, date, and merchant/name all
 * matter too: a sign flip changes expense-vs-income entirely, a date moving outside a transfer
 * window can invalidate a previously-valid match, an account change moves which counterpart pool
 * applies, and a merchant/name change can break a refund match that depended on it. Comparing only
 * category fields (an earlier version of this function) would silently miss all of these.
 */
/**
 * The exact state a row was classified against, echoed back to `apply_synced_transaction_batch` so
 * it can compare-and-swap against the CURRENT locked row before writing anything (Round 10
 * remediation).
 *
 * `applyTransactionChanges` reads each existing row, then decides IN TYPESCRIPT — outside any
 * database lock — whether to reclassify it and whether its stored `principal_portion` is still
 * compatible with the incoming amount. The advisory lock the RPC takes serializes the writes, but
 * it cannot retroactively protect that earlier read: between the read and the lock, another request
 * can link the row to a manual loan, and the batch would then overwrite it using decisions made
 * against a row state that no longer exists. Every field below is one the decision actually read,
 * so a mismatch on any of them means the decision is stale and the batch must be rejected whole.
 */
interface ExpectedTransactionSnapshot {
  exp_account_id: string;
  exp_amount: number;
  exp_date: string;
  exp_name: string;
  exp_merchant_name: string | null;
  exp_category: string | null;
  exp_pfc_detailed: string | null;
  exp_pfc_confidence: string | null;
  exp_manual_loan_id: string | null;
  exp_auto_role: string | null;
  exp_principal_portion: number | null;
}

function expectedSnapshotOf(existing: ExistingTransactionForClassification): ExpectedTransactionSnapshot {
  return {
    exp_account_id: existing.account_id,
    exp_amount: existing.amount,
    exp_date: existing.date,
    exp_name: existing.name,
    exp_merchant_name: existing.merchant_name,
    exp_category: existing.category,
    exp_pfc_detailed: existing.personal_finance_category_detailed,
    exp_pfc_confidence: existing.personal_finance_category_confidence,
    exp_manual_loan_id: existing.manual_loan_id,
    exp_auto_role: existing.auto_role,
    exp_principal_portion: existing.principal_portion,
  };
}

function hasSemanticInputChanged(
  existing: ExistingTransactionForClassification,
  incoming: { account_id: string; amount: number; date: string; name: string; merchant_name: string | null; category: string | null; personal_finance_category_detailed: string | null; personal_finance_category_confidence: string | null }
): boolean {
  return (
    existing.account_id !== incoming.account_id ||
    existing.amount !== incoming.amount ||
    existing.date !== incoming.date ||
    existing.name !== incoming.name ||
    existing.merchant_name !== incoming.merchant_name ||
    existing.category !== incoming.category ||
    existing.personal_finance_category_detailed !== incoming.personal_finance_category_detailed ||
    existing.personal_finance_category_confidence !== incoming.personal_finance_category_confidence
  );
}

/**
 * Applies a batch of Plaid transaction changes (added/modified/removed) against our
 * `transactions` table, and row-level-classifies (Phase A — see transactionClassifier.ts) every
 * inserted/updated row before returning. `accountIdByPlaidId` maps a Plaid account_id to our
 * accounts.id — transactions we can't match to a known account are skipped.
 *
 * Returns `insertedTransactions` (id/name/merchant_name/amount only, for the caller's existing
 * loan-payment matching) and `touchedTransactionIds` (every inserted or updated row's id — the
 * ordinary forward-looking reconciliation pass runs over this whole set). A modified or removed
 * transaction may ALSO invalidate an EXISTING relational row (an `account_pair_match`/
 * `refund_match` row) that depended on this transaction's OLD state or its now-deleted existence
 * — the caller (syncService.ts) is responsible for running roleReconciliation's bounded
 * `repairExistingRelationalRoles` sweep whenever `modified`/`removed` were non-empty, BEFORE
 * advancing its cursor (Round 3 remediation §2/§3/§4/§6 — see that module's own doc comment for
 * why a sweep-based repair replaced the earlier per-row "capture old identity, search for a stale
 * partner" approach).
 *
 * Round 8 remediation (blocker 3, closing the candidate-insertion phantom): the actual INSERT/
 * UPDATE of `transactions` rows below goes through ONE call to `apply_synced_transaction_batch`
 * (see the Phase A migration) rather than plain, unlocked `.insert()`/`.update()` calls —
 * classification (which role a row gets) still happens in TypeScript exactly as before, but the
 * ACT of persisting the decided rows now happens inside the same per-user advisory lock every
 * other semantic-role-affecting write in this codebase uses. This is what makes a newly-synced
 * transaction — a brand-new transfer candidate — unable to become durable in the middle of a
 * concurrent `confirm_transfer_pair`/`apply_transaction_semantic_roles` call for the same user;
 * see that migration function's own doc comment for the real two-process test this was verified
 * against.
 */
export async function applyTransactionChanges(params: {
  userId: string;
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: RemovedTransaction[];
  accountIdByPlaidId: Map<string, string>;
}): Promise<{
  insertedTransactions: InsertedTransaction[];
  touchedTransactionIds: string[];
}> {
  const upsertCandidates = [...params.added, ...params.modified]
    .map((t) => {
      const accountId = params.accountIdByPlaidId.get(t.account_id);
      return accountId ? mapPlaidTransaction(t, accountId) : null;
    })
    .filter((t): t is NonNullable<typeof t> => t !== null);

  let insertedRows: InsertedTransaction[] = [];
  const touchedTransactionIds: string[] = [];

  if (upsertCandidates.length > 0) {
    const plaidIds = upsertCandidates.map((t) => t.plaid_transaction_id);
    const { data: existing, error: fetchError } = await supabaseAdmin
      .from('transactions')
      .select(
        'id, plaid_transaction_id, account_id, amount, date, name, merchant_name, category, personal_finance_category_detailed, personal_finance_category_confidence, manual_loan_id, auto_role, principal_portion'
      )
      .in('plaid_transaction_id', plaidIds);

    if (fetchError) throw new Error(`Failed to load existing transactions: ${fetchError.message}`);

    const existingByPlaidId = new Map(
      (existing as ExistingTransactionForClassification[]).map((t) => [t.plaid_transaction_id, t])
    );

    const toInsert = upsertCandidates.filter((t) => !existingByPlaidId.has(t.plaid_transaction_id));
    const toUpdate = upsertCandidates.filter((t) => existingByPlaidId.has(t.plaid_transaction_id));

    let rowsToInsert: (ReturnType<typeof mapPlaidTransaction> & {
      needs_review: boolean;
      budget_category_id: string | null;
    } & ReturnType<typeof roleFieldsFor>)[] = [];

    if (toInsert.length > 0) {
      // needs_review and budget_category_id (via any matching category mapping) only apply at
      // insert time — added here rather than in mapPlaidTransaction so a later "modified" update
      // (which reuses the same mapped row) never resets an already-reviewed or already-categorized
      // transaction.
      const mappings = await listCategoryMappings(params.userId);
      const budgetCategoryIdByPlaidCategory = new Map(
        mappings.map((m) => [m.plaid_category, m.budget_category_id])
      );
      rowsToInsert = toInsert.map((t) => {
        // A brand-new row is never already linked to a manual loan (that only ever happens via
        // an explicit later mutation — linkTransactionToLoan — which sets its own role fields),
        // so step A of the classifier never applies here.
        const classification = classifyRowLevel({
          amount: t.amount,
          personalFinanceCategoryPrimary: t.category,
          personalFinanceCategoryDetailed: t.personal_finance_category_detailed,
          personalFinanceCategoryConfidence: t.personal_finance_category_confidence,
          manualLoanId: null,
        });
        return {
          ...t,
          needs_review: true,
          budget_category_id: t.category ? budgetCategoryIdByPlaidCategory.get(t.category) ?? null : null,
          ...roleFieldsFor(classification),
        };
      });
    }

    const rowsToUpdate: ({ id: string } & Omit<ReturnType<typeof mapPlaidTransaction>, 'plaid_transaction_id'> & {
      auto_role: string | null;
      role_source: string | null;
      role_confidence: string | null;
      classifier_version: number | null;
    } & ExpectedTransactionSnapshot)[] = [];

    for (const row of toUpdate) {
      const existingRow = existingByPlaidId.get(row.plaid_transaction_id)!;
      const id = existingRow.id;
      const { plaid_transaction_id: _ignored, ...fields } = row;

      // Principal integrity during Plaid resync (Round 3 remediation §8): a manual-loan-linked
      // transaction's amount can change on resync (Plaid correcting a pending amount, a merchant
      // adjustment, etc.) — if the ALREADY-STORED principal_portion is no longer compatible with
      // the new amount, this must fail the whole sync batch BEFORE persisting the incompatible
      // amount and BEFORE the cursor advances, rather than silently letting principal > amount
      // persist or corrupting loan-balance math. This is deliberately NOT caught here — it
      // propagates out of this function (and out of syncService.ts, uncaught), leaving the
      // cursor unadvanced so the next sync attempt re-delivers this same batch once the user has
      // edited or unlinked the payment.
      if (existingRow.manual_loan_id !== null) {
        assertLinkedPaymentAmountIsCompatible(row.amount, existingRow.principal_portion);
      }

      // auto_role lifecycle (Phase A contract §5, Round 2 remediation §3): an ordinary resync
      // with unchanged semantic inputs must not churn the role fields at all — only reclassify
      // when a semantic input actually changed (see hasSemanticInputChanged — amount/account/
      // date/merchant/name, not just category), or this row was never classified yet, and never
      // when a manual-loan link already governs this row's role regardless of category.
      let roleFields: Partial<ReturnType<typeof roleFieldsFor>> = {};
      if (existingRow.manual_loan_id === null) {
        const semanticInputChanged = hasSemanticInputChanged(existingRow, row);
        if (semanticInputChanged || existingRow.auto_role === null) {
          const classification = classifyRowLevel({
            amount: row.amount,
            personalFinanceCategoryPrimary: row.category,
            personalFinanceCategoryDetailed: row.personal_finance_category_detailed,
            personalFinanceCategoryConfidence: row.personal_finance_category_confidence,
            manualLoanId: null,
          });
          roleFields = roleFieldsFor(classification);
        }
      }

      // A role field left out of roleFields (unchanged) is sent as an explicit JSON null, which
      // apply_synced_transaction_batch's UPDATE COALESCEs against the row's current DB value —
      // never overwriting it — exactly mirroring the Phase A "unchanged semantic inputs never
      // churn role fields" contract.
      rowsToUpdate.push({
        id,
        ...fields,
        auto_role: roleFields.auto_role ?? null,
        role_source: roleFields.role_source ?? null,
        role_confidence: roleFields.role_confidence ?? null,
        classifier_version: roleFields.classifier_version ?? null,
        ...expectedSnapshotOf(existingRow),
      });
      touchedTransactionIds.push(id);
    }

    if (rowsToInsert.length > 0 || rowsToUpdate.length > 0) {
      const { data: batchResult, error: batchError } = await supabaseAdmin.rpc('apply_synced_transaction_batch', {
        p_user_id: params.userId,
        p_inserts: rowsToInsert,
        p_updates: rowsToUpdate,
      });
      if (batchError) throw new Error(`Failed to apply synced transaction batch: ${batchError.message}`);
      insertedRows = (batchResult ?? []) as InsertedTransaction[];
      touchedTransactionIds.push(...insertedRows.map((r) => r.id));
    }
  }

  if (params.removed.length > 0) {
    const removedIds = params.removed.map((t) => t.transaction_id);
    // Round 6 remediation (blocker 4's Plaid-removal gap): a removed transaction that was linked
    // to a manual loan (e.g. a pending row Plaid replaces with its posted counterpart) must have
    // its principal restored to the loan's balance as part of the SAME atomic operation as the
    // delete — a plain DELETE here would silently overstate how much principal had been paid
    // down, permanently. See delete_transactions_and_restore_loan_balances in the Phase A
    // migration; it is a no-op balance-wise for any removed row that wasn't loan-linked.
    const { error } = await supabaseAdmin.rpc('delete_transactions_and_restore_loan_balances', {
      p_user_id: params.userId,
      p_plaid_transaction_ids: removedIds,
    });

    if (error) throw new Error(`Failed to delete removed transactions: ${error.message}`);
  }

  return { insertedTransactions: insertedRows, touchedTransactionIds };
}

/** `start`/`end` are both inclusive (YYYY-MM-DD) — matches TransactionsFeed's existing client-side
 *  dateFrom/dateTo filter convention, unlike the exclusive `untilDate` used by the reporting-range
 *  endpoints elsewhere. Optional and additive: omitted, this behaves exactly as before (the most
 *  recent `limit` transactions) — Date-Range Customization v1 deliberately does not wire any UI to
 *  these yet (the main Transactions feed stays independent of the global reporting range), this
 *  just gives a future drill-down or date-picker a real server-side range to query instead of
 *  filtering an already-fetched, limit-capped array. */
export async function getRecentTransactionsForUser(
  userId: string,
  limit: number,
  start?: string,
  end?: string
) {
  let query = supabaseAdmin
    .from('transactions')
    .select(
      'id, amount, iso_currency_code, date, name, merchant_name, category, plaid_category, pending, budget_category_id, needs_review, accounts!inner(name, nickname, plaid_items!inner(user_id, institution_name)), splits:transaction_splits(id, budget_category_id, amount, note)'
    )
    .eq('accounts.plaid_items.user_id', userId);
  if (start) query = query.gte('date', start);
  if (end) query = query.lte('date', end);

  const { data, error } = await query.order('date', { ascending: false }).limit(limit);

  if (error) throw new Error(`Failed to load transactions: ${error.message}`);
  return data;
}

/** Excludes transactions on an account flagged exclude_from_cash_flow — feeds Monthly
 *  Spending/Cash Flow Pace/Savings Rate, all personal cash-flow aggregates. The individual
 *  transactions still appear in the main feed (getRecentTransactionsForUser), which deliberately
 *  has no such filter. */
export async function getTransactionsSince(
  userId: string,
  sinceDate: string,
  /** Exclusive upper bound (YYYY-MM-DD) — omitted for an open-ended range through today, used by
   *  the reporting-range presets that deliberately include the current in-progress period. */
  untilDate?: string
): Promise<{ amount: number; date: string }[]> {
  let query = supabaseAdmin
    .from('transactions')
    .select('amount, date, accounts!inner(exclude_from_cash_flow, plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
    .eq('accounts.exclude_from_cash_flow', false)
    .gte('date', sinceDate);
  if (untilDate) query = query.lt('date', untilDate);

  const { data, error } = await query.order('date', { ascending: true });

  if (error) throw new Error(`Failed to load transaction history: ${error.message}`);
  return data;
}

/** Like getTransactionsSince, but also includes Plaid's own category — for the monthly
 *  breakdown view, which groups by Plaid's taxonomy rather than the user's budget categories
 *  (Plaid categorizes essentially every transaction; budget categories are optional/sparse). */
export async function getCategorizedTransactionsSince(
  userId: string,
  sinceDate: string,
  untilDate?: string
): Promise<{ amount: number; date: string; category: string | null }[]> {
  let query = supabaseAdmin
    .from('transactions')
    .select('amount, date, category, accounts!inner(exclude_from_cash_flow, plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
    .eq('accounts.exclude_from_cash_flow', false)
    .gte('date', sinceDate);
  if (untilDate) query = query.lt('date', untilDate);

  const { data, error } = await query.order('date', { ascending: true });

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

/** Not-yet-linked transactions matching a specific set of Plaid transaction ids (Round 6
 *  remediation, blocker 5) — used by loans.ts's `linkNewTransactionsToManualLoans` to re-derive
 *  auto-link candidates from Plaid's OWN `added` report on every sync attempt, rather than from
 *  `applyTransactionChanges`'s own insert/update classification (which changes between a first
 *  attempt and a retry: a row inserted in attempt 1 is no longer "new" in attempt 2, so relying on
 *  that as the candidate set would mean a link that failed in attempt 1 is never retried). Plaid
 *  redelivers the identical `added` composition on every retry for an unadvanced cursor, so this
 *  query — scoped to exactly those plaid ids, filtered to still-unlinked — naturally retries a
 *  failed link and is a no-op for one that already succeeded. */
export async function getUnlinkedTransactionsByPlaidIds(
  userId: string,
  plaidTransactionIds: string[]
): Promise<InsertedTransaction[]> {
  if (plaidTransactionIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select('id, name, merchant_name, amount, plaid_transaction_id, accounts!inner(plaid_items!inner(user_id))')
    .eq('accounts.plaid_items.user_id', userId)
    .in('plaid_transaction_id', plaidTransactionIds)
    .is('manual_loan_id', null)
    .gt('amount', 0);

  if (error) throw new Error(`Failed to load unlinked transactions by plaid id: ${error.message}`);
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

/** Excludes loans whose account is flagged exclude_from_cash_flow — a loan's minimum payment is
 *  a cash-flow obligation (it feeds Upcoming Bills / Safe to Spend), same reasoning as
 *  getRecurringStreamsForUser. account_id is nullable on this table, so the accounts relation is
 *  a left embed (not `!inner`) filtered in application code rather than the query itself — an
 *  inner join/filter here would silently drop any loan with no account_id, which isn't what
 *  exclusion means. */
export async function getLoansForUser(userId: string): Promise<LoanWithAccount[]> {
  const { data, error } = await supabaseAdmin
    .from('loans')
    .select(
      'id, item_id, account_id, plaid_account_id, loan_type, name, interest_rate_percentage, origination_principal_amount, origination_date, minimum_payment_amount, next_payment_due_date, last_payment_amount, last_payment_date, is_overdue, plaid_items!inner(user_id), accounts(name, current_balance, iso_currency_code, exclude_from_cash_flow)'
    )
    .eq('plaid_items.user_id', userId);

  if (error) throw new Error(`Failed to load loans: ${error.message}`);

  return (
    data as unknown as (LoanRow & {
      accounts: {
        name: string;
        current_balance: number | null;
        iso_currency_code: string | null;
        exclude_from_cash_flow: boolean;
      } | null;
    })[]
  )
    .filter((row) => !row.accounts?.exclude_from_cash_flow)
    .map(({ accounts, ...loan }) => ({
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

/** Thrown by `assertValidManualLoanFields` (Round 5 remediation, blocker 7) — a manual loan's
 *  core numeric fields (unlike a linked Plaid transaction, which Plaid itself already validates)
 *  were previously accepted with no runtime check beyond `typeof === 'number'` on create, and NO
 *  check at all on update — silently persisting a negative balance/principal/rate/payment, or a
 *  non-positive term. */
export class InvalidManualLoanFieldError extends Error {}

function assertFiniteNonNegative(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidManualLoanFieldError(`${fieldName} must be a finite, non-negative number (got ${value})`);
  }
}

function assertPositiveInteger(value: number, fieldName: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new InvalidManualLoanFieldError(`${fieldName} must be a positive integer (got ${value})`);
  }
}

/** Validates every core numeric field a manual loan write path could set, before that write ever
 *  reaches the database (Round 5 remediation, blocker 7). Every field is optional here since
 *  `updateManualLoan` sends a partial patch — only fields actually present are checked; a field
 *  explicitly sent as `null` (for the nullable ones) is left alone, matching existing "clear this
 *  field" semantics. `current_balance` is the one always-required, never-null field (both create
 *  and every update path that touches it must supply a real number). */
function assertValidManualLoanFields(fields: {
  current_balance?: number;
  origination_principal_amount?: number | null;
  interest_rate_percentage?: number | null;
  minimum_payment_amount?: number | null;
  term_months?: number | null;
}): void {
  if (fields.current_balance !== undefined) assertFiniteNonNegative(fields.current_balance, 'current_balance');
  if (fields.origination_principal_amount !== undefined && fields.origination_principal_amount !== null) {
    assertFiniteNonNegative(fields.origination_principal_amount, 'origination_principal_amount');
  }
  if (fields.interest_rate_percentage !== undefined && fields.interest_rate_percentage !== null) {
    assertFiniteNonNegative(fields.interest_rate_percentage, 'interest_rate_percentage');
  }
  if (fields.minimum_payment_amount !== undefined && fields.minimum_payment_amount !== null) {
    assertFiniteNonNegative(fields.minimum_payment_amount, 'minimum_payment_amount');
  }
  if (fields.term_months !== undefined && fields.term_months !== null) {
    assertPositiveInteger(fields.term_months, 'term_months');
  }
}

/** Thrown by `createManualLoan` for any failure the idempotent-create RPC reports. */
export class ManualLoanCreationError extends Error {}

/**
 * `createManualLoan` is invoked synchronously by `manualLoanController.ts`'s create handler,
 * which ALSO runs `backfillMatchesForLoan` immediately afterward and (per Round 5) no longer
 * swallows that step's failure — meaning a loan can persist successfully while the overall
 * request still reports failure. A client that resends the identical "create loan" request in
 * that situation must not insert a second, duplicate loan row, while any transactions the first
 * attempt's backfill already linked stay attached to the first (now orphaned from the client's
 * point of view) row.
 *
 * Round 8 remediation: replaces an earlier time-window/exact-field-match heuristic (which could
 * neither survive a delayed retry past its window nor tell a genuine duplicate loan apart from a
 * retry) with a real client-supplied idempotency key, enforced by a database UNIQUE constraint —
 * see `create_manual_loan_idempotent` and `manual_loan_creation_requests` in the Phase A
 * migration. The whole "does a loan for this key already exist, and if not, create one" sequence
 * runs inside that single locked function call, so two concurrent requests carrying the SAME key
 * can never both insert — the second always replays the first's result. A DIFFERENT key always
 * creates a genuinely new loan, no matter how similar its fields are to an existing one, and a
 * retry replays correctly no matter how much later it arrives — neither of which the old
 * heuristic could guarantee.
 */
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
  },
  idempotencyKey: string
): Promise<ManualLoanRow> {
  if (!idempotencyKey || idempotencyKey.trim() === '') {
    throw new ManualLoanCreationError('idempotencyKey is required');
  }

  assertValidManualLoanFields({
    current_balance: params.currentBalance,
    origination_principal_amount: params.originationPrincipalAmount,
    interest_rate_percentage: params.interestRatePercentage,
    minimum_payment_amount: params.minimumPaymentAmount,
    term_months: params.termMonths,
  });

  const { data: loanId, error: rpcError } = await supabaseAdmin.rpc('create_manual_loan_idempotent', {
    p_user_id: userId,
    p_idempotency_key: idempotencyKey,
    p_name: params.name,
    p_loan_type: params.loanType,
    p_current_balance: params.currentBalance,
    p_origination_principal_amount: params.originationPrincipalAmount,
    p_interest_rate_percentage: params.interestRatePercentage,
    p_origination_date: params.originationDate,
    p_term_months: params.termMonths,
    p_minimum_payment_amount: params.minimumPaymentAmount,
    p_next_payment_due_date: params.nextPaymentDueDate,
    p_notes: params.notes,
    p_match_text: params.matchText,
  });
  if (rpcError) throw new ManualLoanCreationError(`Failed to create manual loan: ${rpcError.message}`);

  const { data, error } = await supabaseAdmin.from('manual_loans').select('*').eq('id', loanId as string).single();
  if (error) throw new Error(`Failed to load created manual loan: ${error.message}`);
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
  assertValidManualLoanFields(fields);

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

export class ManualLoanNotFoundError extends Error {}

/** How many times a loan deletion re-reads and retries when a concurrent link/unlink changes the
 *  linked set underneath it. Each attempt only loses to an actual competing writer, so a small
 *  bound is enough to absorb realistic contention while still failing loudly if something is
 *  persistently racing us rather than retrying forever. */
const DELETE_MANUAL_LOAN_MAX_ATTEMPTS = 3;

/**
 * Deletes a manual loan and reclassifies every transaction still linked to it, atomically (Round 10
 * remediation, replacing the Round 5/9 design).
 *
 * The `transactions.manual_loan_id` foreign key is `ON DELETE SET NULL`, so deleting the loan row
 * alone would clear `manual_loan_id` but leave `principal_portion` and the
 * `debt_payment`/`manual_loan_link` role fields stale — rows claiming to be payments on a loan that
 * no longer exists. Reclassification therefore has to happen as part of the deletion, not near it.
 *
 * Until Round 10 this ran as an unlocked read of the linked rows, then one independent unlink RPC
 * per transaction, then a separate direct delete — so a concurrent link could slip in after the
 * read, any single unlink could fail leaving the deletion half-done, and a failure after the
 * unlinks committed lost the affected ids entirely. `delete_manual_loan_atomic` now does all of it
 * in one locked transaction (see that function's own comment for the full failure inventory).
 *
 * Classification stays here in TypeScript because transactionClassifier.ts is its single source of
 * truth. The trade-off is that rows are classified from an unlocked read, so the RPC verifies under
 * its lock that the linked set is still EXACTLY what was classified and rejects the call otherwise;
 * this function absorbs that rejection by re-reading and retrying.
 *
 * Returns the affected transaction ids and whether this was a replay of an already-committed
 * deletion. The caller (manualLoanController.ts) owns the post-commit relational work: forward
 * reconciliation for each affected row plus the repair sweep, then marking the deletion reconciled.
 * That split is deliberate — reconciliation cannot run inside the deleting transaction, so the
 * tombstone the RPC writes is what makes a failure in that step retryable rather than lost.
 */
export async function deleteManualLoan(
  id: string,
  userId: string
): Promise<{ affectedTransactionIds: string[]; replayed: boolean; alreadyReconciled: boolean }> {
  for (let attempt = 1; attempt <= DELETE_MANUAL_LOAN_MAX_ATTEMPTS; attempt++) {
    const { data: linkedRows, error: fetchError } = await supabaseAdmin
      .from('transactions')
      .select('id, amount, category, personal_finance_category_detailed, personal_finance_category_confidence')
      .eq('manual_loan_id', id);
    if (fetchError) throw new Error(`Failed to load transactions linked to manual loan: ${fetchError.message}`);

    const reclassify = ((linkedRows ?? []) as {
      id: string;
      amount: number;
      category: string | null;
      personal_finance_category_detailed: string | null;
      personal_finance_category_confidence: string | null;
    }[]).map((txn) => {
      const classification = classifyRowLevel({
        amount: txn.amount,
        personalFinanceCategoryPrimary: txn.category,
        personalFinanceCategoryDetailed: txn.personal_finance_category_detailed,
        personalFinanceCategoryConfidence: txn.personal_finance_category_confidence,
        manualLoanId: null,
      });
      return {
        id: txn.id,
        auto_role: classification.autoRole,
        role_source: classification.roleSource,
        role_confidence: classification.roleConfidence,
        classifier_version: classification.classifierVersion,
      };
    });

    const { data, error } = await supabaseAdmin.rpc('delete_manual_loan_atomic', {
      p_user_id: userId,
      p_loan_id: id,
      p_reclassify: reclassify,
    });

    if (!error) {
      const result = data as {
        replayed: boolean;
        already_reconciled: boolean;
        affected_transaction_ids: string[] | null;
      };
      return {
        affectedTransactionIds: result.affected_transaction_ids ?? [],
        replayed: result.replayed,
        alreadyReconciled: result.already_reconciled,
      };
    }

    if (error.message.includes('manual loan not found')) {
      throw new ManualLoanNotFoundError('Manual loan not found');
    }
    // Only a genuinely concurrent link/unlink produces this, and only the read is stale — so
    // re-reading and re-classifying is the whole fix. Anything else is a real failure.
    if (!error.message.includes('changed since they were classified') || attempt === DELETE_MANUAL_LOAN_MAX_ATTEMPTS) {
      throw new Error(`Failed to delete manual loan: ${error.message}`);
    }
  }

  throw new Error('Failed to delete manual loan: exhausted retries');
}

/** Records that the post-commit reconciliation for an already-deleted loan finished. Until this
 *  lands, a retried DELETE replays the same affected ids and reruns that reconciliation. */
export async function markManualLoanDeletionReconciled(loanId: string, userId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('mark_manual_loan_deletion_reconciled', {
    p_user_id: userId,
    p_loan_id: loanId,
  });
  if (error) throw new Error(`Failed to mark manual loan deletion reconciled: ${error.message}`);
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

/** Links a transaction to a manual loan and decrements the loan's balance by principalPortion
 *  (the part of the payment that reduces principal, as opposed to interest), atomically (Round 6
 *  remediation, blocker 4) — delegates to `link_transaction_to_manual_loan` (see the Phase A
 *  migration), which performs the transaction update and the balance adjustment inside one
 *  Postgres transaction, so the two can never durably split (a failure partway through a
 *  two-request version could leave a link with no matching balance decrement, or vice versa).
 *  Also sets this transaction's semantic role to debt_payment (manual_loan_link, high confidence)
 *  — precedence step A always wins regardless of the transaction's own Plaid category once a
 *  manual-loan link exists (see transactionClassifier.ts). This never touches
 *  user_role_override. */
export async function linkTransactionToLoan(
  userId: string,
  transactionId: string,
  loanId: string,
  principalPortion: number
): Promise<void> {
  // WRITE-boundary validation (Round 2 remediation §7) — first fetch the transaction's own amount
  // so an impossible principal (negative, or exceeding the payment itself) is rejected outright
  // rather than ever persisted. The RPC re-validates this bound itself too (defense in depth,
  // since it's the one place that can actually refuse to write bad data atomically), but failing
  // fast here avoids a round trip for the common case.
  const { data: txnRow, error: txnFetchError } = await supabaseAdmin
    .from('transactions')
    .select('amount')
    .eq('id', transactionId)
    .maybeSingle();
  if (txnFetchError) throw new Error(`Failed to load transaction: ${txnFetchError.message}`);
  if (!txnRow) throw new Error('Transaction not found');
  const normalizedPrincipal = normalizePrincipalPortion(txnRow.amount as number, principalPortion);

  const { error } = await supabaseAdmin.rpc('link_transaction_to_manual_loan', {
    p_user_id: userId,
    p_transaction_id: transactionId,
    p_loan_id: loanId,
    p_principal_portion: normalizedPrincipal,
    p_classifier_version: CURRENT_CLASSIFIER_VERSION,
  });
  if (error) throw new Error(`Failed to link transaction to loan: ${error.message}`);
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
 *  balance by the difference in the SAME atomic operation (Round 6 remediation, blocker 4) — see
 *  `update_linked_payment_principal` in the Phase A migration. */
export async function updateLinkedPaymentPrincipal(
  userId: string,
  transactionId: string,
  loanId: string,
  newPrincipalPortion: number
): Promise<void> {
  const { data: txn, error: fetchError } = await supabaseAdmin
    .from('transactions')
    .select('manual_loan_id, amount')
    .eq('id', transactionId)
    .maybeSingle();

  if (fetchError) throw new Error(`Failed to load payment: ${fetchError.message}`);
  if (!txn || txn.manual_loan_id !== loanId) throw new Error('Payment is not linked to this loan');

  // WRITE-boundary validation (Round 2 remediation §7) — same rule as linkTransactionToLoan; the
  // RPC re-validates this bound again itself (defense in depth).
  const normalizedPrincipal = normalizePrincipalPortion(txn.amount as number, newPrincipalPortion);

  const { error } = await supabaseAdmin.rpc('update_linked_payment_principal', {
    p_user_id: userId,
    p_transaction_id: transactionId,
    p_loan_id: loanId,
    p_new_principal_portion: normalizedPrincipal,
  });
  if (error) throw new Error(`Failed to update payment: ${error.message}`);
}

/** Reverses a payment link — restores the loan's balance by the portion that had been applied
 *  and clears the link atomically (Round 6 remediation, blocker 4), e.g. to correct a
 *  false-positive text match. See `unlink_transaction_from_manual_loan` in the Phase A migration.
 *
 *  Round 4 remediation §7: returns `true` if this call performed the actual unlink, or `false`
 *  if the transaction was ALREADY unlinked (from this or a different loan) — an idempotent
 *  no-op, not an error. This matters for retry safety: if a PRIOR call already persisted the
 *  unlink but the caller's subsequent semantic-repair step then failed (see
 *  manualLoanController.ts's `unlinkPayment`), a retry of the same request must be able to reach
 *  the repair step again rather than failing here on a stale "still linked" precondition — the
 *  request identifies the same transaction/loan relationship that was just removed, and that is
 *  a completed, not a failed, unlink. Only a genuine mismatch (linked to a DIFFERENT loan than
 *  the one named in the request, or the transaction not existing at all) is a real error. */
export async function unlinkPaymentFromLoan(userId: string, transactionId: string, loanId: string): Promise<boolean> {
  const { data: txn, error: fetchError } = await supabaseAdmin
    .from('transactions')
    .select('manual_loan_id, amount, category, personal_finance_category_detailed, personal_finance_category_confidence')
    .eq('id', transactionId)
    .maybeSingle();

  if (fetchError) throw new Error(`Failed to load payment: ${fetchError.message}`);
  if (!txn) throw new Error('Payment not found');
  if (txn.manual_loan_id === null) return false; // already unlinked — idempotent no-op, no RPC call needed
  if (txn.manual_loan_id !== loanId) throw new Error('Payment is not linked to this loan');

  // manual_loan_link no longer governs this row's role once unlinked — reclassify via the normal
  // (non-loan) precedence immediately. If this lands on a relational candidate (an ambiguous
  // transfer/refund shape), it gets the same safe sign-based fallback any other row would; unlike
  // a sync batch, an unlink isn't followed by a reconciliation pass here (a later sync touching
  // this row, or an explicit backfill run, can still upgrade it — see roleReconciliation.ts).
  const classification = classifyRowLevel({
    amount: txn.amount as number,
    personalFinanceCategoryPrimary: txn.category as string | null,
    personalFinanceCategoryDetailed: txn.personal_finance_category_detailed as string | null,
    personalFinanceCategoryConfidence: txn.personal_finance_category_confidence as string | null,
    manualLoanId: null,
  });

  const { data, error } = await supabaseAdmin.rpc('unlink_transaction_from_manual_loan', {
    p_user_id: userId,
    p_transaction_id: transactionId,
    p_loan_id: loanId,
    p_auto_role: classification.autoRole,
    p_role_source: classification.roleSource,
    p_role_confidence: classification.roleConfidence,
    p_classifier_version: classification.classifierVersion,
  });
  if (error) throw new Error(`Failed to unlink payment: ${error.message}`);
  return data as boolean;
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
  // WRITE-boundary validation (Round 4 remediation §9) — BEFORE the insert and BEFORE any loan
  // balance adjustment, so an invalid value can never partially persist or corrupt
  // manual_loans.current_balance. A manual payment has no `amount` column to bound principal
  // against (see normalizeNonNegativeMoneyAmount's own doc comment) — both portions are
  // independently required to be finite and non-negative.
  const normalizedPrincipal = normalizeNonNegativeMoneyAmount(params.principalPortion, 'principal_portion');
  const normalizedInterest = normalizeNonNegativeMoneyAmount(params.interestPortion, 'interest_portion');

  // Insert + balance decrement happen atomically (Round 6 remediation, blocker 4) — see
  // `create_manual_loan_payment` in the Phase A migration.
  const { data: paymentId, error } = await supabaseAdmin.rpc('create_manual_loan_payment', {
    p_user_id: userId,
    p_loan_id: loanId,
    p_date: params.date,
    p_principal_portion: normalizedPrincipal,
    p_interest_portion: normalizedInterest,
    p_notes: params.notes,
  });
  if (error) throw new Error(`Failed to create manual payment: ${error.message}`);

  const { data, error: refetchError } = await supabaseAdmin
    .from('manual_loan_payments')
    .select()
    .eq('id', paymentId as string)
    .single();
  if (refetchError) throw new Error(`Failed to load created manual payment: ${refetchError.message}`);
  return data as ManualLoanPaymentRow;
}

export async function updateManualLoanPayment(
  userId: string,
  id: string,
  loanId: string,
  fields: Partial<{ date: string; principal_portion: number; interest_portion: number; notes: string | null }>
): Promise<ManualLoanPaymentRow | null> {
  // WRITE-boundary validation (Round 4 remediation §9) — validated BEFORE fetching/updating
  // anything, so an invalid value never reaches the DB and never triggers a balance adjustment.
  const normalizedFields = { ...fields };
  if (normalizedFields.principal_portion !== undefined) {
    normalizedFields.principal_portion = normalizeNonNegativeMoneyAmount(normalizedFields.principal_portion, 'principal_portion');
  }
  if (normalizedFields.interest_portion !== undefined) {
    normalizedFields.interest_portion = normalizeNonNegativeMoneyAmount(normalizedFields.interest_portion, 'interest_portion');
  }

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from('manual_loan_payments')
    .select('id')
    .eq('id', id)
    .eq('loan_id', loanId)
    .maybeSingle();

  if (fetchError) throw new Error(`Failed to load manual payment: ${fetchError.message}`);
  if (!existing) return null;

  // The patch/update + any balance adjustment happen atomically (Round 6 remediation, blocker 4)
  // — see `update_manual_loan_payment` in the Phase A migration. The p_set_* flags distinguish
  // "not part of this patch" from "explicitly set to null" (notes legitimately accepts null).
  const { error } = await supabaseAdmin.rpc('update_manual_loan_payment', {
    p_user_id: userId,
    p_payment_id: id,
    p_loan_id: loanId,
    p_set_date: normalizedFields.date !== undefined,
    p_date: normalizedFields.date ?? null,
    p_set_principal_portion: normalizedFields.principal_portion !== undefined,
    p_principal_portion: normalizedFields.principal_portion ?? null,
    p_set_interest_portion: normalizedFields.interest_portion !== undefined,
    p_interest_portion: normalizedFields.interest_portion ?? null,
    p_set_notes: normalizedFields.notes !== undefined,
    p_notes: normalizedFields.notes ?? null,
  });
  if (error) throw new Error(`Failed to update manual payment: ${error.message}`);

  const { data, error: refetchError } = await supabaseAdmin
    .from('manual_loan_payments')
    .select()
    .eq('id', id)
    .maybeSingle();
  if (refetchError) throw new Error(`Failed to load updated manual payment: ${refetchError.message}`);
  return data as ManualLoanPaymentRow | null;
}

/** Deletes a manually-logged payment and restores its principal to the loan's balance atomically
 *  (Round 6 remediation, blocker 4) — see `delete_manual_loan_payment` in the Phase A migration,
 *  which is itself idempotent (a no-op if the payment is already gone), matching this function's
 *  pre-existing contract. */
export async function deleteManualLoanPayment(userId: string, id: string, loanId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc('delete_manual_loan_payment', {
    p_user_id: userId,
    p_payment_id: id,
    p_loan_id: loanId,
  });
  if (error) throw new Error(`Failed to delete manual payment: ${error.message}`);
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

/** Upserts just the nav_layout column — same narrow-update reasoning as upsertDashboardLayout.
 *  Validation (array shape, id/visible types) happens at the controller layer; this just persists
 *  whatever it's given. The frontend's NavigationWriteCoordinator (lib/navigationWriteCoordinator.ts)
 *  is what guarantees at most one call to this function is ever in flight per browser tab — this
 *  function itself has no ordering guarantee of its own, same as every other narrow-update function
 *  here. */
export async function upsertNavLayout(
  userId: string,
  navLayout: { tabs: { id: string; visible: boolean }[] }
): Promise<UserPreferencesRow> {
  const { data, error } = await supabaseAdmin
    .from('user_preferences')
    .upsert(
      { user_id: userId, nav_layout: navLayout, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to save navigation layout: ${error.message}`);
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

/** Upserts the Financial Preferences v1 columns plus the Safe to Spend Customization v1 toggles —
 *  same narrow-update reasoning as upsertDashboardLayout/upsertAppearance. Validation/clamping
 *  happens at the controller layer; this just persists whatever it's given. */
export async function upsertFinancialPreferences(
  userId: string,
  prefs: {
    minimumCashBuffer: number;
    upcomingBillsDays: number;
    recentAvgMonths: number;
    savingsRateTarget: number;
    safeToSpendIncludeUpcomingBills: boolean;
    safeToSpendIncludeRemainingBudget: boolean;
  }
): Promise<UserPreferencesRow> {
  const { data, error } = await supabaseAdmin
    .from('user_preferences')
    .upsert(
      {
        user_id: userId,
        minimum_cash_buffer: prefs.minimumCashBuffer,
        upcoming_bills_days: prefs.upcomingBillsDays,
        recent_avg_months: prefs.recentAvgMonths,
        savings_rate_target: prefs.savingsRateTarget,
        safe_to_spend_include_upcoming_bills: prefs.safeToSpendIncludeUpcomingBills,
        safe_to_spend_include_remaining_budget: prefs.safeToSpendIncludeRemainingBudget,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to save financial preferences: ${error.message}`);
  return data as UserPreferencesRow;
}

/** Upserts just reporting_range — same narrow-update reasoning as upsertDashboardLayout/
 *  upsertAppearance. A dedicated endpoint/function rather than folding into
 *  upsertFinancialPreferences: this is a reporting/view filter, not a calculation input, and
 *  keeping it separate avoids conflating the two concepts the way recent_avg_months and
 *  reporting_range could otherwise be mistaken for the same "N months" idea. */
export async function upsertReportingRange(userId: string, reportingRange: string): Promise<UserPreferencesRow> {
  const { data, error } = await supabaseAdmin
    .from('user_preferences')
    .upsert(
      { user_id: userId, reporting_range: reportingRange, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    .select()
    .single();

  if (error) throw new Error(`Failed to save reporting range: ${error.message}`);
  return data as UserPreferencesRow;
}

// ---- Transaction semantic-role reconciliation (Financial Semantics Foundation, Phase A) -------
//
// Everything below backs roleReconciliation.ts's bounded relational reconciliation pass — see
// that module's own doc comment for the full design. Not called from any production request path
// yet in Phase A beyond what's needed to keep the classifier's own output correct; no existing
// financial calculation reads any of it.
//
// Ownership (Round 2 remediation §8): every function below takes `userId` and enforces it via the
// same `accounts!inner(plaid_items!inner(user_id))` join/filter used elsewhere in this file —
// never relies solely on a caller having built a correctly-scoped id list. A wrong-user id is
// never read, matched, or updated by anything here.

export interface ReconciliationRow {
  id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name: string | null;
  category: string | null;
  personal_finance_category_detailed: string | null;
  personal_finance_category_confidence: string | null;
  manual_loan_id: string | null;
  auto_role: string | null;
  role_source: string | null;
  role_confidence: string | null;
  effective_role: string | null;
  /** Round 4 remediation §3: needed to tell a genuinely un-overridden row apart from one whose
   *  effective_role happens to already equal its auto_role — see roleReconciliation.ts's
   *  `isEligibleTransferParticipant`, which must disqualify a row the user has explicitly
   *  overridden away from `internal_transfer` from ever being auto-paired again. */
  user_role_override: string | null;
}

const RECONCILIATION_ROW_COLUMNS =
  'id, account_id, amount, date, name, merchant_name, category, personal_finance_category_detailed, personal_finance_category_confidence, manual_loan_id, auto_role, role_source, role_confidence, effective_role, user_role_override';

type ReconciliationRowWithJoin = ReconciliationRow & { accounts: unknown };

export async function getTransactionsForReconciliation(userId: string, ids: string[]): Promise<ReconciliationRow[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select(`${RECONCILIATION_ROW_COLUMNS}, accounts!inner(plaid_items!inner(user_id))`)
    .eq('accounts.plaid_items.user_id', userId)
    .in('id', ids);
  if (error) throw new Error(`Failed to load transactions for reconciliation: ${error.message}`);
  return (data ?? []) as ReconciliationRowWithJoin[];
}

/** Every credible internal-transfer counterpart candidate for `row`, filtered by an explicit
 *  `roleSourceFilter` — pass `'transfer_like_unconfirmed'` to find a fresh candidate, or
 *  `'account_pair_match'` to re-validate an EXISTING confirmed partner against current data (used
 *  by roleReconciliation.ts's repair sweep — see `repairExistingRelationalRoles`). One reusable,
 *  parameterized query rather than two near-duplicate ones (Round 2 remediation §1).
 *
 *  Deliberately conservative: opposite sign, EXACT matching amount, on a DIFFERENT account owned
 *  by the same user, within the given inclusive date window. Returns every match in the window —
 *  ranking/ambiguity-detection is the caller's job (Round 2 remediation §4: a single unordered
 *  `limit(1)` here could silently pick an arbitrary row when more than one candidate exists). */
export async function findTransferCounterpartCandidates(
  userId: string,
  row: { id: string; account_id: string; amount: number; date: string },
  windowStart: string,
  windowEnd: string,
  roleSourceFilter: string
): Promise<ReconciliationRow[]> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select(`${RECONCILIATION_ROW_COLUMNS}, accounts!inner(plaid_items!inner(user_id))`)
    .eq('accounts.plaid_items.user_id', userId)
    .neq('account_id', row.account_id)
    .neq('id', row.id)
    .eq('amount', -row.amount)
    .eq('role_source', roleSourceFilter)
    .gte('date', windowStart)
    .lte('date', windowEnd);

  if (error) throw new Error(`Failed to search for transfer counterpart candidates: ${error.message}`);
  return (data ?? []) as ReconciliationRowWithJoin[];
}

/** An earlier, same-account ordinary expense this negative `row` could be a refund against.
 *  "Ordinary expense" (Round 2 remediation §6) means actual reporting semantics, not merely a
 *  positive amount: `effective_role = 'expense'` AND not manual-loan-linked (a composite loan
 *  payment is never treated as one giant ordinary expense just because part of it is interest —
 *  see semanticEffects.ts). Amount must at least cover the refund (partial refunds allowed, never
 *  an over-refund), within the lookback window, on or before the refund's own date. Multiple
 *  candidates are ranked by the caller (roleReconciliation.ts) via normalized name/merchant
 *  matching plus deterministic exact-amount/closest-date preference — this only narrows by
 *  account/role/amount/date, which Postgres can do efficiently. */
export async function findRefundOriginalCandidates(
  userId: string,
  row: { id: string; account_id: string; amount: number; date: string },
  windowStart: string
): Promise<ReconciliationRow[]> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select(`${RECONCILIATION_ROW_COLUMNS}, accounts!inner(plaid_items!inner(user_id))`)
    .eq('accounts.plaid_items.user_id', userId)
    .eq('account_id', row.account_id)
    .neq('id', row.id)
    .eq('effective_role', 'expense')
    .is('manual_loan_id', null)
    .gte('amount', Math.abs(row.amount))
    .gte('date', windowStart)
    .lte('date', row.date)
    .order('date', { ascending: false });

  if (error) throw new Error(`Failed to search for refund original: ${error.message}`);
  return (data ?? []) as ReconciliationRowWithJoin[];
}

/** Every negative, same-account transaction dated on/after `row` (an ordinary expense) within the
 *  refund window, filtered by `roleSourceFilter` — used with `'sign_default'` to find a dangling
 *  refund candidate a freshly-touched purchase might resolve (the purchase-arrives-after-its-
 *  refund direction — see roleReconciliation.ts's `resolveDanglingRefunds`). Parameterized rather
 *  than hardcoded (Round 2 remediation §1/§3), mirroring findTransferCounterpartCandidates' own
 *  roleSourceFilter pattern, even though `'sign_default'` is its only caller today — the repair
 *  sweep re-validates an EXISTING refund_match row from the OPPOSITE direction instead (searching
 *  for ITS original via `findRefundOriginalCandidates`, not searching for dependents of an
 *  original via this function — see `repairRefundMatches`). */
export async function findNegativeCandidatesReferencingOriginal(
  userId: string,
  row: { id: string; account_id: string; amount: number; date: string },
  windowEnd: string,
  roleSourceFilter: string
): Promise<ReconciliationRow[]> {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .select(`${RECONCILIATION_ROW_COLUMNS}, accounts!inner(plaid_items!inner(user_id))`)
    .eq('accounts.plaid_items.user_id', userId)
    .eq('account_id', row.account_id)
    .neq('id', row.id)
    .lt('amount', 0)
    .gte('amount', -row.amount) // abs(candidate.amount) <= row.amount
    .eq('role_source', roleSourceFilter)
    .gte('date', row.date)
    .lte('date', windowEnd)
    .order('date', { ascending: true });

  if (error) throw new Error(`Failed to search for negative candidates: ${error.message}`);
  return (data ?? []) as ReconciliationRowWithJoin[];
}

export interface BackfillCandidateRow {
  id: string;
  user_id: string;
  account_id: string;
  amount: number;
  date: string;
  name: string;
  merchant_name: string | null;
  category: string | null;
  personal_finance_category_detailed: string | null;
  personal_finance_category_confidence: string | null;
  manual_loan_id: string | null;
  auto_role: string | null;
  role_source: string | null;
  user_role_override: string | null;
  classifier_version: number;
}

export interface BackfillPageCursor {
  date: string;
  id: string;
}

/**
 * One page of transactions in deterministic (date, id) order, starting strictly after `after` —
 * backs backfillTransactionSemantics.ts (Round 2 remediation §10/§11). Returns EVERY row in the
 * traversal range regardless of classification state (not just `auto_role IS NULL`): paging by
 * position rather than by "still unclassified" means a page is never skipped just because an
 * earlier run already wrote `auto_role` for some of its rows, and the exact same traversal serves
 * both a truthful dry-run preview and a real apply run. The caller decides, per row, whether a
 * write is actually needed (`auto_role IS NULL`, or `classifier_version` behind the target, or an
 * explicit forced re-check) — this function only ever describes what exists in the range.
 */
export async function getTransactionsBackfillPage(
  limit: number,
  after: BackfillPageCursor | null
): Promise<BackfillCandidateRow[]> {
  let query = supabaseAdmin
    .from('transactions')
    .select(
      'id, account_id, amount, date, name, merchant_name, category, personal_finance_category_detailed, personal_finance_category_confidence, manual_loan_id, auto_role, role_source, user_role_override, classifier_version, accounts!inner(plaid_items!inner(user_id))'
    );

  if (after) {
    // Keyset (not OFFSET) pagination: strictly greater than the last row's own (date, id) —
    // stable and correct even as earlier rows in the range are concurrently updated by this same
    // backfill (an OFFSET-based page would silently skip/repeat rows as the result set shrinks
    // out from under it; a keyset page never does, regardless of how many already-visited rows
    // change).
    query = query.or(`date.gt.${after.date},and(date.eq.${after.date},id.gt.${after.id})`);
  }

  const { data, error } = await query.order('date', { ascending: true }).order('id', { ascending: true }).limit(limit);

  if (error) throw new Error(`Failed to load transactions for backfill: ${error.message}`);
  return (data ?? []).map((row) => {
    const accounts = row.accounts as unknown as { plaid_items: { user_id: string } };
    return {
      id: row.id as string,
      user_id: accounts.plaid_items.user_id,
      account_id: row.account_id as string,
      amount: row.amount as number,
      date: row.date as string,
      name: row.name as string,
      merchant_name: row.merchant_name as string | null,
      category: row.category as string | null,
      personal_finance_category_detailed: row.personal_finance_category_detailed as string | null,
      personal_finance_category_confidence: row.personal_finance_category_confidence as string | null,
      manual_loan_id: row.manual_loan_id as string | null,
      auto_role: row.auto_role as string | null,
      role_source: row.role_source as string | null,
      user_role_override: row.user_role_override as string | null,
      classifier_version: row.classifier_version as number,
    };
  });
}

/** Thrown by `applyTransactionSemanticRoles` for ANY failure the RPC reports — an ownership
 *  mismatch, a row-count mismatch, duplicate ids, a missing row, or a genuine infrastructure
 *  error. Round 4 remediation §6: a prior version of this function converted the RPC's own
 *  integrity failure (Postgres error code `P0001`) into a `false` return, which callers could
 *  (and did) treat as an ordinary "not resolved" outcome — indistinguishable from candidate
 *  ambiguity. That is wrong: candidate ambiguity is a legitimate semantic OUTCOME (no relational
 *  evidence was strong enough to confirm a match) discovered BEFORE ever calling this function,
 *  whereas a failure reported BY this function means the mutation we asked for did not happen at
 *  all — ownership didn't check out, or the rows we thought we could see are gone. That is a hard
 *  persistence-integrity failure, not a candidate-ranking outcome, and must abort the calling
 *  sync/backfill operation (leaving its cursor/page unadvanced) exactly like any other
 *  reconciliation failure — never be silently absorbed into a per-row "unresolved" result. */
export class SemanticRoleMutationError extends Error {}

/**
 * Applies a semantic-role mutation to one or two transactions atomically and ownership-safely
 * (Round 3 remediation §1) — the sole replacement for the old two-step "UPDATE ... WHERE id
 * IN (...), then inspect the returned joined rows for ownership" pattern (Round 2), which checked
 * ownership only AFTER the write had already landed: a wrong-user id, or one leg of an intended
 * transfer pair, could already be mutated before that check ever ran.
 *
 * Delegates the entire verify-then-write sequence to `apply_transaction_semantic_roles` (see the
 * Phase A migration), a single PostgreSQL function invocation — one implicit transaction — that
 * locks the OWNED candidate rows before touching anything, verifies the count matches
 * `transactionIds` exactly, performs the update restricted to exactly that verified set, and
 * re-verifies the affected-row count afterward, RAISING (and so rolling back everything the call
 * did) on any mismatch. Pass a one-element array for a single-row mutation, or a two-element
 * array for an atomic transfer-pair mutation — there is no partial state this call can leave
 * durable.
 *
 * Round 4 remediation §6: throws `SemanticRoleMutationError` for ANY error the RPC reports —
 * ownership/count-mismatch integrity failures included, not just genuine infrastructure errors.
 * See that error's own doc comment for why this must be a hard failure rather than a `false`
 * return callers could mistake for ordinary candidate ambiguity.
 *
 * Round 6 remediation (blocker 3, completing the mitigation): `expectedRoleSources` (parallel to
 * `transactionIds`, same length and order) is a compare-and-swap check — the role_source each row
 * was observed to have at the moment the caller's candidate-selection logic decided to write this
 * mutation. The RPC verifies every row's CURRENT role_source still matches before writing
 * anything, and raises (rolling back) if not — closing the window between "this row was ranked
 * from a read that happened moments ago, outside any lock" and "this row is about to be
 * overwritten," which the per-user advisory lock alone cannot close (it only prevents two WRITES
 * from interleaving with each other, not a write from proceeding on a since-invalidated read).
 */
export async function applyTransactionSemanticRoles(
  userId: string,
  transactionIds: string[],
  expectedRoleSources: (string | null)[],
  fields: { auto_role: SemanticRole; role_source: string; role_confidence: string; classifier_version: number }
): Promise<void> {
  const { error } = await supabaseAdmin.rpc('apply_transaction_semantic_roles', {
    p_user_id: userId,
    p_transaction_ids: transactionIds,
    p_expected_role_sources: expectedRoleSources,
    p_auto_role: fields.auto_role,
    p_role_source: fields.role_source,
    p_role_confidence: fields.role_confidence,
    p_classifier_version: fields.classifier_version,
  });
  if (error) {
    throw new SemanticRoleMutationError(`Failed to apply transaction semantic roles: ${error.message}`);
  }
}

/** Thrown by `confirmTransferPair` for any failure the RPC reports — ownership, eligibility,
 *  amount/account mismatch, or (the case this function exists to catch) a candidate re-ranked
 *  from current data no longer confirming the intended pair. See that function's own doc comment. */
export class TransferPairConfirmationError extends Error {}

/**
 * Confirms a transfer pair ATOMICALLY WITH re-verification of its candidate ranking (Round 7
 * remediation, completing blocker 3) — the sole write path for turning two
 * `transfer_like_unconfirmed` rows into a confirmed `account_pair_match` pair. Unlike
 * `applyTransactionSemanticRoles`'s CAS check (which only re-verifies that the two TARGET rows
 * haven't themselves changed), this delegates to `confirm_transfer_pair` (see the Phase A
 * migration), which re-runs candidate DISCOVERY and RANKING for both rows from current, locked
 * data — under the same per-user advisory lock as every other write — and only commits if each
 * row's own freshly-computed best match is still the other. This is what catches a "phantom
 * candidate": a third row inserted or modified after the application (roleReconciliation.ts's
 * `computeReciprocalTransferResolution`) ranked this pair, which a row-only CAS check cannot see
 * because it never re-examines the candidate SET, only the two rows already selected from it.
 *
 * The application's own ranking still decides WHICH pair is worth attempting (it also drives
 * dry-run preview and same-batch pool lookahead, neither of which apply here) — this function is
 * the sole authority on whether that pair is still correct at the moment of commit.
 */
export async function confirmTransferPair(
  userId: string,
  rowAId: string,
  rowBId: string,
  roleSourceFilter: string,
  windowDays: number,
  classifierVersion: number
): Promise<void> {
  const { error } = await supabaseAdmin.rpc('confirm_transfer_pair', {
    p_user_id: userId,
    p_row_a_id: rowAId,
    p_row_b_id: rowBId,
    p_role_source_filter: roleSourceFilter,
    p_window_days: windowDays,
    p_classifier_version: classifierVersion,
  });
  if (error) {
    throw new TransferPairConfirmationError(`Failed to confirm transfer pair: ${error.message}`);
  }
}

/**
 * One page (keyset-paginated by id) of a user's EXISTING relationally-classified transactions —
 * `role_source = 'account_pair_match'` or `'refund_match'` — backing roleReconciliation.ts's
 * `repairExistingRelationalRoles` sweep (Round 3 remediation §3/§4). Bounded and same-user-scoped
 * like every other query in this section: never a full scan, and ownership is enforced by the
 * same `accounts!inner(plaid_items!inner(user_id))` join used throughout this file.
 */
export async function getRelationallyClassifiedTransactionsPage(
  userId: string,
  roleSource: 'account_pair_match' | 'refund_match',
  limit: number,
  afterId: string | null
): Promise<ReconciliationRow[]> {
  let query = supabaseAdmin
    .from('transactions')
    .select(`${RECONCILIATION_ROW_COLUMNS}, accounts!inner(plaid_items!inner(user_id))`)
    .eq('accounts.plaid_items.user_id', userId)
    .eq('role_source', roleSource);

  if (afterId) query = query.gt('id', afterId);

  const { data, error } = await query.order('id', { ascending: true }).limit(limit);
  if (error) throw new Error(`Failed to load relationally-classified transactions: ${error.message}`);
  return (data ?? []) as ReconciliationRowWithJoin[];
}
