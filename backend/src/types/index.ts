export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

// Mirrors the Supabase schema (see project root README for the flow these support).
export interface PlaidItemRow {
  id: string;
  user_id: string;
  plaid_item_id: string;
  /** Plaintext access token. Nullable as of the Plaid Token Encryption migration — a row written
   *  under Phase 2b (encrypted-only) or fully backfilled (Phase 5+) has this as null, with the
   *  encrypted columns below as the sole representation. See
   *  PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md. */
  access_token: string | null;
  /** The five columns below are all null together, or all non-null together (enforced by the
   *  `plaid_items_encrypted_token_complete` check constraint) — see the design doc §2/§3. */
  access_token_ciphertext: string | null;
  access_token_nonce: string | null;
  access_token_auth_tag: string | null;
  access_token_key_id: string | null;
  access_token_enc_version: number | null;
  institution_id: string | null;
  institution_name: string | null;
  transactions_cursor: string | null;
  /** 'credential_error' (added alongside encryption) means this app failed to decrypt/read the
   *  stored credential — distinct from 'login_required', which means Plaid itself rejected it.
   *  Never conflate the two (PLAID_TOKEN_ENCRYPTION_DESIGN_REVIEW.md §9/§10). */
  status: string;
}

/** A transaction row as returned right after insert — just enough to run loan-payment matching against. */
export interface InsertedTransaction {
  id: string;
  name: string;
  merchant_name: string | null;
  amount: number;
}

export interface AccountRow {
  id: string;
  item_id: string;
  plaid_account_id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  current_balance: number | null;
  available_balance: number | null;
  iso_currency_code: string | null;
  /** User-entered, not from Plaid — Plaid's own credit-limit data is unreliable across
   *  institutions, so utilization is computed from whatever the user fills in here. */
  credit_limit: number | null;
  /** User-entered target balance for a savings account, used for goal-progress tracking. */
  savings_goal: number | null;
  /** Display override — Plaid's own `name` is used everywhere nickname is null. User-entered,
   *  never touched by Plaid sync. */
  nickname: string | null;
  /** Organizational/identity color, never touched by Plaid sync. Not a semantic financial color. */
  color: string | null;
  /** Organizational/identity icon (single emoji), never touched by Plaid sync. */
  icon: string | null;
  /** Manual display order, never touched by Plaid sync. */
  sort_order: number;
  /** Display-only — removes the account from glanceable summary widgets. Never affects net worth,
   *  cash-flow calculations, sync, or historical data. Never touched by Plaid sync. */
  hidden: boolean;
  /** Excludes this account's balance from net-worth/liquid-cash calculations. Never touched by
   *  Plaid sync. */
  exclude_from_net_worth: boolean;
  /** Excludes this account's transactions/recurring streams from personal cash-flow aggregates
   *  (Monthly Spending, Monthly Breakdown, Budget spend, Cash Flow Pace, Savings Rate, recurring
   *  summaries) — individual transactions stay visible in the feed. Never affects net worth.
   *  Never touched by Plaid sync. */
  exclude_from_cash_flow: boolean;
}

export interface TransactionRow {
  id: string;
  account_id: string;
  plaid_transaction_id: string;
  amount: number;
  iso_currency_code: string | null;
  date: string;
  name: string;
  merchant_name: string | null;
  category: string | null;
  plaid_category: string | null;
  pending: boolean;
  budget_category_id: string | null;
  manual_loan_id: string | null;
  /** How much of this transaction's amount reduces the linked loan's principal — editable, since
   *  a payment on an interest-bearing loan doesn't reduce balance by the full payment amount. */
  principal_portion: number | null;
  /** True for every newly-synced transaction until the user approves it — never reset by a
   *  later Plaid update, only cleared explicitly via the approve endpoint. */
  needs_review: boolean;
}

export interface BudgetCategoryRow {
  id: string;
  user_id: string;
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
}

/** Maps one of Plaid's own category values (transactions.category — the personal_finance_category
 *  primary bucket, e.g. "FOOD_AND_DRINK") to one of the user's budget categories, so a newly-synced
 *  transaction can be auto-categorized at insert time without the user touching it. */
export interface CategoryMappingRow {
  id: string;
  user_id: string;
  plaid_category: string;
  budget_category_id: string;
  created_at: string;
}

/** One line item of a split transaction — reallocates part of the parent transaction's amount to
 *  its own budget category. When a transaction has any splits, they (not the parent's own
 *  budget_category_id) are the source of truth for how its amount is categorized. */
export interface TransactionSplitRow {
  id: string;
  transaction_id: string;
  budget_category_id: string;
  amount: number;
  note: string | null;
  created_at: string;
}

/** Per-user preferences. Structured/free-form settings (dashboard layout) live in their own jsonb
 *  column; a genuinely simple preference (theme, accent_color) gets its own dedicated column
 *  instead of being folded into an existing jsonb column — this table is meant to grow this way,
 *  not become one giant blob. */
export interface UserPreferencesRow {
  user_id: string;
  /** Null until the user customizes their dashboard at least once — the frontend falls back to
   *  its own built-in default layout in that case, not an empty/broken one. */
  dashboard_layout: { cards: { id: string; visible: boolean }[] } | null;
  /** 'system' | 'light' | 'dark' — validated/defaulted at the controller layer, stored as plain
   *  text here since a check constraint plus app-layer validation is enough for a 3-value enum. */
  theme: string;
  /** One of a small fixed set of preset ids (see frontend lib/theme.ts) — same reasoning as theme. */
  accent_color: string;
  /** Dollar amount, non-negative — money the user never wants counted as spendable in Safe to
   *  Spend. Never alters any actual account balance, budget target, or transaction. */
  minimum_cash_buffer: number;
  /** Days ahead counted as "upcoming" for bills — shared by Safe to Spend and the Upcoming Bills
   *  widget so the two always agree on what "upcoming" means. */
  upcoming_bills_days: number;
  /** How many recent full months the Budget tab's "recent avg" spend figure averages over. */
  recent_avg_months: number;
  /** A percentage (0-100), not a fraction — the user's personal savings-rate goal. Changes the
   *  target/comparison shown against the Savings Rate card, never the calculated rate itself.
   *  Deliberately separate from a per-account dollar savings_goal (see AccountRow). */
  savings_rate_target: number;
  /** Safe to Spend Customization v1 — whether the upcoming-bills total (including the credit-card
   *  minimum-payments sub-total) is subtracted from Safe to Spend at all. Defaults true, matching
   *  the calculation's pre-existing behavior. */
  safe_to_spend_include_upcoming_bills: boolean;
  /** Whether unspent budget headroom is subtracted from Safe to Spend at all. Defaults true,
   *  matching the calculation's pre-existing behavior. */
  safe_to_spend_include_remaining_budget: boolean;
  /** Date-Range Customization v1 — one of ReportingRangeId ('this_month' | 'last_month' |
   *  'last_3_months' | 'last_6_months' | 'last_12_months'), validated/defaulted at the
   *  controller layer same as theme/accent_color. Drives Monthly Breakdown, the Overview
   *  spending chart, and the Net Worth chart only — never Safe to Spend, Cash Flow Pace, the
   *  Budget tab's recent-average comparison, or the Transactions feed, all of which are either
   *  current-period-intrinsic or independently configured. */
  reporting_range: string;
  created_at: string;
  updated_at: string;
}

export interface BudgetCategoryWithSpend extends BudgetCategoryRow {
  /** Sum of positive-amount (spend, not income/credit) categorized transactions in the current calendar month. */
  spent: number;
  /** Average monthly spend over the most recent full months (excludes the in-progress current month). */
  recent_avg_spent: number;
}

export interface RecurringStreamRow {
  id: string;
  item_id: string;
  account_id: string | null;
  plaid_stream_id: string;
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
}

export interface LoanRow {
  id: string;
  item_id: string;
  account_id: string | null;
  plaid_account_id: string;
  loan_type: 'student' | 'mortgage' | 'credit';
  name: string | null;
  interest_rate_percentage: number | null;
  origination_principal_amount: number | null;
  origination_date: string | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  is_overdue: boolean | null;
}

export interface ManualLoanRow {
  id: string;
  user_id: string;
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
  /** Case-insensitive substring matched against a transaction's name/merchant — matching
   *  outflow transactions auto-link to this loan and decrement its balance. Null disables matching. */
  match_text: string | null;
}

/** A payment logged by hand rather than detected from a synced bank transaction — e.g. a cash
 *  payment, or a historical payment made before the loan was added. Unlike a linked transaction's
 *  principal_portion (where interest is implicitly amount-minus-principal), both portions are
 *  entered explicitly here since there's no underlying transaction amount to split. */
export interface ManualLoanPaymentRow {
  id: string;
  loan_id: string;
  user_id: string;
  date: string;
  principal_portion: number;
  interest_portion: number;
  notes: string | null;
  created_at: string;
}
