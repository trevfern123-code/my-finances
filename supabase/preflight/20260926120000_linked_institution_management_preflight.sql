-- READ-ONLY preflight and postflight for
--   supabase/migrations/20260926120000_linked_institution_management.sql
--
-- Every statement below is a single SELECT: safe to run against production at any time, one at a
-- time, in the Supabase SQL editor. This file lives outside supabase/migrations on purpose: no
-- migration runner will ever execute it.

-- PREFLIGHT 0 (before `supabase db push`): no partial object from an earlier, interrupted or manual
-- attempt. Every column below is expected to be false (the migration creates all of these objects,
-- none with IF NOT EXISTS, so a leftover one would fail the push — or worse, a hand-made one with a
-- different shape would be mistaken for the real thing). Any true: STOP and investigate; never drop
-- anything to make this pass without approval.
select
  to_regclass('public.plaid_item_removals') is not null                                     as removals_table,
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'plaid_items'
            and column_name in ('consent_expires_at', 'last_synced_at'))                     as plaid_items_columns,
  exists (select 1 from pg_constraint where conrelid = 'public.plaid_items'::regclass
          and conname = 'plaid_items_status_check')                                          as status_check,
  exists (select 1 from pg_trigger where tgrelid = 'public.plaid_items'::regclass
          and tgname = 'plaid_items_keep_removing')                                          as keep_removing_trigger,
  (to_regprocedure('public.plaid_items_keep_removing()') is not null
   or to_regprocedure('public.plaid_item_removal_digest(uuid, uuid)') is not null
   or to_regprocedure('public.plaid_item_removal_blocker(uuid, uuid)') is not null
   or to_regprocedure('public.preview_plaid_item_removal(uuid, uuid)') is not null
   or to_regprocedure('public.begin_plaid_item_removal(uuid, uuid, text)') is not null
   or to_regprocedure('public.record_plaid_item_removal_attempt(uuid, uuid, text, text)') is not null
   or to_regprocedure('public.remove_plaid_item_local(uuid, uuid)') is not null
   or to_regprocedure('public.mark_plaid_item_removal_reconciled(uuid, uuid)') is not null) as functions,
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('plaid_items_keep_removing', 'plaid_item_removal_digest', 'plaid_item_removal_blocker',
                              'preview_plaid_item_removal', 'begin_plaid_item_removal',
                              'record_plaid_item_removal_attempt', 'remove_plaid_item_local',
                              'mark_plaid_item_removal_reconciled'))                         as same_named_overloads;

-- PREFLIGHT 1 (before `supabase db push`). Expected: ledger_head = 20260924130000, pending = 0,
-- unexpected_statuses = 0 (the migration's new CHECK would refuse the whole file otherwise — it then
-- changes nothing), links_without_applied_delta = 0 (guaranteed by 20260924130000's constraint; any
-- non-zero value means a removal of that item will be refused, fail closed), and cross_user_links = 0
-- (a payment linked to a loan that is missing or belongs to another user; any such item's removal is
-- refused with manual_loan_ownership_mismatch before anything happens at Plaid).
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
     left join public.manual_loans l on l.id = t.manual_loan_id
    where t.manual_loan_id is not null
      and (l.id is null or l.user_id is distinct from pi.user_id))                          as cross_user_links,
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
-- trigger = true, removal_constraints = 3, removals = 0, functions = 7, client_table_access = false,
-- client_column_access = false, service_role_table_privileges = {INSERT,SELECT},
-- service_role_update_columns = {attempts,cleaned_at,deleted_counts,last_attempt_at,last_error_code,
-- last_outcome,loan_adjustments,plaid_outcome,plaid_removed_at,reconciled_at,status},
-- rls_enabled = true, policies = 0. (The migration asserts all of this itself and aborts otherwise;
-- this is the independent check from outside it.)
select
  (select max(version) from supabase_migrations.schema_migrations)                          as ledger_head,
  exists (select 1 from pg_constraint where conrelid = 'public.plaid_items'::regclass
          and conname = 'plaid_items_status_check' and convalidated)                        as status_check,
  exists (select 1 from pg_trigger where tgrelid = 'public.plaid_items'::regclass
          and tgname = 'plaid_items_keep_removing' and tgenabled = 'O')                     as trigger,
  (select count(*) from pg_constraint where conrelid = 'public.plaid_item_removals'::regclass
    and contype = 'c' and convalidated
    and conname in ('plaid_item_removals_state_check', 'plaid_item_removals_result_shape_check',
                    'plaid_item_removals_order_check'))                                      as removal_constraints,
  (select count(*) from public.plaid_item_removals)                                         as removals,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('plaid_item_removal_digest', 'plaid_item_removal_blocker', 'preview_plaid_item_removal',
                        'begin_plaid_item_removal', 'record_plaid_item_removal_attempt', 'remove_plaid_item_local',
                        'mark_plaid_item_removal_reconciled')
      and not p.prosecdef
      and p.proconfig = array['search_path=""']
      and has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('public', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute'))                   as functions,
  exists (select 1 from unnest(array['anon', 'authenticated']) r(role),
                        unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger',
                                     'maintain']) pr(priv)
          where has_table_privilege(r.role, 'public.plaid_item_removals', pr.priv))         as client_table_access,
  exists (select 1 from information_schema.column_privileges
          where table_schema = 'public' and table_name = 'plaid_item_removals'
            and grantee in ('anon', 'authenticated', 'PUBLIC'))                              as client_column_access,
  (select array_agg(privilege_type order by privilege_type) from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'plaid_item_removals'
      and grantee = 'service_role')                                                         as service_role_table_privileges,
  (select array_agg(column_name::text order by column_name) from information_schema.column_privileges
    where table_schema = 'public' and table_name = 'plaid_item_removals'
      and grantee = 'service_role' and privilege_type = 'UPDATE')                           as service_role_update_columns,
  (select relrowsecurity from pg_class where oid = 'public.plaid_item_removals'::regclass)  as rls_enabled,
  (select count(*) from pg_policy where polrelid = 'public.plaid_item_removals'::regclass)  as policies;

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
