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
}

export interface BudgetCategoryRow {
  id: string;
  user_id: string;
  name: string;
  budget_amount: number;
  color: string | null;
  sort_order: number;
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
