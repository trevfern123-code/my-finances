-- 20260922130000_plaid_link_attempts.sql: service-role-only, bound to user AND login session,
-- one-time, expiring, and bounded.

-- ---- Catalog state ------------------------------------------------------------------------------
select th.assert((select string_agg(privilege_type, ',' order by privilege_type) from information_schema.role_table_grants
                  where table_schema = 'public' and table_name = 'plaid_link_attempts' and grantee = 'service_role') = 'DELETE,INSERT,SELECT',
  'plaid_link_attempts: service_role has exactly SELECT, INSERT, DELETE');
select th.assert(not exists (select 1 from information_schema.role_table_grants
                             where table_schema = 'public' and table_name = 'plaid_link_attempts'
                               and grantee in ('PUBLIC', 'anon', 'authenticated')),
  'plaid_link_attempts: no grant to PUBLIC/anon/authenticated');
select th.assert((select relrowsecurity from pg_class where oid = 'public.plaid_link_attempts'::regclass),
  'plaid_link_attempts: row level security enabled');
select th.assert(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'plaid_link_attempts'),
  'plaid_link_attempts: no policies');
select th.assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname in ('create_plaid_link_attempt', 'consume_plaid_link_attempt')
                    and not p.prosecdef
                    and p.proconfig = array['search_path=""']
                    and not has_function_privilege('public', p.oid, 'execute')
                    and not has_function_privilege('anon', p.oid, 'execute')
                    and not has_function_privilege('authenticated', p.oid, 'execute')
                    and has_function_privilege('service_role', p.oid, 'execute')) = 2,
  'both functions: security invoker, search_path pinned empty, executable by service_role only');

-- ---- Clients are refused at runtime -------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa';
select th.expect_error($q$ select public.create_plaid_link_attempt(auth.uid(), 'sid-a') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.consume_plaid_link_attempt(gen_random_uuid(), auth.uid(), 'sid-a') $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.plaid_link_attempts $q$, '%permission denied for table%');
select th.expect_error($q$ insert into public.plaid_link_attempts (user_id, session_id, expires_at) values (auth.uid(), 's', now() + interval '1 hour') $q$, '%permission denied for table%');
rollback;
begin;
set local role anon;
select th.expect_error($q$ select public.create_plaid_link_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a') $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.plaid_link_attempts $q$, '%permission denied for table%');
rollback;

-- ---- Behaviour, as the backend's service role ---------------------------------------------------
set role service_role;

create temporary table t(attempt_id uuid);
insert into t select public.create_plaid_link_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert((select expires_at - created_at from public.plaid_link_attempts where id = (select attempt_id from t)) = interval '30 minutes',
  'an attempt lives for 30 minutes');

-- A different user, or the same user in a different login session, cannot spend it — and does not
-- destroy it either.
select th.assert(public.consume_plaid_link_attempt((select attempt_id from t), '00000000-0000-0000-0000-0000000000bb', 'sid-a') = 'invalid',
  'another user presenting the attempt id: invalid');
select th.assert(public.consume_plaid_link_attempt((select attempt_id from t), '00000000-0000-0000-0000-0000000000aa', 'sid-a-relogin') = 'invalid',
  'the same user in a different login session: invalid');
select th.assert(exists (select 1 from public.plaid_link_attempts where id = (select attempt_id from t)),
  'the rightful owner''s attempt survives foreign consume attempts');

-- The owner, in the originating session, consumes it exactly once.
select th.assert(public.consume_plaid_link_attempt((select attempt_id from t), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'consumed',
  'owner + originating session: consumed');
select th.assert(public.consume_plaid_link_attempt((select attempt_id from t), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'invalid',
  'replay: invalid');
select th.assert(not exists (select 1 from public.plaid_link_attempts where id = (select attempt_id from t)), 'consumed attempt is gone');

select th.assert(public.consume_plaid_link_attempt(gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'invalid',
  'unknown attempt id: invalid');
select th.assert(public.consume_plaid_link_attempt(null, '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'invalid',
  'null attempt id: invalid');

-- Expired: reported as such, and deleted so it can never be retried.
insert into public.plaid_link_attempts (id, user_id, session_id, created_at, expires_at) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '1 hour', now() - interval '30 minutes');
select th.assert(public.consume_plaid_link_attempt('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'expired',
  'expired attempt: expired');
select th.assert(public.consume_plaid_link_attempt('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'invalid',
  'expired attempt cannot be retried');

-- Bounded: creating removes the user's expired attempts and keeps at most five live ones; another
-- user's attempts are never touched.
insert into public.plaid_link_attempts (id, user_id, session_id, created_at, expires_at) values
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '1 hour', now() - interval '30 minutes'),
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-0000000000bb', 'sid-b', now() - interval '1 hour', now() - interval '30 minutes');
insert into public.plaid_link_attempts (user_id, session_id, created_at, expires_at)
  select '00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - make_interval(secs => g), now() + interval '10 minutes'
  from generate_series(1, 6) g;
select public.create_plaid_link_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert(not exists (select 1 from public.plaid_link_attempts where id = '00000000-0000-0000-0000-00000000e002'),
  'creating removed the user''s expired attempt');
select th.assert((select count(*) from public.plaid_link_attempts where user_id = '00000000-0000-0000-0000-0000000000aa') = 5,
  'at most five live attempts per user');
select th.assert(exists (select 1 from public.plaid_link_attempts where id = '00000000-0000-0000-0000-00000000e003'),
  'another user''s rows are untouched');

-- A user and a login session are required.
select th.expect_error($q$ select public.create_plaid_link_attempt('00000000-0000-0000-0000-0000000000aa', ' ') $q$, '%a user and a login session are required%');
select th.expect_error($q$ select public.create_plaid_link_attempt('00000000-0000-0000-0000-0000000000aa', null) $q$, '%a user and a login session are required%');
select th.expect_error($q$ select public.create_plaid_link_attempt(null, 'sid-a') $q$, '%a user and a login session are required%');
reset role;
