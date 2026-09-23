-- 20260922130000_plaid_link_attempts.sql: service-role-only Hosted Link attempts, bound to user AND
-- login session, claimable exactly once, expiring, bounded, and never advanced by a webhook.

-- ---- Catalog state ------------------------------------------------------------------------------
-- has_table_privilege / has_column_privilege, not information_schema, so PostgreSQL 17's MAINTAIN is
-- covered too.
select th.assert(not exists (
  select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
  cross join (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
  where has_table_privilege(r.role, 'public.plaid_link_attempts', p.priv)),
  'no table privilege of any kind, MAINTAIN included, for PUBLIC/anon/authenticated');
select th.assert(not exists (
  select 1 from (values ('public'), ('anon'), ('authenticated')) r(role)
  cross join pg_attribute a
  cross join (values ('select'), ('insert'), ('update'), ('references')) p(priv)
  where a.attrelid = 'public.plaid_link_attempts'::regclass and a.attnum > 0 and not a.attisdropped
    and has_column_privilege(r.role, 'public.plaid_link_attempts', a.attname, p.priv)),
  'no column privilege for PUBLIC/anon/authenticated');
select th.assert((select array_agg(p.priv order by p.priv)
                  from (values ('select'), ('insert'), ('update'), ('delete'), ('truncate'), ('references'), ('trigger'), ('maintain')) p(priv)
                  where has_table_privilege('service_role', 'public.plaid_link_attempts', p.priv)) = array['delete', 'insert', 'select'],
  'service_role table privileges: exactly SELECT, INSERT, DELETE (no table-wide UPDATE/TRUNCATE/REFERENCES/TRIGGER/MAINTAIN)');
select th.assert((select array_agg(a.attname::text order by a.attname) from pg_attribute a
                  where a.attrelid = 'public.plaid_link_attempts'::regclass and a.attnum > 0 and not a.attisdropped
                    and has_column_privilege('service_role', 'public.plaid_link_attempts', a.attname, 'update'))
                 = array['claimed_at', 'finished_at', 'link_token_auth_tag', 'link_token_ciphertext', 'link_token_enc_version',
                         'link_token_key_id', 'link_token_nonce', 'plaid_item_id', 'ready_at', 'ready_status', 'status'],
  'service_role may UPDATE only the lifecycle columns — never id, user_id, session_id, created_at, expires_at or link_token_hash');
select th.assert((select relrowsecurity from pg_class where oid = 'public.plaid_link_attempts'::regclass), 'row level security enabled');
select th.assert(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'plaid_link_attempts'), 'no policies');
select th.assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.proname in ('purge_expired_plaid_link_attempts', 'create_plaid_link_attempt', 'read_plaid_link_attempt',
                                      'claim_plaid_link_attempt', 'finish_plaid_link_attempt', 'mark_plaid_link_attempt_ready')
                    and not p.prosecdef
                    and p.proconfig = array['search_path=""']
                    and not has_function_privilege('public', p.oid, 'execute')
                    and not has_function_privilege('anon', p.oid, 'execute')
                    and not has_function_privilege('authenticated', p.oid, 'execute')
                    and has_function_privilege('service_role', p.oid, 'execute')) = 6,
  'all six functions: security invoker, search_path pinned empty, executable by service_role only');
select th.assert(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname = 'public' and p.proname = 'consume_plaid_link_attempt'),
  'the pre-Hosted-Link consume function does not exist');

-- ---- Clients are refused at runtime -------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa';
select th.expect_error($q$ select public.create_plaid_link_attempt(gen_random_uuid(), auth.uid(), 'sid-a', repeat('a', 64), 'c', 'n', 't', 'k', 1::smallint) $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.read_plaid_link_attempt(gen_random_uuid(), auth.uid(), 'sid-a') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.claim_plaid_link_attempt(gen_random_uuid(), auth.uid(), 'sid-a') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.finish_plaid_link_attempt(gen_random_uuid(), auth.uid(), 'sid-a', 'failed', null) $q$, '%permission denied for function%');
select th.expect_error($q$ select public.mark_plaid_link_attempt_ready(repeat('a', 64), 'SUCCESS') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.purge_expired_plaid_link_attempts(100) $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.plaid_link_attempts $q$, '%permission denied for table%');
select th.expect_error($q$ select link_token_ciphertext from public.plaid_link_attempts $q$, '%permission denied for table%');
rollback;
begin;
set local role anon;
select th.expect_error($q$ select public.claim_plaid_link_attempt(gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', 'sid-a') $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.plaid_link_attempts $q$, '%permission denied for table%');
rollback;

-- ---- Behaviour, as the backend's service role ---------------------------------------------------
set role service_role;
create temporary table t(name text primary key, id uuid);

insert into t select 'a1', th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert((select expires_at - created_at from public.plaid_link_attempts where id = (select id from t where name = 'a1')) = interval '30 minutes',
  'an attempt lives for 30 minutes (matching the Hosted Link URL lifetime)');
select th.assert((select status from public.plaid_link_attempts where id = (select id from t where name = 'a1')) = 'pending', 'new attempts are pending');

-- read: only the owner, in the originating session, sees it.
select th.assert((select count(*) from public.read_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a')) = 1, 'owner reads it');
select th.assert((select not expired and status = 'pending' and link_token_ciphertext is not null
                  from public.read_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a')),
  'owner sees it pending, unexpired, with its encrypted link token');
select th.assert((select count(*) from public.read_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000bb', 'sid-a')) = 0, 'another user reads nothing');
select th.assert((select count(*) from public.read_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a2')) = 0, 'same user, another login, reads nothing');

-- claim: foreign user/session cannot claim — and leave it untouched.
select th.assert(public.claim_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000bb', 'sid-a') = 'invalid', 'foreign user: invalid');
select th.assert(public.claim_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a2') = 'invalid', 'foreign session: invalid');
select th.assert((select status from public.plaid_link_attempts where id = (select id from t where name = 'a1')) = 'pending', 'still pending after foreign claims');
select th.assert(public.claim_plaid_link_attempt(gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'invalid', 'unknown id: invalid');
select th.assert(public.claim_plaid_link_attempt(null, '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'invalid', 'null id: invalid');

-- The owner claims exactly once; every later claim reports the state and claims nothing.
select th.assert(public.claim_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'claimed', 'owner claims');
select th.assert(public.claim_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'completing', 'duplicate claim while exchanging: completing');
select th.assert(not public.finish_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000bb', 'sid-a', 'completed', gen_random_uuid()),
  'another user cannot finish it');
select th.assert(public.finish_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', 'completed', '00000000-0000-0000-0000-00000000c0de'),
  'the claimer finishes it as completed');
select th.assert((select status = 'completed' and plaid_item_id = '00000000-0000-0000-0000-00000000c0de' and link_token_ciphertext is null
                         and link_token_nonce is null and link_token_auth_tag is null and link_token_key_id is null and link_token_enc_version is null
                  from public.plaid_link_attempts where id = (select id from t where name = 'a1')),
  'completed: item recorded, stored link token erased');
select th.assert(public.claim_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'completed', 'replay: completed, nothing claimed');
select th.assert(not public.finish_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', 'completed', gen_random_uuid()),
  'a completed attempt cannot be completed again');
select th.assert(not public.finish_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', 'failed', null),
  'a completed attempt cannot be failed afterwards');

-- Exited / ambiguous: pending -> failed, erased, never claimable.
insert into t select 'a2', th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert(not public.finish_plaid_link_attempt((select id from t where name = 'a2'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', 'completed', gen_random_uuid()),
  'a pending attempt cannot be completed without being claimed');
select th.assert(public.finish_plaid_link_attempt((select id from t where name = 'a2'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', 'failed', null), 'pending -> failed');
select th.assert(public.claim_plaid_link_attempt((select id from t where name = 'a2'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'failed', 'failed: never claimable');
select th.assert((select link_token_ciphertext is null from public.plaid_link_attempts where id = (select id from t where name = 'a2')), 'failed: link token erased');

-- A claimer whose exchange failed before storing an item: completing -> failed.
insert into t select 'a3', th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select public.claim_plaid_link_attempt((select id from t where name = 'a3'), '00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert(public.finish_plaid_link_attempt((select id from t where name = 'a3'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', 'failed', null), 'completing -> failed');

-- Expired: reported, never claimable, state untouched.
insert into t select 'e1', th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '40 minutes', now() - interval '10 minutes');
select th.assert((select expired from public.read_plaid_link_attempt((select id from t where name = 'e1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a')), 'read reports it expired');
select th.assert(public.claim_plaid_link_attempt((select id from t where name = 'e1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'expired', 'expired: not claimable');
select th.assert((select status from public.plaid_link_attempts where id = (select id from t where name = 'e1')) = 'pending', 'expired claim changed nothing');

-- Webhook readiness: recorded once, informational only.
insert into t select 'w1', th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert(public.mark_plaid_link_attempt_ready(th.attempt_token_hash((select id from t where name = 'w1')), 'success'), 'first delivery records readiness');
select th.assert(not public.mark_plaid_link_attempt_ready(th.attempt_token_hash((select id from t where name = 'w1')), 'EXITED'), 'duplicate delivery changes nothing');
select th.assert((select ready_at is not null and ready_status = 'SUCCESS' and status = 'pending' and claimed_at is null
                  from public.plaid_link_attempts where id = (select id from t where name = 'w1')),
  'readiness never claims, completes or changes status');
select th.assert(not public.mark_plaid_link_attempt_ready(repeat('0', 64), 'SUCCESS'), 'unknown token: no-op');
select th.assert(not public.mark_plaid_link_attempt_ready('not-a-hash', 'SUCCESS'), 'malformed hash: no-op');
select th.assert(not public.mark_plaid_link_attempt_ready(null, 'SUCCESS'), 'null hash: no-op');
select th.assert(public.claim_plaid_link_attempt((select id from t where name = 'w1'), '00000000-0000-0000-0000-0000000000bb', 'sid-b') = 'invalid',
  'a ready attempt is still bound to its own user and session');

-- Row constraints: a live row must carry its token; a finished one must not.
select th.expect_error($q$ insert into public.plaid_link_attempts (id, user_id, session_id, expires_at, link_token_hash)
                          values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', 's', now() + interval '1 minute', repeat('b', 64)) $q$,
                       '%violates check constraint%');
select th.expect_error($q$ update public.plaid_link_attempts set status = 'failed' where id = (select id from t where name = 'w1') $q$,
                       '%violates check constraint%');
select th.expect_error($q$ select public.finish_plaid_link_attempt((select id from t where name = 'w1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', 'completed', null) $q$,
                       '%needs its plaid item id%');
select th.expect_error($q$ select public.finish_plaid_link_attempt((select id from t where name = 'w1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', 'done', null) $q$,
                       '%outcome must be completed or failed%');

-- Bounded per user: at most five live pending attempts; finished ones are not counted or removed.
delete from public.plaid_link_attempts;
select th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - make_interval(secs => g), now() + interval '10 minutes')
  from generate_series(1, 6) g;
select th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '20 minutes', now() + interval '10 minutes', 'completed');
select th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert((select count(*) from public.plaid_link_attempts
                  where user_id = '00000000-0000-0000-0000-0000000000aa' and status = 'pending' and expires_at > now()) = 5,
  'at most five live pending attempts per user');
select th.assert((select count(*) from public.plaid_link_attempts where status = 'completed') = 1, 'the completed attempt was kept');

-- Global, bounded sweep an hour after expiry: ANY user's create or claim removes up to 100 of
-- ANYONE's long-expired rows, oldest first, never a recently-expired or live one.
delete from public.plaid_link_attempts;
select th.insert_attempt('00000000-0000-0000-0000-0000000000bb', 'sid-b', now() - interval '3 hours', now() - interval '2 hours' - make_interval(secs => g))
  from generate_series(1, 150) g;
insert into t select 'recent', th.insert_attempt('00000000-0000-0000-0000-0000000000bb', 'sid-b', now() - interval '40 minutes', now() - interval '10 minutes');
insert into t select 'live', th.new_attempt('00000000-0000-0000-0000-0000000000bb', 'sid-b');
select th.assert((select count(*) from public.plaid_link_attempts where expires_at <= now() - interval '1 hour') = 50,
  'user bb''s own create swept 100 long-expired rows (bounded batch)');
insert into t select 'aa-live', th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert(not exists (select 1 from public.plaid_link_attempts where expires_at <= now() - interval '1 hour'),
  'user aa''s create swept the remaining 50 of user bb''s rows');
select th.assert(exists (select 1 from public.plaid_link_attempts where id = (select id from t where name = 'recent')),
  'a recently-expired row is kept for replay detection');
select th.assert(exists (select 1 from public.plaid_link_attempts where id = (select id from t where name = 'live')), 'live rows are never swept');
select th.insert_attempt('00000000-0000-0000-0000-0000000000bb', 'sid-b', now() - interval '3 hours', now() - interval '2 hours');
select public.claim_plaid_link_attempt((select id from t where name = 'aa-live'), '00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert(not exists (select 1 from public.plaid_link_attempts where expires_at <= now() - interval '1 hour'), 'a claim also sweeps');
select th.assert(public.purge_expired_plaid_link_attempts(100) = 0, 'nothing left to purge');
select th.expect_error($q$ select public.purge_expired_plaid_link_attempts(0) $q$, '%p_limit must be between 1 and 1000%');
select th.expect_error($q$ select public.purge_expired_plaid_link_attempts(1001) $q$, '%p_limit must be between 1 and 1000%');
select th.expect_error($q$ select public.purge_expired_plaid_link_attempts(null) $q$, '%p_limit must be between 1 and 1000%');

-- An id, a user and a login session are required.
select th.expect_error($q$ select th.new_attempt('00000000-0000-0000-0000-0000000000aa', ' ') $q$, '%an id, a user and a login session are required%');
select th.expect_error($q$ select th.new_attempt('00000000-0000-0000-0000-0000000000aa', null) $q$, '%an id, a user and a login session are required%');
select th.expect_error($q$ select th.new_attempt(null, 'sid-a') $q$, '%an id, a user and a login session are required%');
reset role;
