-- 20260922120000_restrict_plaid_items_client_access.sql: no browser client can retrieve Plaid
-- credential material, by any column, row, join, view or function; the backend's service role still can.

-- ---- Catalog state ------------------------------------------------------------------------------
select th.assert(not exists (
  select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
  cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
  where has_table_privilege(r.role, 'public.plaid_items', p.priv)),
  'no table privilege on plaid_items for PUBLIC/anon/authenticated');

select th.assert(not exists (
  select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
  cross join pg_attribute a
  cross join (values ('select'), ('insert'), ('update'), ('references')) p(priv)
  where a.attrelid = 'public.plaid_items'::regclass and a.attnum > 0 and not a.attisdropped
    and has_column_privilege(r.role, 'public.plaid_items', a.attname, p.priv)),
  'no column privilege on any plaid_items column for PUBLIC/anon/authenticated');

select th.assert(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'plaid_items'),
  'the obsolete owner-select policy is gone and no other policy exists');
select th.assert((select relrowsecurity from pg_class where oid = 'public.plaid_items'::regclass),
  'row level security stays enabled');

-- No indirect route: no view over plaid_items a client can read, and no client-executable function
-- that mentions it (SECURITY DEFINER or not).
select th.assert(not exists (
  select 1 from information_schema.view_table_usage v
  where v.table_schema = 'public' and v.table_name = 'plaid_items'
    and (has_table_privilege('anon', format('%I.%I', v.view_schema, v.view_name), 'select')
         or has_table_privilege('authenticated', format('%I.%I', v.view_schema, v.view_name), 'select'))),
  'no client-readable view over plaid_items');
select th.assert(not exists (
  select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.prosrc ilike '%plaid_items%'
    and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
  'no client-executable function references plaid_items');

-- ---- Runtime: exactly how PostgREST runs a request made with the anon key + the OWNER's JWT -----
begin;
set local role authenticated;
-- Both forms: newer PostgREST sets request.jwt.claims; this image's auth.uid() reads the legacy
-- per-claim setting.
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa';
select th.assert(auth.uid() = '00000000-0000-0000-0000-0000000000aa', 'harness sanity: auth.uid() is the owner');
select th.expect_error($q$ select * from public.plaid_items $q$, '%permission denied for table plaid_items%');
select th.expect_error($q$ select access_token from public.plaid_items where user_id = auth.uid() $q$, '%permission denied for table plaid_items%');
select th.expect_error($q$ select access_token_ciphertext, access_token_nonce, access_token_auth_tag, access_token_key_id from public.plaid_items $q$, '%permission denied for table plaid_items%');
select th.expect_error($q$ select id from public.plaid_items $q$, '%permission denied for table plaid_items%');
select th.expect_error($q$ select pi.access_token from public.accounts a join public.plaid_items pi on pi.id = a.item_id $q$, '%permission denied for table plaid_items%');
select th.expect_error($q$ insert into public.plaid_items (user_id, plaid_item_id, access_token) values (auth.uid(), 'x', 'y') $q$, '%permission denied for table plaid_items%');
select th.expect_error($q$ update public.plaid_items set status = 'active' where user_id = auth.uid() $q$, '%permission denied for table plaid_items%');
select th.expect_error($q$ delete from public.plaid_items where user_id = auth.uid() $q$, '%permission denied for table plaid_items%');
rollback;

begin;
set local role anon;
select th.expect_error($q$ select * from public.plaid_items $q$, '%permission denied for table plaid_items%');
select th.expect_error($q$ select access_token from public.plaid_items $q$, '%permission denied for table plaid_items%');
rollback;

-- ---- The backend's service role is unaffected ---------------------------------------------------
begin;
set local role service_role;
select th.assert((select count(*) from public.plaid_items) = 2, 'service_role reads every row');
select th.assert((select access_token_key_id from public.plaid_items where id = '00000000-0000-0000-0000-000000000001') = 'HARNESS_KEY',
  'service_role reads the credential columns');
insert into public.plaid_items (user_id, plaid_item_id, access_token)
  values ('00000000-0000-0000-0000-0000000000aa', 'harness-item-c', 'placeholder-plaintext-token-c');
update public.plaid_items set transactions_cursor = 'cursor-1', status = 'login_required'
  where id = '00000000-0000-0000-0000-000000000001';
select th.assert((select status from public.plaid_items where id = '00000000-0000-0000-0000-000000000001') = 'login_required',
  'service_role updates status and cursor');
rollback;
