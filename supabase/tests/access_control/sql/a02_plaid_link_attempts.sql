-- 20260922130000_plaid_link_attempts.sql: service-role-only Hosted Link attempts, bound to user AND
-- login session; claim -> begin exchange -> atomic store; stale recovery that never re-exchanges;
-- expiring, bounded, and never advanced by a webhook.

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
                 = array['claim_token', 'claimed_at', 'exchange_started_at', 'failure_reason', 'finished_at', 'link_token_auth_tag',
                         'link_token_ciphertext', 'link_token_enc_version', 'link_token_key_id', 'link_token_nonce', 'plaid_item_id',
                         'ready_at', 'ready_status', 'status'],
  'service_role may UPDATE only the lifecycle columns — never id, user_id, session_id, created_at, expires_at or link_token_hash');
select th.assert((select relrowsecurity from pg_class where oid = 'public.plaid_link_attempts'::regclass), 'row level security enabled');
select th.assert(not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'plaid_link_attempts'), 'no policies');
select th.assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public'
                    and p.proname in ('purge_expired_plaid_link_attempts', 'create_plaid_link_attempt', 'read_plaid_link_attempt',
                                      'claim_plaid_link_attempt', 'begin_plaid_link_exchange', 'store_plaid_link_item',
                                      'fail_plaid_link_attempt', 'mark_plaid_link_attempt_ready')
                    and not p.prosecdef
                    and p.proconfig = array['search_path=""']
                    and not has_function_privilege('public', p.oid, 'execute')
                    and not has_function_privilege('anon', p.oid, 'execute')
                    and not has_function_privilege('authenticated', p.oid, 'execute')
                    and has_function_privilege('service_role', p.oid, 'execute')) = 8,
  'all eight functions: security invoker, search_path pinned empty, executable by service_role only');
select th.assert(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname = 'public' and p.proname in ('consume_plaid_link_attempt', 'finish_plaid_link_attempt')),
  'superseded functions do not exist');

-- ---- Clients are refused at runtime -------------------------------------------------------------
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}';
set local request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000aa';
select th.expect_error($q$ select public.create_plaid_link_attempt(gen_random_uuid(), auth.uid(), 'sid-a', repeat('a', 64), 'c', 'n', 't', 'k', 1::smallint) $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.read_plaid_link_attempt(gen_random_uuid(), auth.uid(), 'sid-a') $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.claim_plaid_link_attempt(gen_random_uuid(), auth.uid(), 'sid-a') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.begin_plaid_link_exchange(gen_random_uuid(), auth.uid(), 'sid-a', gen_random_uuid()) $q$, '%permission denied for function%');
select th.expect_error($q$ select public.store_plaid_link_item(gen_random_uuid(), auth.uid(), 'sid-a', gen_random_uuid(), gen_random_uuid(), 'item', 'c', 'n', 't', 'k', 1::smallint) $q$, '%permission denied for function%');
select th.expect_error($q$ select public.fail_plaid_link_attempt(gen_random_uuid(), auth.uid(), 'sid-a', null, 'exited') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.mark_plaid_link_attempt_ready(repeat('a', 64), 'SUCCESS') $q$, '%permission denied for function%');
select th.expect_error($q$ select public.purge_expired_plaid_link_attempts(100) $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.plaid_link_attempts $q$, '%permission denied for table%');
rollback;
begin;
set local role anon;
select th.expect_error($q$ select * from public.claim_plaid_link_attempt(gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', 'sid-a') $q$, '%permission denied for function%');
select th.expect_error($q$ select * from public.plaid_link_attempts $q$, '%permission denied for table%');
rollback;

-- ---- Behaviour, as the backend's service role ---------------------------------------------------
set role service_role;
create temporary table t(name text primary key, id uuid, token uuid);
create function pg_temp.claim(p_id uuid, p_user uuid, p_session text) returns text language sql as
  $$ select outcome from public.claim_plaid_link_attempt(p_id, p_user, p_session) $$;

insert into t(name, id) select 'a1', th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert((select expires_at - created_at from public.plaid_link_attempts where id = (select id from t where name = 'a1')) = interval '30 minutes',
  'an attempt lives for 30 minutes (matching the Hosted Link URL lifetime)');

-- read: only the owner, in the originating session, sees it.
select th.assert((select not expired and not stale and status = 'pending' and link_token_ciphertext is not null
                  from public.read_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a')),
  'owner sees it pending, unexpired, not stale, with its encrypted link token');
select th.assert((select count(*) from public.read_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000bb', 'sid-a')) = 0, 'another user reads nothing');
select th.assert((select count(*) from public.read_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a2')) = 0, 'same user, another login, reads nothing');

-- claim: foreign user/session cannot claim, and leave it untouched.
select th.assert(pg_temp.claim((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000bb', 'sid-a') = 'invalid', 'foreign user: invalid');
select th.assert(pg_temp.claim((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a2') = 'invalid', 'foreign session: invalid');
select th.assert(pg_temp.claim(gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'invalid', 'unknown id: invalid');
select th.assert((select status from public.plaid_link_attempts where id = (select id from t where name = 'a1')) = 'pending', 'still pending after foreign claims');

-- The owner claims once and gets a token; a live claim cannot be taken over.
update t set token = (select claim_token from public.claim_plaid_link_attempt((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a'))
 where name = 'a1';
select th.assert((select token from t where name = 'a1') is not null and (select token from t where name = 'a1') = th.claim_token_of((select id from t where name = 'a1')),
  'owner claims and receives the stored claim token');
select th.assert(pg_temp.claim((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'in_progress', 'a live claim: in_progress');

-- begin exchange: only the claim holder; erases the link token.
select th.assert(not public.begin_plaid_link_exchange((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', gen_random_uuid()),
  'a wrong claim token cannot begin the exchange');
select th.assert(not public.begin_plaid_link_exchange((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000bb', 'sid-a', (select token from t where name = 'a1')),
  'another user cannot begin the exchange, even with the token');
select th.assert(public.begin_plaid_link_exchange((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', (select token from t where name = 'a1')),
  'the claim holder begins the exchange');
select th.assert((select status = 'exchanging' and exchange_started_at is not null and link_token_ciphertext is null
                  from public.plaid_link_attempts where id = (select id from t where name = 'a1')),
  'exchanging: recorded, link token erased');
select th.assert(not public.begin_plaid_link_exchange((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', (select token from t where name = 'a1')),
  'the exchange can be begun only once');
select th.assert(pg_temp.claim((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'in_progress', 'a fresh exchange: in_progress, never re-claimable');

-- store: atomic item insert + completion, claim holder only.
select th.assert(not public.store_plaid_link_item((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', gen_random_uuid(),
                   gen_random_uuid(), 'harness-item-x', 'Y2lwaGVy', 'bm9uY2U=', 'dGFn', 'HARNESS_KEY', 1::smallint),
  'a wrong claim token stores nothing');
select th.assert(not exists (select 1 from public.plaid_items where plaid_item_id = 'harness-item-x'), 'no item row from a refused store');
select th.assert(public.store_plaid_link_item((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', (select token from t where name = 'a1'),
                   '00000000-0000-0000-0000-00000000a1a1', 'harness-item-a1', 'Y2lwaGVy', 'bm9uY2U=', 'dGFn', 'HARNESS_KEY', 1::smallint),
  'the claim holder stores the item');
select th.assert((select user_id = '00000000-0000-0000-0000-0000000000aa' and access_token is null and access_token_ciphertext = 'Y2lwaGVy'
                         and access_token_key_id = 'HARNESS_KEY' and status = 'active'
                  from public.plaid_items where id = '00000000-0000-0000-0000-00000000a1a1'),
  'the stored item: the attempt''s own user, encrypted token only (no plaintext)');
select th.assert((select status = 'completed' and plaid_item_id = '00000000-0000-0000-0000-00000000a1a1' from public.plaid_link_attempts where id = (select id from t where name = 'a1')),
  'the attempt completed in the same call');
select th.assert(not public.store_plaid_link_item((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', (select token from t where name = 'a1'),
                   gen_random_uuid(), 'harness-item-a1-again', 'Y2lwaGVy', 'bm9uY2U=', 'dGFn', 'HARNESS_KEY', 1::smallint),
  'a completed attempt stores nothing more');
select th.assert(pg_temp.claim((select id from t where name = 'a1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'completed', 'replay: completed');

-- Atomicity: an insert that fails rolls the completion back too.
insert into t(name, id) select 'a2', th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
update t set token = (select claim_token from public.claim_plaid_link_attempt((select id from t where name = 'a2'), '00000000-0000-0000-0000-0000000000aa', 'sid-a')) where name = 'a2';
select public.begin_plaid_link_exchange((select id from t where name = 'a2'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', (select token from t where name = 'a2'));
select th.expect_error(format($q$ select public.store_plaid_link_item(%L, '00000000-0000-0000-0000-0000000000aa', 'sid-a', %L,
                                gen_random_uuid(), 'harness-item-a1', 'Y2lwaGVy', 'bm9uY2U=', 'dGFn', 'HARNESS_KEY', 1::smallint) $q$,
                              (select id from t where name = 'a2'), (select token from t where name = 'a2')),
                       '%plaid_items_plaid_item_id_key%');
select th.assert((select status from public.plaid_link_attempts where id = (select id from t where name = 'a2')) = 'exchanging',
  'a failed item insert leaves the attempt exchanging (the completion rolled back with it)');

-- fail: each reason only from the states it describes; claim token required after pending.
select th.assert(not public.fail_plaid_link_attempt((select id from t where name = 'a2'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', (select token from t where name = 'a2'), 'exited'),
  'exited is only for a pending attempt');
select th.assert(not public.fail_plaid_link_attempt((select id from t where name = 'a2'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', gen_random_uuid(), 'store_failed_item_removed'),
  'a wrong claim token cannot fail an exchanging attempt');
select th.assert(public.fail_plaid_link_attempt((select id from t where name = 'a2'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', (select token from t where name = 'a2'), 'store_failed_item_removed'),
  'compensated: exchanging -> failed');
select th.assert((select status = 'failed' and failure_reason = 'store_failed_item_removed' from public.plaid_link_attempts where id = (select id from t where name = 'a2')), 'reason recorded');
select th.assert(pg_temp.claim((select id from t where name = 'a2'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'failed', 'failed: never claimable');

insert into t(name, id) select 'a3', th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert(public.fail_plaid_link_attempt((select id from t where name = 'a3'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', null, 'exited'), 'pending -> failed (exited)');
select th.assert((select link_token_ciphertext is null from public.plaid_link_attempts where id = (select id from t where name = 'a3')), 'failed: link token erased');
select th.assert(not public.fail_plaid_link_attempt((select id from t where name = 'a3'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', null, 'exited'), 'failing twice changes nothing');
select th.expect_error($q$ select public.fail_plaid_link_attempt(gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', 'sid-a', null, 'whatever') $q$, '%unknown reason%');

insert into t(name, id) select 'a4', th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
update t set token = (select claim_token from public.claim_plaid_link_attempt((select id from t where name = 'a4'), '00000000-0000-0000-0000-0000000000aa', 'sid-a')) where name = 'a4';
select public.begin_plaid_link_exchange((select id from t where name = 'a4'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', (select token from t where name = 'a4'));
select th.assert(public.fail_plaid_link_attempt((select id from t where name = 'a4'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', (select token from t where name = 'a4'), 'exchange_outcome_unknown'),
  'exchanging -> exchange_unknown (outcome unknown)');
select th.assert(public.fail_plaid_link_attempt((select id from t where name = 'a4'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', (select token from t where name = 'a4'), 'store_failed_item_removed'),
  'a late compensation can still record exchange_unknown -> failed');
select th.assert(pg_temp.claim((select id from t where name = 'a4'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'failed', 'recorded as failed');

-- Stale recovery.
-- A stale CLAIM (exchange known not started) is safely re-claimable, with a new token; the old
-- holder's token no longer works.
insert into t(name, id) select 's1', th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '5 minutes', now() + interval '25 minutes', 'claimed', gen_random_uuid(), now() - interval '3 minutes');
update t set token = th.claim_token_of(id) where name = 's1';
select th.assert((select stale from public.read_plaid_link_attempt((select id from t where name = 's1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a')), 'read reports the claim stale');
select th.assert(pg_temp.claim((select id from t where name = 's1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'claimed', 'a stale claim is re-claimed');
select th.assert(th.claim_token_of((select id from t where name = 's1')) <> (select token from t where name = 's1'), 'with a new claim token');
select th.assert(not public.begin_plaid_link_exchange((select id from t where name = 's1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a', (select token from t where name = 's1')),
  'the old holder can no longer begin the exchange');
-- A FRESH claim is not re-claimable.
insert into t(name, id) select 's2', th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '5 minutes', now() + interval '25 minutes', 'claimed', gen_random_uuid(), now() - interval '30 seconds');
select th.assert(pg_temp.claim((select id from t where name = 's2'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'in_progress', 'a fresh claim: in_progress');
-- A stale EXCHANGE is never re-claimed: it becomes exchange_unknown.
insert into t(name, id) select 's3', th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '5 minutes', now() + interval '25 minutes', 'exchanging', gen_random_uuid(), now() - interval '3 minutes');
select th.assert((select stale from public.read_plaid_link_attempt((select id from t where name = 's3'), '00000000-0000-0000-0000-0000000000aa', 'sid-a')), 'read reports the exchange stale');
select th.assert(pg_temp.claim((select id from t where name = 's3'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'exchange_unknown', 'a stale exchange: exchange_unknown');
select th.assert((select status = 'exchange_unknown' and failure_reason = 'stale_exchange' from public.plaid_link_attempts where id = (select id from t where name = 's3')), 'recorded, with its reason');
select th.assert(pg_temp.claim((select id from t where name = 's3'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'exchange_unknown', 'and stays so');
-- A fresh exchange is left alone.
insert into t(name, id) select 's4', th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '5 minutes', now() + interval '25 minutes', 'exchanging', gen_random_uuid(), now() - interval '30 seconds');
select th.assert(pg_temp.claim((select id from t where name = 's4'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'in_progress', 'a fresh exchange: in_progress');
-- Another user cannot trigger recovery of someone else's stale exchange.
insert into t(name, id) select 's5', th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '5 minutes', now() + interval '25 minutes', 'exchanging', gen_random_uuid(), now() - interval '3 minutes');
select th.assert(pg_temp.claim((select id from t where name = 's5'), '00000000-0000-0000-0000-0000000000bb', 'sid-b') = 'invalid', 'a foreign caller: invalid');
select th.assert((select status from public.plaid_link_attempts where id = (select id from t where name = 's5')) = 'exchanging', 'and nothing changed');

-- Expired: reported, never claimable, state untouched.
insert into t(name, id) select 'e1', th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '40 minutes', now() - interval '10 minutes');
select th.assert((select expired from public.read_plaid_link_attempt((select id from t where name = 'e1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a')), 'read reports it expired');
select th.assert(pg_temp.claim((select id from t where name = 'e1'), '00000000-0000-0000-0000-0000000000aa', 'sid-a') = 'expired', 'expired: not claimable');
select th.assert((select status from public.plaid_link_attempts where id = (select id from t where name = 'e1')) = 'pending', 'expired claim changed nothing');

-- Webhook readiness: recorded once, informational only.
insert into t(name, id) select 'w1', th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert(public.mark_plaid_link_attempt_ready(th.attempt_token_hash((select id from t where name = 'w1')), 'success'), 'first delivery records readiness');
select th.assert(not public.mark_plaid_link_attempt_ready(th.attempt_token_hash((select id from t where name = 'w1')), 'EXITED'), 'duplicate delivery changes nothing');
select th.assert((select ready_at is not null and ready_status = 'SUCCESS' and status = 'pending' and claimed_at is null
                  from public.plaid_link_attempts where id = (select id from t where name = 'w1')),
  'readiness never claims, completes or changes status');
select th.assert(not public.mark_plaid_link_attempt_ready(repeat('0', 64), 'SUCCESS'), 'unknown token: no-op');
select th.assert(not public.mark_plaid_link_attempt_ready('not-a-hash', 'SUCCESS'), 'malformed hash: no-op');

-- Row constraints.
select th.expect_error($q$ insert into public.plaid_link_attempts (id, user_id, session_id, expires_at, link_token_hash)
                          values (gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', 's', now() + interval '1 minute', repeat('b', 64)) $q$,
                       '%violates check constraint%');
select th.expect_error($q$ update public.plaid_link_attempts set status = 'claimed' where id = (select id from t where name = 'w1') $q$,
                       '%violates check constraint%');
select th.expect_error($q$ select public.store_plaid_link_item(gen_random_uuid(), '00000000-0000-0000-0000-0000000000aa', 'sid-a', gen_random_uuid(), gen_random_uuid(), ' ', 'c', 'n', 't', 'k', 1::smallint) $q$,
                       '%an item row id and a Plaid item id are required%');

-- The limit: at most five live attempts — pending, claimed and exchanging alike.
delete from public.plaid_link_attempts;
select th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - make_interval(secs => g), now() + interval '10 minutes')
  from generate_series(1, 6) g;
select th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '20 minutes', now() + interval '10 minutes', 'completed');
select th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert((select count(*) from public.plaid_link_attempts
                  where user_id = '00000000-0000-0000-0000-0000000000aa' and status in ('pending', 'claimed', 'exchanging') and expires_at > now()) = 5,
  'at most five live attempts per user');
select th.assert((select count(*) from public.plaid_link_attempts where status = 'completed') = 1, 'a completed attempt was kept and not counted');

delete from public.plaid_link_attempts;
select th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '1 minute', now() + interval '20 minutes', 'claimed');
select th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '1 minute', now() + interval '20 minutes', 'exchanging');
select th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - make_interval(secs => g), now() + interval '10 minutes')
  from generate_series(1, 4) g;
select th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert((select count(*) from public.plaid_link_attempts where user_id = '00000000-0000-0000-0000-0000000000aa' and status in ('claimed', 'exchanging')) = 2,
  'attempts being completed are never removed to make room');
select th.assert((select count(*) from public.plaid_link_attempts
                  where user_id = '00000000-0000-0000-0000-0000000000aa' and status in ('pending', 'claimed', 'exchanging') and expires_at > now()) = 5,
  'two in flight + three pending: still five in total');

delete from public.plaid_link_attempts;
select th.insert_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a', now() - interval '1 minute', now() + interval '20 minutes', 'exchanging')
  from generate_series(1, 5) g;
select th.expect_error($q$ select th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a') $q$, '%too many Plaid Link attempts in progress%');
select th.assert((select count(*) from public.plaid_link_attempts) = 5, 'a refused create adds nothing');

-- Global, bounded sweep an hour after expiry: ANY user's create or claim removes up to 100 of
-- ANYONE's long-expired rows, oldest first, never a recently-expired or live one.
delete from public.plaid_link_attempts;
select th.insert_attempt('00000000-0000-0000-0000-0000000000bb', 'sid-b', now() - interval '3 hours', now() - interval '2 hours' - make_interval(secs => g))
  from generate_series(1, 150) g;
insert into t(name, id) select 'recent', th.insert_attempt('00000000-0000-0000-0000-0000000000bb', 'sid-b', now() - interval '40 minutes', now() - interval '10 minutes');
insert into t(name, id) select 'live', th.new_attempt('00000000-0000-0000-0000-0000000000bb', 'sid-b');
select th.assert((select count(*) from public.plaid_link_attempts where expires_at <= now() - interval '1 hour') = 50,
  'user bb''s own create swept 100 long-expired rows (bounded batch)');
insert into t(name, id) select 'aa-live', th.new_attempt('00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert(not exists (select 1 from public.plaid_link_attempts where expires_at <= now() - interval '1 hour'),
  'user aa''s create swept the remaining 50 of user bb''s rows');
select th.assert(exists (select 1 from public.plaid_link_attempts where id = (select id from t where name = 'recent')), 'a recently-expired row is kept for replay detection');
select th.assert(exists (select 1 from public.plaid_link_attempts where id = (select id from t where name = 'live')), 'live rows are never swept');
select th.insert_attempt('00000000-0000-0000-0000-0000000000bb', 'sid-b', now() - interval '3 hours', now() - interval '2 hours');
select pg_temp.claim((select id from t where name = 'aa-live'), '00000000-0000-0000-0000-0000000000aa', 'sid-a');
select th.assert(not exists (select 1 from public.plaid_link_attempts where expires_at <= now() - interval '1 hour'), 'a claim also sweeps');
select th.expect_error($q$ select public.purge_expired_plaid_link_attempts(0) $q$, '%p_limit must be between 1 and 1000%');
select th.expect_error($q$ select public.purge_expired_plaid_link_attempts(null) $q$, '%p_limit must be between 1 and 1000%');

-- An id, a user and a login session are required.
select th.expect_error($q$ select th.new_attempt('00000000-0000-0000-0000-0000000000aa', ' ') $q$, '%an id, a user and a login session are required%');
select th.expect_error($q$ select th.new_attempt(null, 'sid-a') $q$, '%an id, a user and a login session are required%');
reset role;
