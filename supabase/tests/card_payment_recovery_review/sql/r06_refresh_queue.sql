-- The durable refresh queue and the refresh-only retry (PHASE_B_I3A_R_PACKET_2A_REVIEW.md §8; traceability
-- cases 37, 41, 42, 43). Everything a worker does is two calls; this file plays the worker.
--
-- User aa has one guarded payment (item 1 removed, item 3 kept, item 8 with an unrelated w). User bb has card
-- payments and NO review obligation.
-- A run that failed midway leaves this file's test-only function (and, with it, its triggers) behind: remove them first.
drop function if exists public.th_r06_refuse() cascade;
set role service_role;

select rrh.item('00000000-0000-0000-0000-000000000003', rrh.aa(), 'r06-item-kept', 'Kept Bank');
select rrh.account('00000000-0000-0000-0000-0000000106a1', '00000000-0000-0000-0000-000000000001', 'r06-x', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000106b1', '00000000-0000-0000-0000-000000000003', 'r06-c', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000106b2', '00000000-0000-0000-0000-000000000003', 'r06-y', 'credit');
select rrh.account('00000000-0000-0000-0000-0000000106c1', '00000000-0000-0000-0000-000000000002', 'r06-bc', 'depository');
select rrh.account('00000000-0000-0000-0000-0000000106c2', '00000000-0000-0000-0000-000000000002', 'r06-by', 'credit');
select rrh.cardleg('k', '00000000-0000-0000-0000-0000000106b1', 370, '2026-09-10'), rrh.cardleg('x', '00000000-0000-0000-0000-0000000106a1', -370, '2026-09-11'),
       rrh.cardleg('y', '00000000-0000-0000-0000-0000000106b2', -370, '2026-09-12');
select rrh.cardleg('bk', '00000000-0000-0000-0000-0000000106c1', 50, '2026-09-10'), rrh.cardleg('by', '00000000-0000-0000-0000-0000000106c2', -50, '2026-09-10');
select rrh.remove(rrh.aa(), '00000000-0000-0000-0000-000000000001');
select rrh.item('00000000-0000-0000-0000-000000000008', rrh.aa(), 'r06-item-other', 'Other Bank');
select rrh.account('00000000-0000-0000-0000-0000000106e1', '00000000-0000-0000-0000-000000000008', 'r06-w', 'credit');
select public.evaluate_card_payments(rrh.aa()), public.evaluate_card_payments(rrh.bb());

create function pg_temp.q(p_user uuid default rrh.aa()) returns text language sql as $$
  select coalesce((select format('target=%s attempts=%s total=%s attention=%s leased=%s due=%s code=%s', q.target_version, q.attempts, q.total_failures,
                                 q.needs_attention, q.lease_token is not null, q.available_at <= now(), coalesce(q.last_error_code, '-'))
                   from public.card_payment_recovery_refresh_queue q where q.user_id = p_user), 'none') $$;
create function pg_temp.claims(p_worker integer, p_limit integer default 10) returns jsonb language sql as $$
  select public.claim_card_payment_recovery_refresh(rrh.op(p_worker), p_limit)->'claims' $$;
create function pg_temp.token(p_claims jsonb, p_user uuid default rrh.aa()) returns uuid language sql as $$
  select (c->>'leaseToken')::uuid from jsonb_array_elements(p_claims) c where (c->>'userId')::uuid = p_user $$;
create function pg_temp.evaluated(p_user uuid default rrh.aa()) returns bigint language sql as $$
  select evaluated_version from public.card_payment_eval_versions where user_id = p_user $$;
create temporary table kept (name text primary key, v jsonb);

-- ==== 1. Registration: any input change of an owner under review, whoever wrote it =================================
select th.assert(pg_temp.q() = 'none' and pg_temp.q(rrh.bb()) = 'none', 'after a fresh evaluation there is no work: ' || pg_temp.q());
-- A bank row arrives (what a sync writes). No recovery action, no evaluation.
select rrh.cardleg('w', '00000000-0000-0000-0000-0000000106e1', -370, '2026-09-11');
select th.assert(pg_temp.q() = format('target=%s attempts=0 total=0 attention=f leased=f due=t code=-', rrh.iv()) and not rrh.fresh(),
                 'an input change of an owner under review registers refresh work in the writer''s own transaction: ' || pg_temp.q());
-- An account setting (a lock-free writer) raises the target; it does not add a second row.
update public.accounts set exclude_from_cash_flow = true where id = '00000000-0000-0000-0000-0000000106b2';
update public.accounts set exclude_from_cash_flow = false where id = '00000000-0000-0000-0000-0000000106b2';
select th.assert(pg_temp.q() = format('target=%s attempts=0 total=0 attention=f leased=f due=t code=-', rrh.iv()), 'later changes coalesce onto the one row, at the latest version: ' || pg_temp.q());
-- An owner with no obligation is not this queue's business: its inputs change, nothing is registered.
select rrh.cardleg('bk2', '00000000-0000-0000-0000-0000000106c1', 60, '2026-09-11');
select th.assert(pg_temp.q(rrh.bb()) = 'none' and not rrh.fresh(rrh.bb()), 'an owner with no review obligation gets no queue row: ' || pg_temp.q(rrh.bb()));

-- ==== 2. Claim and refresh ==========================================================================================
insert into pg_temp.kept values ('claim a', pg_temp.claims(1));
select th.assert(jsonb_array_length(v) = 1 and (v->0->>'userId')::uuid = rrh.aa() and (v->0->>'targetVersion')::bigint = rrh.iv(), 'worker 1 claims the one row: ' || v::text) from pg_temp.kept where name = 'claim a';
select th.assert(jsonb_array_length(pg_temp.claims(2)) = 0 and pg_temp.q() like '%leased=t%', 'worker 2 gets nothing while the lease stands');
insert into pg_temp.kept select 'step 1', public.refresh_card_payment_recovery_owner(rrh.aa(), rrh.op(999));
-- A wrong token acknowledges nothing and evaluates nothing.
select th.assert((select v from pg_temp.kept where name = 'step 1')->>'status' = 'lease_lost' and not rrh.fresh() and pg_temp.q() like '%leased=t%', 'a wrong lease token does nothing');
select th.assert(public.refresh_card_payment_recovery_owner(rrh.aa(), pg_temp.token(v))->>'status' = 'fresh', 'worker 1 refreshes') from pg_temp.kept where name = 'claim a';
select th.assert(rrh.fresh() and pg_temp.q() = 'none' and rrh.line('k') = 'unresolved/relink_review_required/null partner=- decision=- range=-37000..0',
                 'the owner is fresh, the work is gone, and the guarded reading is published without any sync: ' || rrh.line('k'));
select th.assert(public.refresh_card_payment_recovery_owner(rrh.aa(), pg_temp.token(v))->>'status' = 'lease_lost', 'the same lease cannot be used again') from pg_temp.kept where name = 'claim a';

-- ==== 3. An expired lease, two workers, a stale acknowledgement (case 43) ==============================================
select rrh.cardleg('n1', '00000000-0000-0000-0000-0000000106b1', 5, '2026-09-20');
insert into pg_temp.kept values ('claim b', pg_temp.claims(1));
reset role;
update public.card_payment_recovery_refresh_queue set lease_expires_at = now() - interval '1 second' where user_id = rrh.aa();
set role service_role;
insert into pg_temp.kept values ('claim c', pg_temp.claims(2));
select th.assert(jsonb_array_length(v) = 1 and pg_temp.token(v) <> (select pg_temp.token(v) from pg_temp.kept where name = 'claim b'), 'after the lease expired, worker 2 claims the row under a new lease') from pg_temp.kept where name = 'claim c';
insert into pg_temp.kept select 'step 2', public.refresh_card_payment_recovery_owner(rrh.aa(), pg_temp.token(v)) from pg_temp.kept where name = 'claim b';
select th.assert((select v from pg_temp.kept where name = 'step 2')->>'status' = 'lease_lost' and not rrh.fresh() and pg_temp.q() like '%leased=t%',
                 'worker 1, late, with its expired lease: nothing is evaluated or acknowledged, and worker 2''s lease stands');
insert into pg_temp.kept select 'step 3', public.refresh_card_payment_recovery_owner(rrh.aa(), pg_temp.token(v)) from pg_temp.kept where name = 'claim c';
select th.assert((select v from pg_temp.kept where name = 'step 3')->>'status' = 'fresh' and pg_temp.q() = 'none', 'worker 2 completes it');

-- ==== 4. Work registered for a LATER version is never removed ==========================================================
-- The states are fresh, and a row stands for a version that does not exist yet (as when a writer's registration
-- and a publication cross). The worker must release it, not delete it.
select rrh.cardleg('n2', '00000000-0000-0000-0000-0000000106b1', 6, '2026-09-21');
select public.evaluate_card_payments(rrh.aa());
reset role;
insert into public.card_payment_recovery_refresh_queue (user_id, target_version) values (rrh.aa(), (select input_version + 5 from public.card_payment_eval_versions where user_id = rrh.aa()));
set role service_role;
insert into pg_temp.kept values ('claim d', pg_temp.claims(1));
create temporary table before_noop as select rrh.iv() as input, pg_temp.evaluated() as evaluated;
select th.assert(public.refresh_card_payment_recovery_owner(rrh.aa(), pg_temp.token(v))->>'status' = 'superseded', 'the worker reports that later work remains') from pg_temp.kept where name = 'claim d';
select th.assert(pg_temp.q() = format('target=%s attempts=0 total=0 attention=f leased=f due=t code=-', (select input + 5 from pg_temp.before_noop)), 'the row for the later version is kept and released: ' || pg_temp.q());
select th.assert(rrh.iv() = (select input from pg_temp.before_noop) and pg_temp.evaluated() = (select evaluated from pg_temp.before_noop), 'a refresh of a fresh owner evaluates nothing and moves no version');
reset role;
delete from public.card_payment_recovery_refresh_queue where user_id = rrh.aa();
set role service_role;

-- ==== 5. Ordinary failures: back-off, then needs_attention; the work is kept ==============================================
reset role;
create function public.th_r06_refuse() returns trigger language plpgsql as $$ begin raise exception 'th_r06: injected evaluation failure' using errcode = 'P0R06'; end $$;
create trigger th_r06_refuse_states before insert on public.card_payment_leg_states for each row execute function public.th_r06_refuse();
set role service_role;
select rrh.cardleg('n3', '00000000-0000-0000-0000-0000000106b1', 7, '2026-09-22');
create temporary table attempts (n integer primary key, answer jsonb, queue text);
do $$
declare
  n integer;
  c jsonb;
  a jsonb;
begin
  for n in 1 .. 8 loop
    -- the back-off has not elapsed: make the row due, as time passing would
    perform set_config('role', 'none', true);
    update public.card_payment_recovery_refresh_queue set available_at = now() where user_id = rrh.aa();
    perform set_config('role', 'service_role', true);
    c := public.claim_card_payment_recovery_refresh(rrh.op(1), 10)->'claims';
    a := public.refresh_card_payment_recovery_owner(rrh.aa(), (c->0->>'leaseToken')::uuid);
    insert into pg_temp.attempts values (n, a, pg_temp.q());
  end loop;
end $$;
select th.assert((select answer->>'status' = 'pending' and (answer->>'attempts')::integer = 1 and (answer->>'needsAttention')::boolean = false from pg_temp.attempts where n = 1)
                 and (select queue from pg_temp.attempts where n = 1) = format('target=%s attempts=1 total=1 attention=f leased=f due=f code=P0R06', rrh.iv()),
                 'first failure: pending, attempt 1, not due yet, the SQLSTATE recorded, the lease released: ' || (select queue from pg_temp.attempts where n = 1));
select th.assert((select answer->>'status' = 'pending' and (answer->>'attempts')::integer = 8 and (answer->>'needsAttention')::boolean from pg_temp.attempts where n = 8)
                 and pg_temp.q() = format('target=%s attempts=8 total=8 attention=t leased=f due=f code=P0R06', rrh.iv()),
                 'eighth failure in a row: needs attention; the work is kept: ' || pg_temp.q());
-- The delays, by hand: 5 s doubling, capped at 300 s: 5, 10, 20, 40, 80, 160, 300, 300.
reset role;
select th.assert((select round(extract(epoch from (q.available_at - q.last_attempt_at))) between 299 and 301 from public.card_payment_recovery_refresh_queue q where q.user_id = rrh.aa()), 'the back-off is capped at five minutes');
update public.card_payment_recovery_refresh_queue set available_at = now() where user_id = rrh.aa();
set role service_role;
select th.assert(jsonb_array_length(pg_temp.claims(1)) = 0, 'a row that needs attention is not handed out again, even when due');
select th.assert(not rrh.fresh() and not (rrh.states() ? 'legs') and (public.get_card_payment_recovery_reviews(rrh.aa())->'freshness'->'refresh'->>'needsAttention')::boolean,
                 'nothing stale is readable, and the review reader says the refresh needs attention');

-- ==== 6. The refresh-only retry ============================================================================================
create temporary table before_retry as
  select rrh.iv() as input, (select count(*) from public.card_payment_decisions) as decisions, (select count(*) from public.card_payment_review_obligations) as obligations,
         (select count(*) from public.card_payment_review_annotations) as notes;
insert into pg_temp.kept values ('retry', public.request_card_payment_recovery_refresh(rrh.aa(), rrh.op(50)));
select th.assert(v->>'status' = 'queued' and v->'receipt'->>'action' = 'refresh_retry' and v->'receipt'->>'outcome' = 'queued' and v->'receipt'->'intent' = '{"action": "refresh_retry"}'::jsonb
                 and (v->'freshness'->>'fresh')::boolean = false and not v::text ~ 'lease',
                 'the retry is accepted while the figures are not current, and its answer carries no lease: ' || v::text) from pg_temp.kept where name = 'retry';
select th.assert(pg_temp.q() = format('target=%s attempts=0 total=8 attention=f leased=f due=t code=P0R06', rrh.iv()), 'the row is eligible again; the failure history is kept: ' || pg_temp.q());
select th.assert((select (input, decisions, obligations, notes) from pg_temp.before_retry)
                 = (rrh.iv(), (select count(*) from public.card_payment_decisions), (select count(*) from public.card_payment_review_obligations), (select count(*) from public.card_payment_review_annotations)),
                 'the retry changed no version, no decision, no obligation and no note');
select th.assert(public.request_card_payment_recovery_refresh(rrh.aa(), rrh.op(50))->>'status' = 'replayed', 'the same retry operation again is a replay');
select th.assert(rrh.act(rrh.op(50), jsonb_build_object('action', 'defer', 'transactionId', rrh.tid('k')))->>'refused' like 'card_payment_recovery_operation_conflict:%', 'a retry''s operation id cannot be reused as a payment action');
-- Still failing: the worker tries again and records it.
insert into pg_temp.kept values ('claim e', pg_temp.claims(1));
insert into pg_temp.kept select 'step 4', public.refresh_card_payment_recovery_owner(rrh.aa(), pg_temp.token(v)) from pg_temp.kept where name = 'claim e';
select th.assert((select v from pg_temp.kept where name = 'step 4')->>'status' = 'pending' and pg_temp.q() like format('target=%s attempts=1 total=9 attention=f leased=f due=f code=P0R06', rrh.iv()),
                 'after the retry the worker tries again; a further failure is one more in the history: ' || pg_temp.q());
-- The cause is removed; a second retry makes the row due now; the worker publishes.
reset role;
drop trigger th_r06_refuse_states on public.card_payment_leg_states;
drop function public.th_r06_refuse();
set role service_role;
select th.assert(public.request_card_payment_recovery_refresh(rrh.aa(), rrh.op(51))->>'status' = 'queued', 'a second retry');
insert into pg_temp.kept values ('claim f', pg_temp.claims(1));
insert into pg_temp.kept select 'refresh f', public.refresh_card_payment_recovery_owner(rrh.aa(), pg_temp.token(v)) from pg_temp.kept where name = 'claim f';
select th.assert(v->>'status' = 'fresh' and rrh.fresh() and pg_temp.q() = 'none', 'the refresh succeeds and the work is done: ' || v::text || ' queue: ' || pg_temp.q() || ' claim: ' || (select v::text from pg_temp.kept where name = 'claim f'))
from pg_temp.kept where name = 'refresh f';
select th.assert((select last_error_code is null from public.card_payment_eval_versions where user_id = rrh.aa()), 'the recorded evaluation error is cleared by the successful one');
-- A retry for an owner that is already fresh costs nothing: no evaluation, no version.
create temporary table before_noop2 as select rrh.iv() as input, pg_temp.evaluated() as evaluated;
select th.assert(public.request_card_payment_recovery_refresh(rrh.aa(), rrh.op(52))->>'status' = 'queued', 'a retry while fresh is accepted');
insert into pg_temp.kept values ('claim g', pg_temp.claims(1));
insert into pg_temp.kept select 'step 5', public.refresh_card_payment_recovery_owner(rrh.aa(), pg_temp.token(v)) from pg_temp.kept where name = 'claim g';
select th.assert((select v from pg_temp.kept where name = 'step 5')->>'status' = 'fresh' and pg_temp.q() = 'none'
                 and rrh.iv() = (select input from pg_temp.before_noop2) and pg_temp.evaluated() = (select evaluated from pg_temp.before_noop2),
                 'it is acknowledged without an evaluation and without moving a version');
insert into pg_temp.kept select 'step 6', public.request_card_payment_recovery_refresh(rrh.bb(), rrh.op(52));
-- bb (no obligation) may ask too: the work is registered for bb alone.
select th.assert((select v from pg_temp.kept where name = 'step 6')->>'status' = 'queued' and pg_temp.q(rrh.bb()) like 'target=%' and pg_temp.q() = 'none', 'a retry registers work for its own user only');
insert into pg_temp.kept values ('claim h', pg_temp.claims(1));
insert into pg_temp.kept select 'step 7', public.refresh_card_payment_recovery_owner(rrh.bb(), pg_temp.token(v, rrh.bb())) from pg_temp.kept where name = 'claim h';
select th.assert((select v from pg_temp.kept where name = 'step 7')->>'status' = 'fresh' and rrh.fresh(rrh.bb()), 'and the worker refreshes bb');

-- ==== 6b. QUEUED IS NOT EXECUTING: with no worker anywhere, a retry runs nothing ===========================================
-- This file is the only "worker" there is. Here nobody claims. The request is accepted, the work waits, and
-- nothing any reader gets is a result: no leg, no review, no figure — however often it is asked for.
select rrh.cardleg('idle-late', '00000000-0000-0000-0000-0000000106e1', -77, '2026-09-21');
create temporary table before_idle as
  select rrh.iv() as input, pg_temp.evaluated() as evaluated, (select count(*) from public.card_payment_decisions) as decisions,
         (select count(*) from public.card_payment_review_obligations) as obligations;
select th.assert(not rrh.fresh() and pg_temp.q() = format('target=%s attempts=0 total=0 attention=f leased=f due=t code=-', rrh.iv()), 'idle: aa is stale and its work is registered: ' || pg_temp.q());
insert into pg_temp.kept values ('idle retry', public.request_card_payment_recovery_refresh(rrh.aa(), rrh.op(60)));
select th.assert(v->>'status' = 'queued' and (v->'freshness'->>'fresh')::boolean = false and (v->'freshness'->'refresh'->>'queued')::boolean
                 and not (v ? 'legs') and not (v ? 'reviews'),
                 'QUEUED, NOT EXECUTED: the retry''s answer is "queued", with freshness that says NOT fresh, and carries no result: ' || v::text) from pg_temp.kept where name = 'idle retry';
select th.assert(public.request_card_payment_recovery_refresh(rrh.aa(), rrh.op(61))->>'status' = 'queued', 'idle: asking again is accepted and queues nothing more');
select th.assert(public.request_card_payment_recovery_refresh(rrh.aa(), rrh.op(60))->>'status' = 'replayed', 'idle: the first retry operation replays');
select th.assert(not rrh.fresh() and not (rrh.states() ? 'legs') and not (rrh.states() ? 'reviews'),
                 'QUEUED, NOT EXECUTED: with no worker the states stay unreadable — a queued refresh publishes nothing');
select th.assert((r->>'fresh')::boolean = false and jsonb_array_length(r->'reviews') = 0 and (r->'freshness'->'refresh'->>'queued')::boolean
                 and (r->'freshness'->'refresh'->>'needsAttention')::boolean = false and (r->>'affectedPaymentCount')::integer = 1,
                 'QUEUED, NOT EXECUTED: the review reader says "not fresh, queued" and shows no review: ' || r::text)
from (select public.get_card_payment_recovery_reviews(rrh.aa()) as r) x;
select th.assert((select (input, evaluated, decisions, obligations) from pg_temp.before_idle)
                 = (rrh.iv(), pg_temp.evaluated(), (select count(*) from public.card_payment_decisions), (select count(*) from public.card_payment_review_obligations))
                 and pg_temp.q() = format('target=%s attempts=0 total=0 attention=f leased=f due=t code=-', rrh.iv()),
                 'idle: three requests later nothing was evaluated and no version, decision or obligation moved; one row waits: ' || pg_temp.q());
-- STARTUP RECOVERY: a worker that was never seen before (a new process, a new token) finds the waiting row with
-- its first claim, and publishes.
insert into pg_temp.kept values ('claim idle', pg_temp.claims(77));
insert into pg_temp.kept select 'step idle', public.refresh_card_payment_recovery_owner(rrh.aa(), pg_temp.token(v)) from pg_temp.kept where name = 'claim idle';
select th.assert((select v from pg_temp.kept where name = 'step idle')->>'status' = 'fresh' and rrh.fresh() and pg_temp.q() = 'none',
                 'startup recovery: a new worker''s first claim takes the waiting work and publishes it');

-- ==== 7. The claim is bounded =================================================================================================
reset role;
insert into auth.users (id, email) select ('00000000-0000-0000-0000-0000000f' || lpad(n::text, 4, '0'))::uuid, 'r06-' || n || '@example.test' from generate_series(1, 14) n;
insert into public.card_payment_recovery_refresh_queue (user_id, target_version) select ('00000000-0000-0000-0000-0000000f' || lpad(n::text, 4, '0'))::uuid, 0 from generate_series(1, 14) n;
set role service_role;
select th.assert(jsonb_array_length(pg_temp.claims(1, 1000)) = 10, 'at most ten claims per call, whatever is asked');
select th.assert(jsonb_array_length(pg_temp.claims(2, 3)) = 3 and jsonb_array_length(pg_temp.claims(3, 10)) = 1, 'the next calls take the rest: three, then the last one');
