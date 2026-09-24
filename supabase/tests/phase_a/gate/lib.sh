# Shared by the gate/ tests (sourced by their steps.sh). run.sh exports psql_db, apply_migration,
# CONTAINER, HERE, LOGS and MIGRATION before running them.

fail() {
  echo "ASSERTION FAILED: $*"
  exit 1
}

# Everything the migration could create or change, as one digest: public tables, columns,
# constraints (with their validated flag), functions, and table ACLs.
schema_fingerprint() {
  psql_db -At -c "select md5(coalesce(string_agg(x, '|' order by x), '')) from (
      select 'col:' || table_name || '.' || column_name || ':' || data_type from information_schema.columns where table_schema = 'public'
      union all select 'con:' || conrelid::regclass || '.' || conname || ':' || convalidated from pg_constraint where connamespace = 'public'::regnamespace
      union all select 'fn:' || p.oid::regprocedure::text from pg_proc p where p.pronamespace = 'public'::regnamespace
      union all select 'rel:' || relname || ':' || relkind::text || ':' || coalesce(relacl::text, '') from pg_class where relnamespace = 'public'::regnamespace
    ) s(x)" </dev/null
}

# Every pre-existing value of the three constrained tables, as one digest. Only columns that exist
# BEFORE the migration are included (the migration adds columns to transactions; new columns are
# not a change to existing data), and only columns common to the scaffold and the real schema.
data_fingerprint() {
  psql_db -At -c "select md5(
      coalesce((select string_agg(concat_ws(',', id, user_id, name, loan_type, current_balance, origination_principal_amount,
                  interest_rate_percentage, origination_date, term_months, minimum_payment_amount, next_payment_due_date,
                  notes, match_text), '|' order by id) from public.manual_loans), '') ||
      coalesce((select string_agg(concat_ws(',', id, account_id, plaid_transaction_id, amount, date, name, merchant_name,
                  category, pending, needs_review, budget_category_id, manual_loan_id, principal_portion), '|' order by id)
                from public.transactions), '') ||
      coalesce((select string_agg(concat_ws(',', id, user_id, loan_id, date, principal_portion, interest_portion, notes), '|' order by id)
                from public.manual_loan_payments), ''))" </dev/null
}

migration_is_applied() {
  [ "$(psql_db -At -c "select to_regclass('public.manual_loan_deletions') is not null" </dev/null)" = "t" ]
}

ALL_NINE_CONSTRAINTS=(
  manual_loans_current_balance_check
  manual_loans_origination_principal_amount_check
  manual_loans_interest_rate_percentage_check
  manual_loans_minimum_payment_amount_check
  manual_loans_term_months_check
  transactions_amount_finite_check
  transactions_principal_portion_check
  manual_loan_payments_principal_portion_check
  manual_loan_payments_interest_portion_check
)
