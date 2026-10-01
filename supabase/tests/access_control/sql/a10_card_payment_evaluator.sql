-- The card-payment SQL evaluator and state reader, single-session behaviour (CARD_PAYMENT_PAIRING_DESIGN.md
-- §3.6–§3.7; acceptance tests 14, 15, the single-session half of 16a, and 20 at the database level).
-- Exact rule equivalence with the TypeScript reference evaluator is tested separately
-- (supabase/tests/card_payment_evaluator). Concurrency cases are under concurrency/c12–c15.
set role service_role;

insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-00000000aac1', '00000000-0000-0000-0000-000000000001', 'ev-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-00000000aac2', '00000000-0000-0000-0000-000000000001', 'ev-x', 'Card', 'credit'),
  ('00000000-0000-0000-0000-00000000bbc1', '00000000-0000-0000-0000-000000000002', 'ev-bc', 'BB Checking', 'depository'),
  ('00000000-0000-0000-0000-00000000bbc2', '00000000-0000-0000-0000-000000000002', 'ev-bx', 'BB Card', 'credit');

create function pg_temp.states(p_user text) returns jsonb
language sql as $$ select public.get_card_payment_states(p_user::uuid) $$;
create function pg_temp.leg(p_user text, p_txn text) returns jsonb
language sql as $$
  select l from jsonb_array_elements(pg_temp.states(p_user)->'legs') l where l->>'transactionId' = p_txn
$$;
create function pg_temp.versions(p_user text) returns public.card_payment_eval_versions
language sql as $$ select v from public.card_payment_eval_versions v where v.user_id = p_user::uuid $$;

-- ---- Never evaluated: not readable ---------------------------------------------------------------
select th.assert(not (pg_temp.states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'before any evaluation: not fresh');
select th.assert(pg_temp.states('00000000-0000-0000-0000-0000000000aa')->'legs' is null, 'before any evaluation: no legs at all');
select th.assert(not (public.get_card_payment_states('00000000-0000-0000-0000-0000000000ff')->>'fresh')::boolean,
  'an unknown user is not fresh (no version row)');

-- Mirror-image legs of two users: aa's payment and bb's card leg on the same days (20: never cross).
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000aac1', 'ev-a-pay', 100, '2026-09-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000bbc2', 'ev-b-card', -100, '2026-09-02', 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-00000000bbc1', 'ev-b-pay', 250, '2026-09-01', 'credit_card_payment');

-- ---- Evaluate: publishes exactly the version read under L2 -----------------------------------------
do $$
declare
  v_before bigint := (select input_version from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa');
  v_pub bigint;
begin
  v_pub := public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
  perform th.assert(v_pub = v_before, 'the published version is the input version read under the lock');
  perform th.assert((pg_temp.versions('00000000-0000-0000-0000-0000000000aa')).evaluated_version = v_pub, 'evaluated_version = published version');
end $$;
select th.assert((pg_temp.states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'fresh after evaluation');
select th.assert(pg_temp.leg('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a001')->>'reason' = 'no_candidate',
  'aa''s payment has no candidate: bb''s card leg on the same amount and days is never evidence');
select th.assert((select count(*) from jsonb_array_elements(pg_temp.states('00000000-0000-0000-0000-0000000000aa')->'legs')) = 1,
  'the reader returns only aa''s legs');
select th.assert(not exists (select 1 from public.card_payment_leg_states where user_id = '00000000-0000-0000-0000-0000000000aa'
                               and transaction_id in ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b002')),
  'no state row of aa names a row of bb');
select th.assert(not (pg_temp.states('00000000-0000-0000-0000-0000000000bb')->>'fresh')::boolean, 'bb, never evaluated, stays not fresh');

-- ---- 14: a trigger-only change makes the states unreadable (never the previous resolved states) -------
update public.transactions set amount = 98 where plaid_transaction_id = 'ev-a-pay';
select th.assert(not (pg_temp.states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'after an unevaluated change: not fresh');
select th.assert(pg_temp.states('00000000-0000-0000-0000-0000000000aa')->'legs' is null, 'after an unevaluated change: no legs returned');
select th.assert(exists (select 1 from public.card_payment_leg_states where user_id = '00000000-0000-0000-0000-0000000000aa'),
  '(the stale rows still exist in the table, but the reader never returns them)');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
select th.assert((pg_temp.leg('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a001')->>'amountCents')::bigint = 9800,
  'a standalone evaluation publishes states for the current inputs');

-- ---- 16a (single session): an input written after evaluation in the same transaction stays stale -----
begin;
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
update public.transactions set amount = 97 where plaid_transaction_id = 'ev-a-pay';
commit;
select th.assert((pg_temp.versions('00000000-0000-0000-0000-0000000000aa')).input_version
                   = (pg_temp.versions('00000000-0000-0000-0000-0000000000aa')).evaluated_version + 1,
  'a write after the evaluation leaves input_version one ahead');
select th.assert(not (pg_temp.states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'so the user is stale, not falsely fresh');

-- ---- 15 / 16a: failure is contained; REPEATABLE READ is refused ------------------------------------------
begin isolation level repeatable read;
select th.expect_error($q$ select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa') $q$,
                       '%card_payment_evaluation_requires_read_committed%');
rollback;
begin isolation level repeatable read;
-- A writer's own change commits even though its evaluation fails (the sync-batch shape of test 15).
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000aac2', 'ev-a-card', -97, '2026-09-02', 'credit_card_payment');
select th.assert(not public.try_evaluate_card_payments('00000000-0000-0000-0000-0000000000aa'), 'try_evaluate reports failure');
commit;
select th.assert(exists (select 1 from public.transactions where plaid_transaction_id = 'ev-a-card'), 'the writer''s own change committed');
select th.assert((pg_temp.versions('00000000-0000-0000-0000-0000000000aa')).last_error_code = '25001', 'a sanitized SQLSTATE is recorded');
select th.assert(not (pg_temp.states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'after a failed evaluation: stale');
select th.assert(pg_temp.states('00000000-0000-0000-0000-0000000000aa')->>'lastErrorCode' = '25001', 'the reader reports the error code, and no states');
select th.assert(public.try_evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z'), 'a retry succeeds');
select th.assert((pg_temp.states('00000000-0000-0000-0000-0000000000aa')->>'fresh')::boolean, 'fresh after the retry');
select th.assert((pg_temp.versions('00000000-0000-0000-0000-0000000000aa')).last_error_code is null, 'the error code is cleared');
select th.assert(pg_temp.leg('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a001')->>'partnerTransactionId'
                   = '00000000-0000-0000-0000-00000000a002', 'and the new card leg pairs automatically');

-- Re-evaluating replaces the derived rows (no duplicates, one row per leg).
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
select th.assert((select count(*) from public.card_payment_leg_states where user_id = '00000000-0000-0000-0000-0000000000aa') = 2,
  'one state row per leg after repeated evaluations');
select th.assert((select count(*) from public.card_payment_auto_pairs where user_id = '00000000-0000-0000-0000-0000000000aa') = 1,
  'one auto pair');

-- ---- 20: an account that moved to another user after a decision is not applied for either user ----------
insert into public.card_payment_decisions (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents) values
  ('00000000-0000-0000-0000-00000000dd01', '00000000-0000-0000-0000-0000000000aa', 'destination_unlinked',
   '00000000-0000-0000-0000-00000000aac1', 'ev-a-pay', 9700);
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
select th.assert(pg_temp.leg('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a001')->>'reason' = 'user_confirmed_unlinked',
  'while aa owns the account, aa''s decision applies');
reset role;
update public.accounts set item_id = '00000000-0000-0000-0000-000000000002' where id = '00000000-0000-0000-0000-00000000aac1';
set role service_role;
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000bb', '2026-10-01T00:00:00Z');
select th.assert(exists (select 1 from jsonb_array_elements(pg_temp.states('00000000-0000-0000-0000-0000000000aa')->'decisions') d
                         where d->>'decisionId' = '00000000-0000-0000-0000-00000000dd01' and d->>'status' = 'rejected' and d->>'detail' = 'foreign_account'),
  'for aa the decision now names a foreign account: rejected');
select th.assert(exists (select 1 from jsonb_array_elements(pg_temp.states('00000000-0000-0000-0000-0000000000bb')->'decisions') d
                         where d->>'decisionId' = '00000000-0000-0000-0000-00000000dd01' and d->>'status' = 'rejected' and d->>'detail' = 'foreign_user'),
  'for bb it is another user''s decision: rejected');
select th.assert(pg_temp.leg('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-00000000a001')->>'decisionId' is null,
  'the moved row carries no decision for bb');

-- ---- 20: a colliding pending id on another user's account never supersedes a row --------------------------
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, pending, user_role_override) values
  ('00000000-0000-0000-0000-00000000a003', '00000000-0000-0000-0000-00000000aac2', 'ev-shared-pending', -40, '2026-09-05', true, 'credit_card_payment'),
  ('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-00000000bbc2', 'ev-b-posted', -40, '2026-09-06', false, 'credit_card_payment');
update public.transactions set pending_transaction_id = 'ev-shared-pending' where plaid_transaction_id = 'ev-b-posted';
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa', '2026-10-01T00:00:00Z');
select th.assert(pg_temp.leg('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-00000000a003') is not null,
  'aa''s pending row is still a leg');
select th.assert(pg_temp.states('00000000-0000-0000-0000-0000000000aa')->'supersededTransactionIds' = '[]'::jsonb,
  'and is not superseded by bb''s row');
