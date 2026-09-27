-- READ-ONLY preflight and postflight for
--   supabase/migrations/20260927120000_pending_posted_continuity.sql
--
-- Every statement below is a single SELECT: safe to run against production at any time, one at a
-- time, in the Supabase SQL editor. This file lives outside supabase/migrations on purpose: no
-- migration runner will ever execute it.

-- PREFLIGHT 0 (before `supabase db push`): no partial object from an earlier attempt. Expected: every
-- column false. Any true: STOP and investigate.
select
  to_regclass('public.transaction_carryovers') is not null                                  as carryovers_table,
  exists (select 1 from information_schema.columns
          where table_schema = 'public' and table_name = 'transactions'
            and column_name in ('pending_transaction_id', 'posted_from_pending_amount', 'review_note',
                                'budget_category_source', 'budget_category_set_seq', 'user_role_override_at')) as transactions_columns,
  to_regclass('public.transactions_budget_category_seq') is not null                         as sequence,
  exists (select 1 from pg_trigger where tgrelid = 'public.transactions'::regclass
          and tgname = 'transactions_keep_user_cleared_category')                            as trigger,
  (to_regprocedure('public.transactions_keep_user_cleared_category()') is not null
   or to_regprocedure('public.apply_synced_transaction_batch_v2(uuid, jsonb, jsonb, text[])') is not null
   or to_regprocedure('public.set_transaction_budget_category(uuid, uuid, uuid)') is not null
   or to_regprocedure('public.approve_transaction(uuid, uuid)') is not null
   or to_regprocedure('public.replace_transaction_splits(uuid, uuid, jsonb)') is not null
   or to_regprocedure('public.backfill_category_mapping(uuid, text, uuid)') is not null)      as functions,
  exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public'
            and p.proname in ('transactions_keep_user_cleared_category', 'apply_synced_transaction_batch_v2',
                              'set_transaction_budget_category', 'approve_transaction',
                              'replace_transaction_splits', 'backfill_category_mapping'))       as same_named_overloads;

-- PREFLIGHT 1. Expected: ledger_head = 20260926120000, pending = 0. Keep the two md5 values: POSTFLIGHT 1
-- must show them unchanged (the old sync RPCs are untouched — an old backend keeps calling them).
select
  (select max(version) from supabase_migrations.schema_migrations)                          as ledger_head,
  (select count(*) from supabase_migrations.schema_migrations where version >= '20260927')  as pending,
  md5(pg_get_functiondef('public.apply_synced_transaction_batch(uuid, jsonb, jsonb)'::regprocedure))         as old_batch_rpc_md5,
  md5(pg_get_functiondef('public.delete_transactions_and_restore_loan_balances(uuid, text[])'::regprocedure)) as old_delete_rpc_md5;

-- PREFLIGHT 2 (informational, keep the output): the exposure — pending rows and how many carry state
-- a posting would otherwise lose.
select
  count(*)                                                        as pending_rows,
  count(*) filter (where budget_category_id is not null)          as with_category,
  count(*) filter (where not needs_review)                        as approved,
  count(*) filter (where manual_loan_id is not null)              as loan_linked,
  count(*) filter (where exists (select 1 from public.transaction_splits s where s.transaction_id = t.id)) as with_splits
from public.transactions t
where t.pending;

-- PREFLIGHT 3 (informational): uncategorised rows per Plaid category — what a future mapping backfill
-- could fill. None can carry a 'user' label yet.
select category, count(*) from public.transactions where budget_category_id is null group by category order by 2 desc;

-- POSTFLIGHT 1 (after `supabase db push`). Expected: ledger_head = 20260927120000, columns = 6,
-- functions = 5, trigger_fn_locked = true, trigger = true, carryovers = 0, client_table_access = false,
-- service_role_table_privileges = {DELETE,INSERT,SELECT,UPDATE}, rls_enabled = true, policies = 0,
-- sequence_client_access = false, and the two md5 values identical to PREFLIGHT 1.
select
  (select max(version) from supabase_migrations.schema_migrations)                          as ledger_head,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'transactions'
      and column_name in ('pending_transaction_id', 'posted_from_pending_amount', 'review_note',
                          'budget_category_source', 'budget_category_set_seq', 'user_role_override_at')) as columns,
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('apply_synced_transaction_batch_v2', 'set_transaction_budget_category', 'approve_transaction',
                        'replace_transaction_splits', 'backfill_category_mapping')
      and not p.prosecdef
      and p.proconfig = array['search_path=""']
      and has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('public', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute'))                   as functions,
  (select not has_function_privilege('service_role', p.oid, 'execute')
      and not has_function_privilege('authenticated', p.oid, 'execute')
      and not has_function_privilege('anon', p.oid, 'execute')
      and not has_function_privilege('public', p.oid, 'execute')
      and not p.prosecdef and p.proconfig = array['search_path=""']
    from pg_proc p where p.oid = 'public.transactions_keep_user_cleared_category()'::regprocedure) as trigger_fn_locked,
  exists (select 1 from pg_trigger where tgrelid = 'public.transactions'::regclass
          and tgname = 'transactions_keep_user_cleared_category' and tgenabled = 'O')       as trigger,
  (select count(*) from public.transaction_carryovers)                                      as carryovers,
  exists (select 1 from unnest(array['anon', 'authenticated']) r(role),
                        unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain']) pr(priv)
          where has_table_privilege(r.role, 'public.transaction_carryovers', pr.priv))      as client_table_access,
  (select array_agg(privilege_type order by privilege_type) from information_schema.table_privileges
    where table_schema = 'public' and table_name = 'transaction_carryovers' and grantee = 'service_role') as service_role_table_privileges,
  (select relrowsecurity from pg_class where oid = 'public.transaction_carryovers'::regclass) as rls_enabled,
  (select count(*) from pg_policy where polrelid = 'public.transaction_carryovers'::regclass) as policies,
  (has_sequence_privilege('anon', 'public.transactions_budget_category_seq', 'usage')
   or has_sequence_privilege('authenticated', 'public.transactions_budget_category_seq', 'usage')) as sequence_client_access,
  md5(pg_get_functiondef('public.apply_synced_transaction_batch(uuid, jsonb, jsonb)'::regprocedure))         as old_batch_rpc_md5,
  md5(pg_get_functiondef('public.delete_transactions_and_restore_loan_balances(uuid, text[])'::regprocedure)) as old_delete_rpc_md5;

-- AFTER THE SMOKE TEST (a Sandbox pending transaction categorised, cleared, re-categorised and
-- approved, then posted): the posted row and its consumed carry-over. Replace <pending plaid id>.
select id, amount, pending, pending_transaction_id, posted_from_pending_amount, budget_category_id,
       budget_category_source, needs_review, review_note
from public.transactions where pending_transaction_id = '<pending plaid id>';
select pending_plaid_transaction_id, pending_amount, budget_category_id, budget_category_source, needs_review,
       removed_at, consumed_at, consumed_by_transaction_id is not null as consumed
from public.transaction_carryovers where pending_plaid_transaction_id = '<pending plaid id>';
