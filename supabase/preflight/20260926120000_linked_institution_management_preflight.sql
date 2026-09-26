-- READ-ONLY preflight and postflight for
--   supabase/migrations/20260926120000_linked_institution_management.sql
--
-- Every statement below is a single SELECT: safe to run against production at any time, one at a
-- time, in the Supabase SQL editor. This file lives outside supabase/migrations on purpose: no
-- migration runner will ever execute it.

-- PREFLIGHT 1 (before `supabase db push`). Expected: ledger_head = 20260924130000, pending = 0,
-- unexpected_statuses = 0 (the migration's new CHECK would refuse the whole file otherwise — it then
-- changes nothing), links_without_applied_delta = 0 (guaranteed by 20260924130000's constraint; any
-- non-zero value means a removal of that item will be refused, fail closed), and cross_user_links = 0.
-- Any unexpected value: STOP (never edit rows to make this pass).
select
  (select max(version) from supabase_migrations.schema_migrations)                          as ledger_head,
  (select count(*) from supabase_migrations.schema_migrations where version >= '20260926')  as pending,
  (select count(*) from public.plaid_items
    where status not in ('active', 'login_required', 'credential_error'))                   as unexpected_statuses,
  (select count(*) from public.transactions
    where manual_loan_id is not null and loan_balance_applied is null)                      as links_without_applied_delta,
  (select count(*) from public.transactions t
     join public.accounts a on a.id = t.account_id
     join public.plaid_items pi on pi.id = a.item_id
     join public.manual_loans l on l.id = t.manual_loan_id
    where l.user_id <> pi.user_id)                                                          as cross_user_links,
  (select count(*) from public.plaid_items)                                                 as items;

-- PREFLIGHT 2 (informational): items by status.
select status, count(*) from public.plaid_items group by status order by status;

-- PREFLIGHT 3 (informational, keep the output): per item, what a removal would restore to manual
-- loans. After any removal, its recorded loan_adjustments must equal this item's row here (unless a
-- payment was linked or unlinked in between).
select pi.id as item_id, pi.institution_name, pi.status,
       (select count(*) from public.accounts a where a.item_id = pi.id) as accounts,
       (select count(*) from public.transactions t join public.accounts a on a.id = t.account_id where a.item_id = pi.id) as transactions,
       (select count(*) from public.transactions t join public.accounts a on a.id = t.account_id
         where a.item_id = pi.id and t.manual_loan_id is not null) as linked,
       (select coalesce(sum(t.loan_balance_applied), 0) from public.transactions t join public.accounts a on a.id = t.account_id
         where a.item_id = pi.id and t.manual_loan_id is not null) as restore_total
from public.plaid_items pi
order by pi.created_at;

-- POSTFLIGHT 1 (after `supabase db push`). Expected: ledger_head = 20260926120000, status_check = true,
-- trigger = true, removals = 0, functions = 6, client_table_access = false.
select
  (select max(version) from supabase_migrations.schema_migrations)                          as ledger_head,
  exists (select 1 from pg_constraint where conrelid = 'public.plaid_items'::regclass
          and conname = 'plaid_items_status_check' and convalidated)                        as status_check,
  exists (select 1 from pg_trigger where tgrelid = 'public.plaid_items'::regclass
          and tgname = 'plaid_items_keep_removing' and tgenabled = 'O')                     as trigger,
  (select count(*) from public.plaid_item_removals)                                         as removals,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('plaid_item_removal_digest', 'preview_plaid_item_removal', 'begin_plaid_item_removal',
                        'record_plaid_item_removal_attempt', 'remove_plaid_item_local', 'mark_plaid_item_removal_reconciled')
      and has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute'))                   as functions,
  (has_table_privilege('anon', 'public.plaid_item_removals', 'select')
   or has_table_privilege('authenticated', 'public.plaid_item_removals', 'select'))        as client_table_access;

-- AFTER THE SMOKE-TEST REMOVAL: the operation, and that nothing of its item remains.
-- Replace <item_id>.
select status, plaid_outcome, attempts, last_outcome, last_error_code, loan_adjustments, deleted_counts,
       requested_at, plaid_removed_at, cleaned_at, reconciled_at
from public.plaid_item_removals where item_id = '<item_id>';
select
  (select count(*) from public.plaid_items where id = '<item_id>')                           as item_rows,
  (select count(*) from public.accounts where item_id = '<item_id>')                         as account_rows,
  (select count(*) from public.recurring_streams where item_id = '<item_id>')                as stream_rows,
  (select count(*) from public.loans where item_id = '<item_id>')                            as liability_rows;
