export interface AuthenticatedUser {
  id: string;
  email: string | null;
}

// Mirrors the Supabase schema (see project root README for the flow these support).
export interface PlaidItemRow {
  id: string;
  user_id: string;
  plaid_item_id: string;
  access_token: string;
  institution_id: string | null;
  institution_name: string | null;
  transactions_cursor: string | null;
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
