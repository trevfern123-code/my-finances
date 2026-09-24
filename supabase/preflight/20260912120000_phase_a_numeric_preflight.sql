-- READ-ONLY preflight for supabase/migrations/20260912120000_transaction_semantic_roles.sql.
--
-- Safe to run against production at any time: it only SELECTs. It lists every existing row that
-- would make that migration's dirty-data gate refuse to run (before the migration), or that would
-- block `ALTER TABLE ... VALIDATE CONSTRAINT` (after it). Each predicate is the exact CHECK
-- expression of the named constraint; `is false` matches CHECK semantics (NULL passes).
--
-- Interpretation: all three queries must return ZERO rows. For each returned row, decide the
-- correct value from the source of truth (the lender statement, Plaid, the user) and fix it with
-- ONE UPDATE that corrects every bad column of that row — PostgreSQL checks the whole row, so
-- fixing one column while another is still bad fails once the constraints exist. Never bulk-set
-- values just to make these queries pass. This file lives outside supabase/migrations on purpose:
-- no migration runner will ever execute it.

-- 1. manual_loans
select id, user_id, name, current_balance, origination_principal_amount,
       interest_rate_percentage, minimum_payment_amount, term_months,
       array_remove(array[
         case when (current_balance >= 0 and current_balance < 'Infinity'::numeric) is false
              then 'manual_loans_current_balance_check' end,
         case when (origination_principal_amount is null
                    or (origination_principal_amount >= 0 and origination_principal_amount < 'Infinity'::numeric)) is false
              then 'manual_loans_origination_principal_amount_check' end,
         case when (interest_rate_percentage is null
                    or (interest_rate_percentage >= 0 and interest_rate_percentage < 'Infinity'::numeric)) is false
              then 'manual_loans_interest_rate_percentage_check' end,
         case when (minimum_payment_amount is null
                    or (minimum_payment_amount >= 0 and minimum_payment_amount < 'Infinity'::numeric)) is false
              then 'manual_loans_minimum_payment_amount_check' end,
         case when (term_months is null or term_months > 0) is false
              then 'manual_loans_term_months_check' end
       ], null) as violated_constraints
from public.manual_loans
where (current_balance >= 0 and current_balance < 'Infinity'::numeric) is false
   or (origination_principal_amount is null
       or (origination_principal_amount >= 0 and origination_principal_amount < 'Infinity'::numeric)) is false
   or (interest_rate_percentage is null
       or (interest_rate_percentage >= 0 and interest_rate_percentage < 'Infinity'::numeric)) is false
   or (minimum_payment_amount is null
       or (minimum_payment_amount >= 0 and minimum_payment_amount < 'Infinity'::numeric)) is false
   or (term_months is null or term_months > 0) is false
order by id;

-- 2. transactions
select id, account_id, plaid_transaction_id, amount, principal_portion,
       array_remove(array[
         case when (amount > -'Infinity'::numeric and amount < 'Infinity'::numeric) is false
              then 'transactions_amount_finite_check' end,
         case when (principal_portion is null
                    or (principal_portion >= 0 and principal_portion < 'Infinity'::numeric)) is false
              then 'transactions_principal_portion_check' end
       ], null) as violated_constraints
from public.transactions
where (amount > -'Infinity'::numeric and amount < 'Infinity'::numeric) is false
   or (principal_portion is null
       or (principal_portion >= 0 and principal_portion < 'Infinity'::numeric)) is false
order by id;

-- 3. manual_loan_payments
select id, user_id, loan_id, principal_portion, interest_portion,
       array_remove(array[
         case when (principal_portion >= 0 and principal_portion < 'Infinity'::numeric) is false
              then 'manual_loan_payments_principal_portion_check' end,
         case when (interest_portion >= 0 and interest_portion < 'Infinity'::numeric) is false
              then 'manual_loan_payments_interest_portion_check' end
       ], null) as violated_constraints
from public.manual_loan_payments
where (principal_portion >= 0 and principal_portion < 'Infinity'::numeric) is false
   or (interest_portion >= 0 and interest_portion < 'Infinity'::numeric) is false
order by id;
