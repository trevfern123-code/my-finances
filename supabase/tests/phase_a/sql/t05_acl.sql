-- Security posture of every function and table the migration creates.
create temporary table expected_functions(name text primary key);
insert into expected_functions values
  ('apply_transaction_semantic_roles'), ('link_transaction_to_manual_loan'), ('unlink_transaction_from_manual_loan'),
  ('update_linked_payment_principal'), ('create_manual_loan_payment'), ('update_manual_loan_payment'),
  ('delete_manual_loan_payment'), ('delete_transactions_and_restore_loan_balances'), ('confirm_transfer_pair'),
  ('apply_synced_transaction_batch'), ('create_manual_loan_idempotent'), ('delete_manual_loan_atomic'),
  ('mark_manual_loan_deletion_reconciled');

select th.assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  join expected_functions e on e.name = p.proname where n.nspname = 'public') = 13, 'all 13 functions exist');

select th.assert(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace join expected_functions e on e.name = p.proname
  where n.nspname = 'public' and (
    p.prosecdef
    or p.proconfig is distinct from array['search_path=""']
    or has_function_privilege('public', p.oid, 'execute')
    or has_function_privilege('anon', p.oid, 'execute')
    or has_function_privilege('authenticated', p.oid, 'execute')
    or not has_function_privilege('service_role', p.oid, 'execute'))),
  'every function: security invoker, search_path pinned empty, executable by service_role only');

-- Effective table privileges via has_table_privilege, over every PostgreSQL 17 privilege.
-- information_schema.role_table_grants does not report MAINTAIN, so a MAINTAIN grant would have
-- slipped past a check built on it.
create function pg_temp.table_privileges(p_role text, p_table text) returns text language sql as $$
  select coalesce(string_agg(priv, ',' order by priv), '')
  from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN']) priv
  where has_table_privilege(p_role, p_table, priv)
$$;
select th.assert(pg_temp.table_privileges('service_role', 'public.manual_loan_creation_requests') = 'INSERT,SELECT',
  'manual_loan_creation_requests: service_role SELECT, INSERT only (no MAINTAIN either)');
select th.assert(pg_temp.table_privileges('service_role', 'public.manual_loan_deletions') = 'INSERT,SELECT,UPDATE',
  'manual_loan_deletions: service_role SELECT, INSERT, UPDATE only (no MAINTAIN either)');
select th.assert(not exists (select 1
                             from unnest(array['public', 'anon', 'authenticated']) r,
                                  unnest(array['public.manual_loan_creation_requests', 'public.manual_loan_deletions']) t
                             where pg_temp.table_privileges(r, t) <> ''),
  'no table privilege at all (MAINTAIN included) for PUBLIC/anon/authenticated');

-- Runtime refusal, not just catalog state.
set role authenticated;
select th.expect_error($q$ select public.delete_manual_loan_atomic('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1', '[]') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.apply_synced_transaction_batch('00000000-0000-0000-0000-0000000000aa', '[]', '[]') $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.manual_loan_deletions $q$, '%permission denied for table%');
reset role;
set role anon;
select th.expect_error($q$ select public.mark_manual_loan_deletion_reconciled('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000000d1') $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.manual_loan_creation_requests $q$, '%permission denied for table%');
reset role;
