-- 20261006120000_lim_removal_card_payment_matching.sql: what the removal reads, and what happens when a
-- step of it fails (CARD_PAYMENT_PAIRING_DESIGN.md §3.7, §4.7; acceptance test 18 "a failure rolls back the
-- whole removal"; test 20 ownership; test 22 grants; Trevor's decision of 2026-10-06 on failures).
--
--   A. The conversion comes from an evaluation made INSIDE the removal: never from stored states (stale
--      here in both directions), and it works for a user who was never evaluated.
--   B. Failures.
--      B1, B2. A failure of the removal itself — the first evaluation, the conversion — fails closed. The
--              call raises a fixed message, and nothing changed: decision, loan balance, row, removal
--              status, version.
--      B3.     A failure of the FINAL evaluation does not undo the removal. It commits, STALE: the evidence
--              is preserved, the versions say stale, the readers return no states, a replay evaluates
--              nothing, and a later standalone evaluation recovers the user.
--   C. A user pair that is NOT active when the card is removed is preserved as the user's decision, with the
--      removed side's status frozen from the removal's own evaluation (never from stored decision states).
--   D. The replaced function kept its security properties; no client role can run it or see its tables.
set role service_role;

create function pg_temp.aa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function pg_temp.bb() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000bb'::uuid $$;
create function pg_temp.item1() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
create function pg_temp.item4() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000004'::uuid $$;
create function pg_temp.states(p_user uuid default pg_temp.aa()) returns jsonb language sql as $$ select public.get_card_payment_states(p_user) $$;
create function pg_temp.fresh(p_user uuid default pg_temp.aa()) returns boolean language sql as $$
  select coalesce((pg_temp.states(p_user)->>'fresh')::boolean, false) $$;
create function pg_temp.iv(p_user uuid default pg_temp.aa()) returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = p_user $$;
create function pg_temp.ev(p_user uuid default pg_temp.aa()) returns bigint language sql as $$
  select evaluated_version from public.card_payment_eval_versions where user_id = p_user $$;
create function pg_temp.tid(p_plaid text) returns uuid language sql as $$
  select id from public.transactions where plaid_transaction_id = p_plaid $$;
-- A leg's state. Raises when the states are not fresh, so no assertion can pass on a stale read.
create function pg_temp.leg(p_plaid text, p_user uuid default pg_temp.aa()) returns jsonb language plpgsql as $$
declare
  v jsonb := pg_temp.states(p_user);
begin
  if not coalesce((v->>'fresh')::boolean, false) then
    raise exception 'ASSERTION FAILED: states are not fresh when reading leg %', p_plaid;
  end if;
  return (select l from jsonb_array_elements(v->'legs') l where (l->>'transactionId')::uuid = pg_temp.tid(p_plaid));
end $$;
create function pg_temp.sre(p_plaid text, p_user uuid default pg_temp.aa()) returns text language sql as $$
  select (l->>'state') || '/' || (l->>'reason') || '/' || coalesce(l->>'effectCents', 'null') from pg_temp.leg(p_plaid, p_user) l $$;
create function pg_temp.records(p_user uuid default pg_temp.aa()) returns text[] language sql as $$
  select coalesce(array_agg(d.a_plaid_transaction_id order by d.a_plaid_transaction_id), '{}')
  from public.card_payment_decisions d where d.kind = 'destination_removed_card' and d.user_id = p_user $$;
create function pg_temp.cardleg(p_plaid text, p_account text, p_amount numeric, p_date date, p_pending boolean default false) returns void language sql as $$
  insert into public.transactions (account_id, plaid_transaction_id, amount, date, name, pending, user_role_override)
  values (p_account::uuid, p_plaid, p_amount, p_date, 'Leg ' || p_plaid, p_pending, 'credit_card_payment') $$;
create function pg_temp.balance(p_loan text) returns numeric language sql as
  $$ select current_balance from public.manual_loans where id = p_loan::uuid $$;
-- Takes an item to plaid_removed through the state machine.
create function pg_temp.to_plaid_removed(p_user uuid, p_item uuid) returns void language plpgsql as $$
begin
  perform th.assert(public.begin_plaid_item_removal(p_user, p_item, public.plaid_item_removal_digest(p_user, p_item))->>'outcome' = 'started',
    'removal of ' || p_item || ' begins');
  perform public.record_plaid_item_removal_attempt(p_user, p_item, 'removed', null);
end $$;

-- ---- Fixture -------------------------------------------------------------------------------------
-- aa: item 1 "Card Bank" (card X: parts A and C); item 4 "Card Bank 2" (card X2, checking R2 with a
--     loan-linked payment: part B); item 3 "Kept Bank" (checking C, card Y).
-- bb: item 2 (card BX) and item 5 (checking BC). bb is NEVER evaluated before its removal.
insert into public.plaid_items (id, user_id, plaid_item_id, access_token, institution_name) values
  ('00000000-0000-0000-0000-000000000003', pg_temp.aa(), 'harness-item-a3', 'placeholder-token-a3', 'Kept Bank'),
  ('00000000-0000-0000-0000-000000000004', pg_temp.aa(), 'harness-item-a4', 'placeholder-token-a4', 'Card Bank 2'),
  ('00000000-0000-0000-0000-000000000005', pg_temp.bb(), 'harness-item-b5', 'placeholder-token-b5', 'BB Kept Bank');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000019a1', '00000000-0000-0000-0000-000000000001', 'a19-x', 'Card X', 'credit'),
  ('00000000-0000-0000-0000-0000000019d1', '00000000-0000-0000-0000-000000000004', 'a19-x2', 'Card X2', 'credit'),
  ('00000000-0000-0000-0000-0000000019d3', '00000000-0000-0000-0000-000000000004', 'a19-r2', 'Checking R2', 'depository'),
  ('00000000-0000-0000-0000-0000000019b1', '00000000-0000-0000-0000-000000000003', 'a19-c', 'Kept Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000019b3', '00000000-0000-0000-0000-000000000003', 'a19-y', 'Kept Card Y', 'credit'),
  ('00000000-0000-0000-0000-0000000019c2', '00000000-0000-0000-0000-000000000002', 'a19-bx', 'BB Card', 'credit'),
  ('00000000-0000-0000-0000-0000000019c1', '00000000-0000-0000-0000-000000000005', 'a19-bc', 'BB Checking', 'depository');
create function pg_temp.x() returns text language sql as $$ select '00000000-0000-0000-0000-0000000019a1' $$;
create function pg_temp.x2() returns text language sql as $$ select '00000000-0000-0000-0000-0000000019d1' $$;
create function pg_temp.r2() returns text language sql as $$ select '00000000-0000-0000-0000-0000000019d3' $$;
create function pg_temp.c() returns text language sql as $$ select '00000000-0000-0000-0000-0000000019b1' $$;
create function pg_temp.y() returns text language sql as $$ select '00000000-0000-0000-0000-0000000019b3' $$;
create function pg_temp.loan() returns text language sql as $$ select '00000000-0000-0000-0000-0000000019e1' $$;

insert into public.manual_loans (id, user_id, name, current_balance) values (pg_temp.loan()::uuid, pg_temp.aa(), 'L1', 1000);
insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, name, auto_role, role_source, role_confidence, classifier_version) values
  ('00000000-0000-0000-0000-0000000019f1', pg_temp.r2()::uuid, 'r2-loanpay', 100, '2026-09-10', 'Loan payment', 'expense', 'sign_default', 'low', 1);
select th.assert(public.link_transaction_to_manual_loan(pg_temp.aa(), '00000000-0000-0000-0000-0000000019f1', pg_temp.loan()::uuid, 100, 1::smallint) = 'linked',
  'fixture: a payment on Card Bank 2 is linked to a manual loan');
select th.assert(pg_temp.balance(pg_temp.loan()) = 900, 'fixture: the loan balance is 900');

select pg_temp.cardleg('k-a', pg_temp.c(), 100, '2026-09-01'),    pg_temp.cardleg('x-a', pg_temp.x(), -100, '2026-09-02');
select pg_temp.cardleg('k-gone', pg_temp.c(), 320, '2026-09-05'), pg_temp.cardleg('x-gone', pg_temp.x(), -320, '2026-09-06');
select pg_temp.cardleg('k-b', pg_temp.c(), 400, '2026-09-10'),    pg_temp.cardleg('x2-b', pg_temp.x2(), -400, '2026-09-11');
-- C. A user pair whose card leg is still pending; and a user pair the bank will invalidate.
select pg_temp.cardleg('k-wait', pg_temp.c(), 210, '2026-09-01'), pg_temp.cardleg('x-wait', pg_temp.x(), -210, '2026-09-20', true);
select pg_temp.cardleg('k-inval', pg_temp.c(), 220, '2026-09-01'), pg_temp.cardleg('x-inval', pg_temp.x(), -220, '2026-09-21');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-wait'), pg_temp.tid('x-wait'), 0, pg_temp.iv())->>'status' = 'saved', 'fixture: user pair k-wait');
select th.assert(public.link_card_payment(pg_temp.aa(), pg_temp.tid('k-inval'), pg_temp.tid('x-inval'), 0, pg_temp.iv())->>'status' = 'saved', 'fixture: user pair k-inval');
select th.assert(pg_temp.sre('k-a') = 'tracked/auto_pair/0' and pg_temp.sre('k-gone') = 'tracked/auto_pair/0' and pg_temp.sre('k-b') = 'tracked/auto_pair/0'
                 and pg_temp.sre('k-wait') = 'tracked/user_pair/0' and pg_temp.sre('k-inval') = 'tracked/user_pair/0', 'fixture: five pairs, all evaluated and stored');

-- bb: a pair between its two items. Never evaluated.
select pg_temp.cardleg('b-pay', '00000000-0000-0000-0000-0000000019c1', 100, '2026-09-01'),
       pg_temp.cardleg('b-card', '00000000-0000-0000-0000-0000000019c2', -100, '2026-09-02');
select th.assert(pg_temp.ev(pg_temp.bb()) is null and not pg_temp.fresh(pg_temp.bb()), 'fixture: bb has never been evaluated');

-- Changes made AFTER the last evaluation, by writers that do not evaluate (so the stored states are stale):
--   * the stored pair k-gone / x-gone no longer holds: the card leg's amount changed by 20.00;
--   * a new pair exists that no stored state knows: k-late / x-late;
--   * the pending card leg of k-wait is removed by a sync (its lineage is now waiting to post);
--   * the amount of x-inval changes, which invalidates the user's confirmation.
update public.transactions set amount = -300 where plaid_transaction_id = 'x-gone';
select pg_temp.cardleg('k-late', pg_temp.c(), 310, '2026-09-25'), pg_temp.cardleg('x-late', pg_temp.x(), -310, '2026-09-26');
select public.apply_synced_transaction_batch_v2(pg_temp.aa(), '[]'::jsonb, '[]'::jsonb, array['x-wait']);
update public.transactions set amount = -219 where plaid_transaction_id = 'x-inval';
select th.assert(not pg_temp.fresh(), 'the stored states are stale when the removal starts');
select th.assert(exists (select 1 from public.card_payment_leg_states s where s.user_id = pg_temp.aa() and s.transaction_id = pg_temp.tid('k-gone')
                           and s.partner_transaction_id = pg_temp.tid('x-gone'))
                 and exists (select 1 from public.card_payment_leg_states s where s.user_id = pg_temp.aa() and s.transaction_id = pg_temp.tid('k-inval')
                           and s.partner_transaction_id = pg_temp.tid('x-inval'))
                 and not exists (select 1 from public.card_payment_leg_states s where s.user_id = pg_temp.aa() and s.transaction_id = pg_temp.tid('k-late')),
  'the stored (stale) rows still pair k-gone with x-gone and k-inval with x-inval, and do not know k-late');
select pg_temp.to_plaid_removed(pg_temp.aa(), pg_temp.item1());
select pg_temp.to_plaid_removed(pg_temp.aa(), pg_temp.item4());

-- ---- A. The conversion comes from a fresh in-transaction evaluation -----------------------------------
create temporary table before_a as select pg_temp.iv() as iv;
select th.assert((public.remove_plaid_item_local(pg_temp.aa(), pg_temp.item1())->>'replayed')::boolean = false, 'A: the removal of Card Bank runs');
select th.assert(pg_temp.records() = array['k-a', 'k-late'],
  'records: k-a, and k-late (a pair no stored state knew). NOT k-gone or k-inval (stored pairs that no longer held), nor k-wait');
select th.assert(pg_temp.fresh() and pg_temp.ev() = pg_temp.iv() and pg_temp.iv() > (select iv from before_a),
  'A: fresh at the final version, which advanced');
select th.assert(pg_temp.sre('k-a') = 'untracked/removed_card/-10000' and pg_temp.sre('k-late') = 'untracked/removed_card/-31000',
  'A: both preserved destinations count');
select th.assert(pg_temp.sre('k-gone') = 'unresolved/no_candidate/null',
  'A: k-gone was not paired any more when the card was removed, so it is unresolved: a stale stored pair is never authority');
select th.assert(pg_temp.sre('k-b') = 'tracked/auto_pair/0', 'A: the pair with the other card (still linked) is untouched');

-- ---- C. A user pair that was NOT active when the card was removed is preserved too -----------------------
-- These two confirmations were inactive in the removal's own evaluation: one card leg was waiting to post,
-- the other's amount had changed (both changes were made AFTER the last stored evaluation, so the stored
-- decision states still said "active": the frozen status comes from the evaluation inside the removal).
-- The user's confirmation and its hold on the cash leg survive the account cascade (Trevor, 2026-10-06);
-- a20_lim_removal_user_confirmations.sql covers every such case with a competing card.
select th.assert((select jsonb_object_agg(d.a_plaid_transaction_id, d.counterpart_status)
                  from public.card_payment_decisions d where d.kind = 'pair_counterpart_removed' and d.superseded_by is null)
                 = '{"k-wait": "waiting_to_post", "k-inval": "amount_changed"}'::jsonb,
  'C: both inactive user pairs were preserved, each with the removed side''s status as the removal itself evaluated it');
select th.assert(pg_temp.sre('k-wait') = 'untracked/removed_card/-21000',
  'C: a confirmation that was only waiting for its card leg to post counts: the surviving cash leg is current and valid');
select th.assert(pg_temp.sre('k-inval') = 'unresolved/decision_invalidated/null' and pg_temp.leg('k-inval')->>'detail' = 'amount_changed'
                 and pg_temp.leg('k-inval')->>'decisionId' is not null,
  'C: a confirmation whose card amount had changed stays reserved and unresolved: the removal does not make it valid');
select th.assert(not exists (select 1 from public.card_payment_decisions where kind = 'pair'), 'C: the pair rows themselves went with the card''s account');

-- ---- B. Failures (Card Bank 2) --------------------------------------------------------------------------
create temporary table before_fail as
  select pg_temp.iv() as iv, pg_temp.ev() as ev, pg_temp.balance(pg_temp.loan()) as loan,
         (select count(*) from public.transactions) as txns, (select count(*) from public.accounts) as accts,
         (select jsonb_agg(to_jsonb(d) order by d.id) from public.card_payment_decisions d) as decisions,
         (select jsonb_agg(to_jsonb(s) order by s.transaction_id) from public.card_payment_leg_states s) as leg_states,
         (select jsonb_agg(to_jsonb(s) order by s.decision_id) from public.card_payment_decision_states s) as decision_states,
         (select to_jsonb(r) from public.plaid_item_removals r where r.item_id = pg_temp.item4()) as removal;
create function pg_temp.unchanged() returns boolean language sql as $$
  select pg_temp.iv() = b.iv and pg_temp.ev() is not distinct from b.ev
     and pg_temp.balance(pg_temp.loan()) = b.loan
     and (select count(*) from public.transactions) = b.txns and (select count(*) from public.accounts) = b.accts
     and (select jsonb_agg(to_jsonb(d) order by d.id) from public.card_payment_decisions d) = b.decisions
     and (select jsonb_agg(to_jsonb(s) order by s.transaction_id) from public.card_payment_leg_states s) = b.leg_states
     and (select jsonb_agg(to_jsonb(s) order by s.decision_id) from public.card_payment_decision_states s) = b.decision_states
     and (select to_jsonb(r) from public.plaid_item_removals r where r.item_id = pg_temp.item4()) = b.removal
     and (select status from public.plaid_items where id = pg_temp.item4()) = 'removing'
     and exists (select 1 from public.transactions where plaid_transaction_id = 'x2-b')
     and pg_temp.records() = array['k-a', 'k-late']
  from pg_temp.before_fail b $$;
select th.assert(pg_temp.unchanged() and pg_temp.fresh() and pg_temp.iv() = pg_temp.ev(), 'B: the unchanged() check holds before any attempt, and the user is fresh');

-- B1. The first evaluation cannot run (REPEATABLE READ: the evaluator requires READ COMMITTED).
begin isolation level repeatable read;
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000004') $q$,
  'remove_plaid_item_local: card-payment matching could not be evaluated before the removal (SQLSTATE 25001); nothing was removed');
select th.assert(pg_temp.unchanged(), 'B1: after the refused call, inside the same transaction, nothing changed');
commit;
select th.assert(pg_temp.unchanged(), 'B1: and nothing was committed');

-- B2. The conversion cannot be written (a test-only trigger refuses a new system record).
begin;
reset role;
create function public.th_a19_refuse_record() returns trigger language plpgsql as $$
begin
  if new.kind = 'destination_removed_card' then
    raise exception 'injected failure with a secret id 00000000-0000-0000-0000-00000000dead' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger th_a19_refuse_record before insert on public.card_payment_decisions
  for each row execute function public.th_a19_refuse_record();
set role service_role;
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000004') $q$,
  'remove_plaid_item_local: known card-payment destinations could not be preserved (SQLSTATE P0001); nothing was removed');
select th.assert(pg_temp.unchanged(), 'B2: a failed conversion leaves no evaluation, decision, restored balance or deleted row behind');
rollback;
select th.assert(pg_temp.unchanged(), 'B2: nothing was committed');

select th.assert((select status from public.plaid_item_removals where item_id = pg_temp.item4()) = 'plaid_removed', 'B1, B2: the operation is still plaid_removed (retryable)');

-- B3. The FINAL evaluation fails — after the conversion, the loan restoration and the delete all ran. The
-- same operation that B1 and B2 refused is retried, and now only its last step fails: the evidence is
-- preserved and the removal is done, so it COMMITS and leaves the user stale.
-- (A test-only trigger refuses the decision-state row of the record this removal writes: the first
-- evaluation has no such row to write, the final one does. It stays installed until the recovery below.)
reset role;
create function public.th_a19_refuse_final() returns trigger language plpgsql as $$
begin
  if exists (select 1 from public.card_payment_decisions d where d.id = new.decision_id and d.a_plaid_transaction_id = 'k-b') then
    raise exception 'injected failure with a secret id 00000000-0000-0000-0000-00000000dead' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger th_a19_refuse_final before insert on public.card_payment_decision_states
  for each row execute function public.th_a19_refuse_final();
set role service_role;
create temporary table removal (v jsonb);
do $$
begin
  insert into removal select public.remove_plaid_item_local(pg_temp.aa(), pg_temp.item4());
exception when others then
  raise exception 'ASSERTION FAILED: B3: a failed final evaluation must not fail the removal (it raised: %)', sqlerrm;
end $$;
select th.assert((select (v->>'replayed')::boolean = false from removal)
                 and (select array_agg(k order by k) from removal, jsonb_object_keys(v) k) = array['deleted_counts', 'loan_adjustments', 'replayed'],
  'B3: the removal returns its usual result, with exactly the usual keys');
select th.assert((select jsonb_array_length(v->'loan_adjustments') = 1 and (v->'loan_adjustments'->0->>'restored')::numeric = 100 from removal)
                 and pg_temp.balance(pg_temp.loan()) = 1000,
  'B3: the manual loan is restored exactly (100 back: 900 -> 1000)');
select th.assert(not exists (select 1 from public.plaid_items where id = pg_temp.item4())
                 and not exists (select 1 from public.accounts where item_id = pg_temp.item4())
                 and not exists (select 1 from public.transactions where plaid_transaction_id in ('x2-b', 'r2-loanpay'))
                 and (select status = 'cleaned' and deleted_counts = (select v->'deleted_counts' from removal)
                      from public.plaid_item_removals where item_id = pg_temp.item4()),
  'B3: the removal COMMITTED: the item, its accounts and its rows are gone, and the operation is cleaned');
select th.assert(pg_temp.records() = array['k-a', 'k-b', 'k-late'], 'B3: the destination evidence it preserved is there');
select th.assert(pg_temp.iv() > (select iv from before_fail) and pg_temp.ev() = (select ev from before_fail) and pg_temp.iv() > pg_temp.ev(),
  'B3: the versions say stale: the input version moved past the last evaluated one');
select th.assert(not pg_temp.fresh() and not (pg_temp.states() ? 'legs') and not (pg_temp.states() ? 'decisions')
                 and pg_temp.states()->>'lastErrorCode' = 'P0001',
  'B3: the state reader refuses: not fresh, no legs, no decisions, and only the SQLSTATE of the failure');
select th.assert((select not coalesce((v->'cardPayments'->>'fresh')::boolean, false) and v->'cardPayments'->'legs' is null
                  from (select public.get_financial_read_snapshot(pg_temp.aa(), '2026-09-01', '2026-10-01', false, false, true, '2026-09-01', '2026-10-01') as v) x),
  'B3: the financial read snapshot gets no card-payment states either');
select th.assert(exists (select 1 from public.card_payment_leg_states s
                         where s.user_id = pg_temp.aa() and s.transaction_id = pg_temp.tid('k-b') and s.reason = 'auto_pair'
                           and s.computed_at_version = pg_temp.ev())
                 and exists (select 1 from public.card_payment_leg_states s
                             where s.user_id = pg_temp.aa() and not exists (select 1 from public.transactions t where t.id = s.transaction_id)),
  'B3: the stored rows are the ones computed BEFORE the delete (k-b still "paired", a state of a deleted row) — the reason they must not be read');
-- Nothing recovers by itself: not a replay, not a decision RPC, not another evaluation while the fault lasts.
select th.assert((public.remove_plaid_item_local(pg_temp.aa(), pg_temp.item4())->>'replayed')::boolean and not pg_temp.fresh(),
  'B3: a replay (Retry of a cleaned removal) returns the stored result and evaluates nothing: still stale');
select th.expect_error(format($q$ select public.mark_card_payment_destination(%L, %L, %s) $q$, pg_temp.aa(), pg_temp.tid('k-gone'), pg_temp.iv()),
  '%card_payment_stale_version%');
select th.assert(not public.try_evaluate_card_payments(pg_temp.aa()) and not pg_temp.fresh() and pg_temp.iv() > pg_temp.ev(),
  'B3: while the fault lasts, a later evaluation fails too and the user stays stale');
-- Recovery: once the fault is gone, a later standalone evaluation succeeds and publishes the removal's result.
reset role;
drop trigger th_a19_refuse_final on public.card_payment_decision_states;
drop function public.th_a19_refuse_final();
set role service_role;
select th.assert(public.try_evaluate_card_payments(pg_temp.aa()), 'B3: a later standalone evaluation succeeds');
select th.assert(pg_temp.fresh() and pg_temp.ev() = pg_temp.iv()
                 and (select last_error_code is null from public.card_payment_eval_versions where user_id = pg_temp.aa()),
  'B3: recovered: fresh at the current version, the failure code cleared');
select th.assert(pg_temp.records() = array['k-a', 'k-b', 'k-late'] and pg_temp.sre('k-b') = 'untracked/removed_card/-40000'
                 and pg_temp.sre('k-a') = 'untracked/removed_card/-10000',
  'B3: the recovery publishes exactly what the removal preserved: the payment counts as leaving the tracked accounts');
select th.assert(not exists (select 1 from public.card_payment_leg_states s
                             where s.user_id = pg_temp.aa()
                               and (s.computed_at_version <> pg_temp.iv() or not exists (select 1 from public.transactions t where t.id = s.transaction_id))),
  'B3: and no state of an earlier version or of a deleted row is left');

-- ---- A. A user who was never evaluated ------------------------------------------------------------------
select pg_temp.to_plaid_removed(pg_temp.bb(), '00000000-0000-0000-0000-000000000002');
select th.assert(pg_temp.ev(pg_temp.bb()) is null, 'bb: still never evaluated when its removal runs');
create temporary table aa_before_bb as select pg_temp.iv() as iv, pg_temp.ev() as ev, pg_temp.states() as states, pg_temp.records() as records;
select public.remove_plaid_item_local(pg_temp.bb(), '00000000-0000-0000-0000-000000000002');
select th.assert(pg_temp.records(pg_temp.bb()) = array['b-pay'] and pg_temp.fresh(pg_temp.bb())
                 and pg_temp.sre('b-pay', pg_temp.bb()) = 'untracked/removed_card/-10000',
  'bb: the removal evaluated for the first time, converted the pair and published fresh states');
-- Ownership: bb's removal moved nothing of aa's, and wrote no record for aa.
select th.assert(pg_temp.iv() = (select iv from aa_before_bb) and pg_temp.ev() = (select ev from aa_before_bb)
                 and pg_temp.states() = (select states from aa_before_bb) and pg_temp.records() = (select records from aa_before_bb),
  'bb''s removal changed no version, state or record of aa');
select th.assert(not exists (select 1 from public.card_payment_decisions d
                             join public.accounts a on a.id = d.a_account_id join public.plaid_items i on i.id = a.item_id
                             where i.user_id <> d.user_id),
  'no decision names an account of a user other than its own');
-- And none can be written: a record for one user on another user's account is refused, whoever asks.
select th.expect_error($q$ insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)
  values ('00000000-0000-0000-0000-0000000000aa', 'destination_removed_card', '00000000-0000-0000-0000-0000000019c1', 'b-pay', 10000) $q$,
  '%card_payment_decision_foreign_account%');

-- ---- An item with no card payment at all: nothing to convert, still published fresh ------------------------
select pg_temp.to_plaid_removed(pg_temp.bb(), '00000000-0000-0000-0000-000000000005');
create temporary table bb_before as select pg_temp.iv(pg_temp.bb()) as iv;
select public.remove_plaid_item_local(pg_temp.bb(), '00000000-0000-0000-0000-000000000005');
select th.assert(pg_temp.fresh(pg_temp.bb()) and pg_temp.iv(pg_temp.bb()) > (select iv from bb_before)
                 and (select count(*) from jsonb_array_elements(pg_temp.states(pg_temp.bb())->'legs')) = 0
                 and not exists (select 1 from public.card_payment_decisions where user_id = pg_temp.bb()),
  'removing the last item: the version advances, fresh, no legs; the record on the deleted account went with it');

-- ---- D. Security properties of the replaced function ---------------------------------------------------
reset role;
select th.assert((select not p.prosecdef and p.proconfig = array['search_path=""'] and p.provolatile = 'v'
                         and not has_function_privilege('public', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
                         and not has_function_privilege('authenticated', p.oid, 'execute') and has_function_privilege('service_role', p.oid, 'execute')
                  from pg_proc p where p.oid = 'public.remove_plaid_item_local(uuid, uuid)'::regprocedure),
  'remove_plaid_item_local: SECURITY INVOKER, search_path pinned empty, service_role only');
select th.assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'public' and p.proname like 'remove_plaid_item_local%') = 1, 'one removal function, no versioned twin');
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}', false);
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003') $q$,
  '%permission denied for function remove_plaid_item_local%');
select th.expect_error($q$ select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa') $q$, '%permission denied for function evaluate_card_payments%');
select th.expect_error($q$ select count(*) from public.card_payment_decisions $q$, '%permission denied for table card_payment_decisions%');
select th.expect_error($q$ insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents)
  values ('00000000-0000-0000-0000-0000000000aa', 'destination_removed_card', '00000000-0000-0000-0000-0000000019b1', 'k-a', 10000) $q$,
  '%permission denied for table card_payment_decisions%');
select th.expect_error($q$ select count(*) from public.card_payment_leg_states $q$, '%permission denied for table card_payment_leg_states%');
set role anon;
select th.expect_error($q$ select public.remove_plaid_item_local('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000003') $q$,
  '%permission denied for function remove_plaid_item_local%');
select th.expect_error($q$ select count(*) from public.card_payment_decisions $q$, '%permission denied for table card_payment_decisions%');
reset role;
