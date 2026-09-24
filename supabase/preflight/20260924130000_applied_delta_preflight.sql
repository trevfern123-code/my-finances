-- READ-ONLY preflight and postflight for the post-audit release:
--   supabase/migrations/20260924120000_manual_loan_link_idempotency.sql
--   supabase/migrations/20260924130000_manual_loan_applied_balance_delta.sql
--
-- Every statement below is a single SELECT: safe to run against production at any time, one at a
-- time, in the Supabase SQL editor. This file lives outside supabase/migrations on purpose: no
-- migration runner will ever execute it. Release procedure: README "Releasing the post-audit
-- migrations".
--
-- 20260924130000 records the balance delta each manual-loan payment actually applied. A link or
-- manual payment that exists before it has no recorded delta, and none can be reconstructed, so
-- that migration refuses to run while any exists. These queries show, in advance, whether it will.

-- PREFLIGHT 1 (before `supabase db push`). Expected: ledger_head = 20260922130000,
-- pending_post_audit = 0, and linked_transactions, manual_payments, cross_user_links and
-- cross_user_payments all 0. Any non-zero count in those four: STOP — the release needs a
-- reconciliation decision first (do not delete or edit rows to make this pass).
-- stale_unlinked_principal and manual_loans are informational only.
select
  (select max(version) from supabase_migrations.schema_migrations)                       as ledger_head,
  (select count(*) from supabase_migrations.schema_migrations where version >= '20260924') as pending_post_audit,
  (select count(*) from public.transactions where manual_loan_id is not null)             as linked_transactions,
  (select count(*) from public.manual_loan_payments)                                      as manual_payments,
  (select count(*) from public.transactions t
     join public.accounts a on a.id = t.account_id
     join public.plaid_items pi on pi.id = a.item_id
     join public.manual_loans l on l.id = t.manual_loan_id
    where l.user_id <> pi.user_id)                                                        as cross_user_links,
  (select count(*) from public.manual_loan_payments p
     join public.manual_loans l on l.id = p.loan_id
    where p.user_id <> l.user_id)                                                         as cross_user_payments,
  (select count(*) from public.transactions
    where manual_loan_id is null and principal_portion is not null)                       as stale_unlinked_principal,
  (select count(*) from public.manual_loans)                                              as manual_loans;

-- PREFLIGHT 2 (only if PREFLIGHT 1 found links or payments): per loan, the rows a reconciliation
-- decision would cover. A loan at 0 may have had an application clamped at zero, i.e. applied less
-- than its principal.
select l.id, l.name, l.current_balance, l.updated_at,
       (select count(*) from public.transactions t where t.manual_loan_id = l.id)                             as linked,
       (select coalesce(sum(principal_portion), 0) from public.transactions t where t.manual_loan_id = l.id)  as linked_principal,
       (select count(*) from public.manual_loan_payments p where p.loan_id = l.id)                            as payments,
       (select coalesce(sum(principal_portion), 0) from public.manual_loan_payments p where p.loan_id = l.id) as payment_principal,
       l.current_balance = 0                                                                                  as may_have_hit_zero_floor
from public.manual_loans l
order by l.name;

-- POSTFLIGHT (after `supabase db push`, before merging). Expected: new_versions =
-- 20260924120000,20260924130000; link_returns = text; guards_validated = 3;
-- balance_applied_not_null = true; null_link_deltas = 0; null_payment_deltas = 0;
-- insecure_functions = 0.
select
  (select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations
    where version >= '20260924')                                                          as new_versions,
  (select prorettype::regtype::text from pg_proc
    where oid = 'public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint)'::regprocedure) as link_returns,
  (select count(*) from pg_constraint
    where convalidated
      and (conrelid, conname) in (('public.transactions'::regclass, 'transactions_loan_balance_applied_check'),
                                  ('public.transactions'::regclass, 'transactions_loan_balance_applied_required_check'),
                                  ('public.manual_loan_payments'::regclass, 'manual_loan_payments_balance_applied_check'))) as guards_validated,
  (select attnotnull from pg_attribute
    where attrelid = 'public.manual_loan_payments'::regclass and attname = 'balance_applied') as balance_applied_not_null,
  (select count(*) from public.transactions
    where manual_loan_id is not null and loan_balance_applied is null)                     as null_link_deltas,
  (select count(*) from public.manual_loan_payments where balance_applied is null)         as null_payment_deltas,
  (select count(*) from pg_proc p
    where p.oid in ('public.link_transaction_to_manual_loan(uuid, uuid, uuid, numeric, smallint)'::regprocedure,
                    'public.unlink_transaction_from_manual_loan(uuid, uuid, uuid, text, text, text, smallint)'::regprocedure,
                    'public.update_linked_payment_principal(uuid, uuid, uuid, numeric)'::regprocedure,
                    'public.create_manual_loan_payment(uuid, uuid, date, numeric, numeric, text)'::regprocedure,
                    'public.update_manual_loan_payment(uuid, uuid, uuid, boolean, date, boolean, numeric, boolean, numeric, boolean, text)'::regprocedure,
                    'public.delete_manual_loan_payment(uuid, uuid, uuid)'::regprocedure,
                    'public.delete_transactions_and_restore_loan_balances(uuid, text[])'::regprocedure)
      and (p.prosecdef
           or p.proconfig is distinct from array['search_path=""']
           or has_function_privilege('anon', p.oid, 'execute')
           or has_function_privilege('authenticated', p.oid, 'execute')
           or not has_function_privilege('service_role', p.oid, 'execute')))              as insecure_functions;
