-- 20260926120000_linked_institution_management.sql: plaid_item_removals and the removal functions
-- are service-role only; the operation record can never hold a token; the status backstop holds.

-- ---- Catalog state ------------------------------------------------------------------------------
select th.assert(not exists (
  select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
  cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
  where has_table_privilege(r.role, 'public.plaid_item_removals', p.priv)),
  'no table privilege of any kind, MAINTAIN included, for PUBLIC/anon/authenticated');
select th.assert(not exists (
  select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
  cross join pg_attribute a
  cross join (values ('select'), ('insert'), ('update'), ('references')) p(priv)
  where a.attrelid = 'public.plaid_item_removals'::regclass and a.attnum > 0 and not a.attisdropped
    and has_column_privilege(r.role, 'public.plaid_item_removals', a.attname, p.priv)),
  'no column privilege for PUBLIC/anon/authenticated');
select th.assert((select array_agg(p.priv order by p.priv)
                  from (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
                  where has_table_privilege('service_role', 'public.plaid_item_removals', p.priv)) = array['insert', 'select'],
  'service_role table privileges: exactly SELECT and INSERT (no DELETE: the record is permanent)');
select th.assert((select array_agg(a.attname::text order by a.attname) from pg_attribute a
                  where a.attrelid = 'public.plaid_item_removals'::regclass and a.attnum > 0 and not a.attisdropped
                    and has_column_privilege('service_role', 'public.plaid_item_removals', a.attname, 'update'))
                 = array['attempts', 'cleaned_at', 'deleted_counts', 'last_attempt_at', 'last_error_code', 'last_outcome', 'loan_adjustments',
                         'plaid_outcome', 'plaid_removed_at', 'reconciled_at', 'status'],
  'service_role may UPDATE only the lifecycle columns — never user_id, item_id, plaid_item_id, status_before or preview_digest');
select th.assert(not exists (select 1 from pg_attribute a where a.attrelid = 'public.plaid_item_removals'::regclass
                             and a.attnum > 0 and not a.attisdropped and (a.attname like '%token%' or a.attname like '%secret%')),
  'no token or secret column');
select th.assert((select relrowsecurity from pg_class where oid = 'public.plaid_item_removals'::regclass), 'row level security enabled');
select th.assert(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'plaid_item_removals'), 'no policies');
select th.assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.proname in ('plaid_item_removal_digest', 'plaid_item_removal_blocker', 'preview_plaid_item_removal', 'begin_plaid_item_removal',
                                      'record_plaid_item_removal_attempt', 'remove_plaid_item_local', 'mark_plaid_item_removal_reconciled')
                    and not p.prosecdef
                    and p.proconfig = array['search_path=""']
                    and not has_function_privilege('public', p.oid, 'execute')
                    and not has_function_privilege('anon', p.oid, 'execute')
                    and not has_function_privilege('authenticated', p.oid, 'execute')
                    and has_function_privilege('service_role', p.oid, 'execute')) = 7,
  'all seven removal functions: security invoker, search_path pinned empty, executable by service_role only');
select th.assert((select not p.prosecdef and p.proconfig = array['search_path=""']
                    and not has_function_privilege('anon', p.oid, 'execute') and not has_function_privilege('authenticated', p.oid, 'execute')
                  from pg_proc p where p.oid = 'public.plaid_items_keep_removing()'::regprocedure),
  'the backstop trigger function is not callable by clients');
-- The new plaid_items columns stay as locked down as the rest of the table (20260922120000).
select th.assert(not exists (
  select 1 from (values ('anon'), ('authenticated')) r(role)
  cross join (values ('consent_expires_at'), ('last_synced_at'), ('status')) c(col)
  cross join (values ('select'), ('insert'), ('update'), ('references')) p(priv)
  where has_column_privilege(r.role, 'public.plaid_items', c.col, p.priv)),
  'clients have no privilege on plaid_items.status / consent_expires_at / last_synced_at');

-- ---- Clients are refused at runtime -------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa';
select th.expect_error($q$ select public.preview_plaid_item_removal(auth.uid(), '00000000-0000-0000-0000-000000000001') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.plaid_item_removal_digest(auth.uid(), '00000000-0000-0000-0000-000000000001') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.plaid_item_removal_blocker(auth.uid(), '00000000-0000-0000-0000-000000000001') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.begin_plaid_item_removal(auth.uid(), '00000000-0000-0000-0000-000000000001', 'x') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.record_plaid_item_removal_attempt(auth.uid(), '00000000-0000-0000-0000-000000000001', 'removed', null) $q$, '%permission denied for function%');
select th.expect_error($q$ select public.remove_plaid_item_local(auth.uid(), '00000000-0000-0000-0000-000000000001') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.mark_plaid_item_removal_reconciled(auth.uid(), '00000000-0000-0000-0000-000000000001') $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.plaid_item_removals $q$, '%permission denied for table%');
rollback;
begin;
set local role anon;
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001') $q$,
  '%permission denied for function%');
select th.expect_error($q$ select * from public.plaid_item_removals $q$, '%permission denied for table%');
rollback;

-- ---- service_role cannot bypass the record's immutable columns or delete it ---------------------
set role service_role;
select public.begin_plaid_item_removal('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001',
  public.plaid_item_removal_digest('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001'));
select th.expect_error($q$ update public.plaid_item_removals set user_id = '00000000-0000-0000-0000-0000000000bb' $q$, '%permission denied%');
select th.expect_error($q$ update public.plaid_item_removals set preview_digest = 'x' $q$, '%permission denied%');
select th.expect_error($q$ delete from public.plaid_item_removals $q$, '%permission denied%');
-- The row-level checks reject impossible states even from the service role.
select th.expect_error($q$ update public.plaid_item_removals set status = 'cleaned' $q$, '%plaid_item_removals%check%');
select th.expect_error($q$ update public.plaid_item_removals set reconciled_at = now() $q$, '%plaid_item_removals%check%');
-- The status backstop fires for the service role (the backend's own writers) too.
update public.plaid_items set status = 'active' where id = '00000000-0000-0000-0000-000000000001';
select th.assert((select status from public.plaid_items where id = '00000000-0000-0000-0000-000000000001') = 'removing',
  'service_role cannot take an item out of removing');
-- Every other transition stays an ordinary update (the backend's conditional writes govern them).
update public.plaid_items set status = 'permission_revoked' where id = '00000000-0000-0000-0000-000000000002';
update public.plaid_items set status = 'active' where id = '00000000-0000-0000-0000-000000000002';
select th.assert((select status from public.plaid_items where id = '00000000-0000-0000-0000-000000000002') = 'active',
  'the backstop affects only removing');

-- ---- Every status fixes exactly which lifecycle fields are set -----------------------------------
-- Written directly as the table owner (bypassing the functions) — none of these may ever be stored.
reset role;
create function pg_temp.bad(p_cols text, p_vals text) returns void language plpgsql as $f$
begin
  execute format('insert into public.plaid_item_removals (user_id, item_id, plaid_item_id, status_before, preview_digest, %s)
                  values (''00000000-0000-0000-0000-0000000000aa'', gen_random_uuid(), ''x'', ''active'', ''d'', %s)', p_cols, p_vals);
end $f$;
select th.expect_error($q$ select pg_temp.bad('status, plaid_removed_at', $$'requested', now()$$) $q$, '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, plaid_outcome', $$'requested', 'removed'$$) $q$, '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, cleaned_at', $$'requested', now()$$) $q$, '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, loan_adjustments', $$'requested', '[]'$$) $q$, '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, deleted_counts', $$'requested', '{}'$$) $q$, '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, reconciled_at', $$'requested', now()$$) $q$, '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, plaid_removed_at', $$'plaid_removed', now()$$) $q$, '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, plaid_outcome', $$'plaid_removed', 'removed'$$) $q$, '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, plaid_outcome, plaid_removed_at, cleaned_at', $$'plaid_removed', 'removed', now(), now()$$) $q$,
  '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, plaid_outcome, plaid_removed_at, loan_adjustments', $$'plaid_removed', 'removed', now(), '[]'$$) $q$,
  '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, plaid_outcome, plaid_removed_at, reconciled_at', $$'plaid_removed', 'removed', now(), now()$$) $q$,
  '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, plaid_outcome, plaid_removed_at, last_outcome', $$'plaid_removed', 'removed', now(), 'retryable'$$) $q$,
  '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, plaid_outcome, plaid_removed_at, cleaned_at, deleted_counts', $$'cleaned', 'removed', now(), now(), '{}'$$) $q$,
  '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, cleaned_at, loan_adjustments, deleted_counts', $$'cleaned', now(), '[]', '{}'$$) $q$,
  '%plaid_item_removals_state_check%');
select th.expect_error($q$ select pg_temp.bad('status, plaid_outcome, plaid_removed_at, cleaned_at, loan_adjustments, deleted_counts',
  $$'cleaned', 'removed', now(), now(), '{}', '{}'$$) $q$, '%plaid_item_removals_result_shape_check%');
select th.expect_error($q$ select pg_temp.bad('status, plaid_outcome, plaid_removed_at, cleaned_at, loan_adjustments, deleted_counts',
  $$'cleaned', 'removed', now(), now() - interval '1 hour', '[]', '{}'$$) $q$, '%plaid_item_removals_order_check%');
select th.expect_error($q$ select pg_temp.bad('status', $$'bogus'$$) $q$, '%violates check constraint "plaid_item_removals_%');
-- ...and every valid shape is accepted.
select pg_temp.bad('status', $$'requested'$$);
select pg_temp.bad('status, last_outcome, last_error_code, attempts', $$'requested', 'needs_attention', 'INVALID_ACCESS_TOKEN', 2$$);
select pg_temp.bad('status, plaid_outcome, plaid_removed_at', $$'plaid_removed', 'already_removed', now()$$);
select pg_temp.bad('status, plaid_outcome, plaid_removed_at, cleaned_at, loan_adjustments, deleted_counts, reconciled_at',
  $$'cleaned', 'removed', now(), now(), '[]', '{}', now()$$);
