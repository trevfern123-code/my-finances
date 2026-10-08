-- Bump coalescing (20261002120000): the freshness CONTRACT. These are adversarial invalidation tests for
-- card_payment_bump's per-transaction coalescing and the evaluator's marker reset at version capture.
--   * Every assertion is a freshness or invalidation property, so all of them also hold for the
--     uncoalesced 20260930120000 bump. The naive once-per-transaction skip, and the marker mutations, each
--     fail at least one (supabase/tests/card_payment_coalescing_mutations).
--   * Nothing here asserts how MANY increments happened; that is a15, the implementation property.
--   * psql autocommit makes every statement outside begin/commit its own transaction, so post-commit checks
--     read durable state from a new transaction.
-- Setup runs as postgres (the owner); the writes run as service_role, as the backend's do.
insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000aa', 'a14-item-aa2', 'placeholder');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000c1a01', '00000000-0000-0000-0000-000000000001', 'a14-xc', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000c1a02', '00000000-0000-0000-0000-000000000001', 'a14-xk', 'Card', 'credit'),
  ('00000000-0000-0000-0000-0000000c1a03', '00000000-0000-0000-0000-00000000000a', 'a14-xc2', 'Checking 2', 'depository'),
  ('00000000-0000-0000-0000-0000000c1a04', '00000000-0000-0000-0000-00000000000a', 'a14-xk2', 'Card 2', 'credit'),
  ('00000000-0000-0000-0000-0000000c1b01', '00000000-0000-0000-0000-000000000002', 'a14-yc', 'BB Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000c1b02', '00000000-0000-0000-0000-000000000002', 'a14-yk', 'BB Card', 'credit');

create function pg_temp.aa() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000aa'::uuid $$;
create function pg_temp.bb() returns uuid language sql as $$ select '00000000-0000-0000-0000-0000000000bb'::uuid $$;
create function pg_temp.iv(p uuid) returns bigint language sql as $$
  select coalesce((select input_version from public.card_payment_eval_versions where user_id = p), -1) $$;
create function pg_temp.fresh(p uuid) returns boolean language sql as $$
  select coalesce((public.get_card_payment_states(p)->>'fresh')::boolean, false) $$;
create function pg_temp.has_leg(p uuid, p_plaid text) returns boolean language sql as $$
  select exists (select 1 from jsonb_array_elements(public.get_card_payment_states(p)->'legs') l
                 join public.transactions t on t.id = (l->>'transactionId')::uuid where t.plaid_transaction_id = p_plaid) $$;
create function pg_temp.legs_like(p uuid, p_pattern text) returns bigint language sql as $$
  select count(*) from jsonb_array_elements(public.get_card_payment_states(p)->'legs') l
  join public.transactions t on t.id = (l->>'transactionId')::uuid where t.plaid_transaction_id like p_pattern $$;
-- A card-payment cash leg (positive) on aa's checking; dates far apart, so nothing auto-pairs by accident.
create function pg_temp.pay(p_plaid text, p_acct uuid default '00000000-0000-0000-0000-0000000c1a01', p_amount numeric default 10) returns void
language sql as $$ insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override)
  values (p_acct, p_plaid, p_amount, date '2025-01-01' + (abs(hashtext(p_plaid)) % 300), 'credit_card_payment') $$;
create function pg_temp.key(p uuid) returns text language sql as $$ select 'card_payment.bumped_' || replace(p::text, '-', '') $$;
create temporary table ivs (name text primary key, v bigint);
grant all on pg_temp.ivs to service_role;
create function pg_temp.keep(p_name text, p uuid) returns void language sql as $$
  insert into pg_temp.ivs values (p_name, pg_temp.iv(p)) on conflict (name) do update set v = excluded.v $$;
create function pg_temp.kept(p_name text) returns bigint language sql as $$ select v from pg_temp.ivs where name = p_name $$;

set role service_role;
select public.evaluate_card_payments(pg_temp.aa());
select public.evaluate_card_payments(pg_temp.bb());
select th.assert(pg_temp.fresh(pg_temp.aa()) and pg_temp.fresh(pg_temp.bb()), 'setup: both users fresh');

-- ==== 1. Bulk inserts and real updates in one transaction, then a fresh evaluation =========================
select pg_temp.keep('t1', pg_temp.aa());
begin;
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override)
select '00000000-0000-0000-0000-0000000c1a01', 'a14-b-' || g, 100 + g, date '2024-01-01' + g, 'credit_card_payment' from generate_series(1, 200) g;
update public.transactions set amount = amount + 0.01 where plaid_transaction_id like 'a14-b-%' and right(plaid_transaction_id, 1) in ('0', '4');
commit;
select th.assert(pg_temp.iv(pg_temp.aa()) > pg_temp.kept('t1'), '1: the bulk transaction advanced input_version');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '1: and left the user stale');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.fresh(pg_temp.aa()) and pg_temp.legs_like(pg_temp.aa(), 'a14-b-%') = 200, '1: a fresh evaluation covers all 200 rows');

-- ==== 2. Multiple writes before an evaluation ==================================================================
select pg_temp.keep('t2', pg_temp.aa());
begin;
select pg_temp.pay('a14-m-1'); select pg_temp.pay('a14-m-2'); select pg_temp.pay('a14-m-3');
commit;
select th.assert(pg_temp.iv(pg_temp.aa()) > pg_temp.kept('t2') and not pg_temp.fresh(pg_temp.aa()), '2: three writes, stale and advanced');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.legs_like(pg_temp.aa(), 'a14-m-%') = 3, '2: the evaluation includes all three');

-- ==== 3. An evaluation before any write, then a write, in one transaction =====================================
begin;
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.fresh(pg_temp.aa()), '3: fresh right after the in-transaction evaluation');
select pg_temp.pay('a14-e-1');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '3: the write after the evaluation makes it stale inside the transaction');
commit;
select th.assert(not pg_temp.fresh(pg_temp.aa()), '3: still stale after commit');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.has_leg(pg_temp.aa(), 'a14-e-1'), '3: re-evaluation includes the write');

-- ==== 4. Repeated write / evaluate / write cycles in one transaction ==========================================
begin;
select pg_temp.pay('a14-c-1');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.fresh(pg_temp.aa()), '4: fresh after the first evaluation');
select pg_temp.pay('a14-c-2');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '4: stale after the second write (post-evaluation write re-invalidates)');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.fresh(pg_temp.aa()), '4: fresh after the second evaluation');
select pg_temp.pay('a14-c-3');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '4: stale after the third write');
commit;
select th.assert(not pg_temp.fresh(pg_temp.aa()), '4: the final unevaluated write is not published as current');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.legs_like(pg_temp.aa(), 'a14-c-%') = 3, '4: re-evaluation includes all three cycle writes');

-- ==== 5. The first bump inside a savepoint, rolled back, then a surviving write ================================
select pg_temp.pay('a14-s-0');    -- earlier transaction: the user is already stale
select pg_temp.keep('t5', pg_temp.aa());
begin;
savepoint s;
select pg_temp.pay('a14-s-1');
rollback to savepoint s;
select pg_temp.pay('a14-s-2');
commit;
select th.assert(pg_temp.iv(pg_temp.aa()) > pg_temp.kept('t5'), '5: the surviving write advanced input_version in its own transaction');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '5: stale');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.has_leg(pg_temp.aa(), 'a14-s-2') and not exists (select 1 from public.transactions where plaid_transaction_id = 'a14-s-1'),
  '5: the evaluation includes the surviving write; the rolled-back row does not exist');

-- ==== 6. An earlier bump outside a savepoint; an evaluation and writes inside it; rollback; more work =============
begin;
select pg_temp.pay('a14-q-1');
savepoint s;
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.fresh(pg_temp.aa()), '6: fresh after the evaluation inside the savepoint');
select pg_temp.pay('a14-q-2');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '6: stale after a write inside the savepoint');
rollback to savepoint s;
select th.assert(not pg_temp.fresh(pg_temp.aa()), '6: after rolling the savepoint back, the earlier write still invalidates');
select pg_temp.pay('a14-q-3');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '6: stale after a further write');
savepoint s2;
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.fresh(pg_temp.aa()), '6: fresh after an evaluation in a second savepoint');
select pg_temp.pay('a14-q-4');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '6: a write after that evaluation re-invalidates');
release savepoint s2;
commit;
select th.assert(not pg_temp.fresh(pg_temp.aa()), '6: stale after commit');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.has_leg(pg_temp.aa(), 'a14-q-1') and pg_temp.has_leg(pg_temp.aa(), 'a14-q-3') and pg_temp.has_leg(pg_temp.aa(), 'a14-q-4')
                 and not exists (select 1 from public.transactions where plaid_transaction_id = 'a14-q-2'),
  '6: the evaluation includes q1, q3 and q4; q2 was rolled back');

-- ==== 7. A caught evaluator failure, then further writes and recovery =========================================
begin;
select pg_temp.pay('a14-f-1');
create temporary table cpe_txn (x integer); -- fault injection (as in a10/a11/a13)
select th.assert(not public.try_evaluate_card_payments(pg_temp.aa()), '7: the evaluation fails and is caught');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '7: stale after the failed evaluation');
select pg_temp.pay('a14-f-2');
drop table pg_temp.cpe_txn;
select th.assert(public.try_evaluate_card_payments(pg_temp.aa()), '7: a retry succeeds');
select th.assert(pg_temp.fresh(pg_temp.aa()), '7: fresh after the retry');
select pg_temp.pay('a14-f-3');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '7: a write after the recovered evaluation re-invalidates');
commit;
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.legs_like(pg_temp.aa(), 'a14-f-%') = 3, '7: recovery includes all three writes');

-- ==== 8. Full rollback, then another transaction on the same connection; a leftover session value ===============
begin;
select pg_temp.pay('a14-r-1');
select pg_current_xact_id()::text as rolled_xid \gset
rollback;
-- Behavioural, not implementation: whatever a variant stores, nothing bound to the rolled-back transaction remains.
select th.assert(coalesce(current_setting(pg_temp.key(pg_temp.aa()), true), '') <> :'rolled_xid', '8: the rolled-back transaction''s tracking state did not survive');
select pg_temp.pay('a14-r-0');     -- stale again (a separate transaction)
select pg_temp.keep('t8', pg_temp.aa());
begin;
select pg_temp.pay('a14-r-2');
commit;
select th.assert(pg_temp.iv(pg_temp.aa()) > pg_temp.kept('t8'), '8: the next transaction on the same connection advanced input_version');
-- A value left at SESSION level (a bug, or a pooled connection someone misconfigured) must never suppress a bump.
select set_config(pg_temp.key(pg_temp.aa()), '1', false);
select pg_temp.keep('t8b', pg_temp.aa());
begin;
select pg_temp.pay('a14-r-3');
commit;
select th.assert(pg_temp.iv(pg_temp.aa()) > pg_temp.kept('t8b'), '8: a leftover session-level value did not suppress the bump');
select set_config(pg_temp.key(pg_temp.aa()), '', false);

-- ==== 9. Separate transactions when matching was already stale =================================================
select pg_temp.keep('t9a', pg_temp.aa());
select pg_temp.pay('a14-t-1');
select th.assert(pg_temp.iv(pg_temp.aa()) > pg_temp.kept('t9a'), '9: first transaction advanced');
select pg_temp.keep('t9b', pg_temp.aa());
select pg_temp.pay('a14-t-2');
select th.assert(pg_temp.iv(pg_temp.aa()) > pg_temp.kept('t9b'), '9: a second transaction advanced again although the user was already stale');

-- ==== 10. Multiple users in one transaction =====================================================================
select pg_temp.pay('a14-u-a0');
select pg_temp.pay('a14-u-b0', '00000000-0000-0000-0000-0000000c1b01');   -- both users stale from earlier transactions
select pg_temp.keep('t10a', pg_temp.aa());
select pg_temp.keep('t10b', pg_temp.bb());
begin;
select pg_temp.pay('a14-u-a1');
select pg_temp.pay('a14-u-b1', '00000000-0000-0000-0000-0000000c1b01');
select pg_temp.pay('a14-u-a2');
select pg_temp.pay('a14-u-b2', '00000000-0000-0000-0000-0000000c1b01');
commit;
select th.assert(pg_temp.iv(pg_temp.aa()) > pg_temp.kept('t10a') and pg_temp.iv(pg_temp.bb()) > pg_temp.kept('t10b'),
  '10: each user written in the transaction advanced in that transaction');

-- ==== 11. Direct deletes, a multi-account cascade, user deletion =================================================
select public.evaluate_card_payments(pg_temp.aa());
select pg_temp.keep('t11a', pg_temp.aa());
delete from public.transactions where plaid_transaction_id like 'a14-b-%';
select th.assert(pg_temp.iv(pg_temp.aa()) > pg_temp.kept('t11a') and not pg_temp.fresh(pg_temp.aa()), '11: a direct multi-row delete invalidates');
select pg_temp.pay('a14-k2-c', '00000000-0000-0000-0000-0000000c1a03', 21);
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override)
values ('00000000-0000-0000-0000-0000000c1a04', 'a14-k2-k', -21, '2025-03-01', 'credit_card_payment');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.has_leg(pg_temp.aa(), 'a14-k2-c'), '11: the second item''s legs are evaluated');
select pg_temp.keep('t11b', pg_temp.aa());
begin;
select pg_temp.pay('a14-k2-before');           -- a bump earlier in the same transaction
delete from public.plaid_items where id = '00000000-0000-0000-0000-00000000000a';  -- cascades two accounts and their rows
commit;
select th.assert(pg_temp.iv(pg_temp.aa()) > pg_temp.kept('t11b') and not pg_temp.fresh(pg_temp.aa()), '11: the multi-account cascade invalidates');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(not pg_temp.has_leg(pg_temp.aa(), 'a14-k2-c') and pg_temp.has_leg(pg_temp.aa(), 'a14-k2-before'),
  '11: after re-evaluation the cascaded legs are gone and the earlier write is present');
reset role;
-- User deletion while a bump for that user already happened in the same transaction (the vanishing-user guard).
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000cc', 'cc@example.test');
begin;
insert into public.transaction_carryovers (user_id, account_id, pending_plaid_transaction_id, pending_transaction_row_id,
                                           pending_amount, pending_date, needs_review, expires_at)
values ('00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-0000000c1b01', 'a14-cc', gen_random_uuid(), 1, '2026-09-01', false, now() + interval '1 day');
delete from auth.users where id = '00000000-0000-0000-0000-0000000000cc';
commit;
select th.assert(not exists (select 1 from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000cc'),
  '11: user deletion after an in-transaction bump succeeds and leaves no version row');

-- ==== 12. A missing version row, a never-evaluated user, NULL evaluated_version ===================================
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000dd', 'dd@example.test');
insert into public.plaid_items (id, user_id, plaid_item_id, access_token) values
  ('00000000-0000-0000-0000-00000000000d', '00000000-0000-0000-0000-0000000000dd', 'a14-item-dd', 'placeholder');
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000c1d01', '00000000-0000-0000-0000-00000000000d', 'a14-dc', 'DD Checking', 'depository');
delete from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000dd';
set role service_role;
begin;
select pg_temp.pay('a14-dd-1', '00000000-0000-0000-0000-0000000c1d01');
select pg_temp.pay('a14-dd-2', '00000000-0000-0000-0000-0000000c1d01');
commit;
select th.assert((select input_version >= 1 and evaluated_version is null from public.card_payment_eval_versions
                  where user_id = '00000000-0000-0000-0000-0000000000dd'), '12: the row was recreated, never evaluated');
select th.assert(not pg_temp.fresh('00000000-0000-0000-0000-0000000000dd'), '12: a never-evaluated user is not fresh');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000dd');
select th.assert(pg_temp.fresh('00000000-0000-0000-0000-0000000000dd')
                 and pg_temp.has_leg('00000000-0000-0000-0000-0000000000dd', 'a14-dd-1')
                 and pg_temp.has_leg('00000000-0000-0000-0000-0000000000dd', 'a14-dd-2'), '12: its first evaluation covers both writes');

-- ==== 13. Decision-RPC compare-and-set across a multi-write transaction ===========================================
select pg_temp.pay('a14-cas-pay', '00000000-0000-0000-0000-0000000c1a01', 77.77);
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override)
values ('00000000-0000-0000-0000-0000000c1a02', 'a14-cas-card', -77.77, '2024-12-01', 'credit_card_payment');
select public.evaluate_card_payments(pg_temp.aa());
select pg_temp.keep('t13', pg_temp.aa());
begin;
select pg_temp.pay('a14-cas-1'); select pg_temp.pay('a14-cas-2');
commit;
select th.expect_error(format('select public.link_card_payment(%L, (select id from public.transactions where plaid_transaction_id = %L), (select id from public.transactions where plaid_transaction_id = %L), 0, %s)',
                              pg_temp.aa(), 'a14-cas-pay', 'a14-cas-card', pg_temp.kept('t13')),
                       'card_payment_stale_version:%');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert((public.link_card_payment(pg_temp.aa(), (select id from public.transactions where plaid_transaction_id = 'a14-cas-pay'),
                   (select id from public.transactions where plaid_transaction_id = 'a14-cas-card'), 0, pg_temp.iv(pg_temp.aa()))->>'status') = 'saved',
  '13: refused with the pre-transaction version; accepted with the fresh one');

-- ==== 14. An input write AFTER the evaluator's version capture and BEFORE its publication ===============
-- TEST-ONLY fault injection, never present in runtime SQL. When armed, a statement trigger on
-- card_payment_leg_states makes ONE input write. The evaluator writes that table after reading its inputs
-- and before publishing, so the write lands between capture and publication. It exists only in this
-- disposable database and is dropped at the end of this section. The evaluator's marker reset
-- (step 3a) makes that write bump even when this transaction bumped the user earlier. Without the reset,
-- the write is coalesced and the publication is stamped fresh while missing it.
reset role;
create schema a14_inject;
create function a14_inject.write() returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if coalesce(current_setting('a14.inject_row', true), '') <> '' then
    update public.transactions set amount = amount + 1 where plaid_transaction_id = current_setting('a14.inject_row');
    perform set_config('a14.inject_row', '', false);
  end if;
  return null;
end $$;
grant usage on schema a14_inject to service_role;
create trigger a14_inject after insert on public.card_payment_leg_states for each statement execute function a14_inject.write();
create function pg_temp.arm(p_plaid text) returns void language sql as $$ select set_config('a14.inject_row', p_plaid, false) $$;
create function pg_temp.injected() returns boolean language sql as $$ select coalesce(current_setting('a14.inject_row', true), '') = '' $$;
create function pg_temp.cents(p uuid, p_plaid text) returns bigint language sql as $$
  select (l->>'amountCents')::bigint from jsonb_array_elements(public.get_card_payment_states(p)->'legs') l
  join public.transactions t on t.id = (l->>'transactionId')::uuid where t.plaid_transaction_id = p_plaid $$;
set role service_role;
select pg_temp.pay('a14-i-base');     -- the row the injected write changes (10.00 → 11.00, 12.00, …)
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.fresh(pg_temp.aa()) and pg_temp.cents(pg_temp.aa(), 'a14-i-base') = 1000, '14: setup fresh at 10.00');

-- 14a. The transaction bumped earlier (its marker is set), then evaluates; the injected write follows the capture.
begin;
select pg_temp.pay('a14-i-1');
select pg_temp.arm('a14-i-base');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.injected(), '14a: the injected write ran inside the evaluation');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '14a: a write after the capture leaves the publication stale, inside the transaction');
commit;
select th.assert(not pg_temp.fresh(pg_temp.aa()) and public.get_card_payment_states(pg_temp.aa())->'legs' is null,
  '14a: after commit the user is stale and no states are readable');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.fresh(pg_temp.aa()) and pg_temp.cents(pg_temp.aa(), 'a14-i-base') = 1100 and pg_temp.has_leg(pg_temp.aa(), 'a14-i-1'),
  '14a: the next evaluation includes both the earlier and the injected write');

-- 14b. The same through try_evaluate_card_payments (the evaluation runs in a subtransaction).
begin;
select pg_temp.pay('a14-i-2');
select pg_temp.arm('a14-i-base');
select th.assert(public.try_evaluate_card_payments(pg_temp.aa()), '14b: the evaluation succeeds');
select th.assert(pg_temp.injected() and not pg_temp.fresh(pg_temp.aa()), '14b: the injected write ran and left the publication stale');
commit;
select th.assert(not pg_temp.fresh(pg_temp.aa()), '14b: stale after commit');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.cents(pg_temp.aa(), 'a14-i-base') = 1200, '14b: the next evaluation includes the injected write');

-- 14c. Control: no earlier bump in the transaction (no marker to clear).
begin;
select pg_temp.arm('a14-i-base');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.injected() and not pg_temp.fresh(pg_temp.aa()), '14c: stale without an earlier bump too');
commit;
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.cents(pg_temp.aa(), 'a14-i-base') = 1300, '14c: the next evaluation includes the injected write');

-- 14d. Through a decision RPC: its decision insert bumps (setting the marker), then its own evaluation
-- captures, and the injected write follows.
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override) values
  ('00000000-0000-0000-0000-0000000c1a01', 'a14-l-pay', 55.55, '2024-06-01', 'credit_card_payment'),
  ('00000000-0000-0000-0000-0000000c1a02', 'a14-l-card', -55.55, '2024-08-01', 'credit_card_payment');
select public.evaluate_card_payments(pg_temp.aa());
select pg_temp.arm('a14-i-base');
select th.assert((public.link_card_payment(pg_temp.aa(), (select id from public.transactions where plaid_transaction_id = 'a14-l-pay'),
                   (select id from public.transactions where plaid_transaction_id = 'a14-l-card'), 0, pg_temp.iv(pg_temp.aa()))->>'status') = 'saved',
  '14d: the link is saved');
select th.assert(pg_temp.injected() and not pg_temp.fresh(pg_temp.aa()), '14d: the injected write ran inside the RPC and left the user stale');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.cents(pg_temp.aa(), 'a14-i-base') = 1400
                 and (select l->>'decisionId' from jsonb_array_elements(public.get_card_payment_states(pg_temp.aa())->'legs') l
                      join public.transactions t on t.id = (l->>'transactionId')::uuid where t.plaid_transaction_id = 'a14-l-pay') is not null,
  '14d: the next evaluation includes the injected write and the saved decision');

-- 14e. After a FAILED evaluation (its reset is rolled back with it), a successful evaluation still resets.
begin;
select pg_temp.pay('a14-i-3');
create temporary table cpe_txn (x integer);
select th.assert(not public.try_evaluate_card_payments(pg_temp.aa()), '14e: the first evaluation fails and is caught');
drop table pg_temp.cpe_txn;
select pg_temp.arm('a14-i-base');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.injected() and not pg_temp.fresh(pg_temp.aa()), '14e: the retried evaluation with an injected write leaves the user stale');
commit;
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.cents(pg_temp.aa(), 'a14-i-base') = 1500 and pg_temp.has_leg(pg_temp.aa(), 'a14-i-3'),
  '14e: the next evaluation includes both writes');
reset role;
drop schema a14_inject cascade;   -- removes the test-only trigger
set role service_role;

-- ==== 15. The evaluator's reset under savepoints ==============================================================
-- An evaluation inside a savepoint that is rolled back takes its publication AND its reset with it. The
-- earlier bump's lock and marker stand, so a later write may coalesce into it, and must still be included.
begin;
select pg_temp.pay('a14-v-1');
savepoint s;
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.fresh(pg_temp.aa()), '15: fresh inside the savepoint');
rollback to savepoint s;
select th.assert(not pg_temp.fresh(pg_temp.aa()), '15: rolling the savepoint back restores the stale row');
select pg_temp.pay('a14-v-2');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '15: still stale after a further write');
savepoint s2;
select public.evaluate_card_payments(pg_temp.aa());
release savepoint s2;
select th.assert(pg_temp.fresh(pg_temp.aa()), '15: a released evaluation stands');
select pg_temp.pay('a14-v-3');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '15: a write after the released evaluation re-invalidates');
commit;
select th.assert(not pg_temp.fresh(pg_temp.aa()), '15: stale after commit');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.legs_like(pg_temp.aa(), 'a14-v-%') = 3, '15: the next evaluation includes all three writes');

-- ==== 16. The marker is not reachable from client-facing paths ================================================
-- Only the two internal functions name the marker, neither is executable by a client role, and no function
-- a client role can execute calls set_config at all (so none can set a card_payment.* value).
reset role;
select th.assert((select coalesce(array_agg(p.proname::text order by p.proname), '{}') from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_(toast_)?temp_'
                    and p.prosrc like '%card\_payment.bumped\_%')
                 <@ array['card_payment_bump', 'evaluate_card_payments'],
  '16: no function other than card_payment_bump and evaluate_card_payments names the coalescing marker');
select th.assert(not exists (select 1 from pg_proc p
                             where p.oid in ('public.card_payment_bump(uuid)'::regprocedure,
                                             'public.evaluate_card_payments(uuid, timestamp with time zone)'::regprocedure)
                               and (has_function_privilege('public', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')
                                    or has_function_privilege('authenticated', p.oid, 'execute'))),
  '16: neither is executable by a client role');
select th.assert(not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                             where n.nspname in ('public', 'graphql_public') and p.prosrc ilike '%set\_config%'
                               and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))),
  '16: no function in an API-exposed schema that a client role can execute calls set_config');

-- ==== 17. A fresh row is never skipped, whoever made it fresh ===================================================
-- The bump re-checks staleness itself (condition (c)), so its correctness does not depend on every
-- publisher clearing the marker. Here freshness is published by a path other than the evaluator: a direct
-- UPDATE, which leaves this transaction's marker set. The next input write must still invalidate.
set role service_role;
begin;
select pg_temp.pay('a14-p-1');
update public.card_payment_eval_versions set evaluated_version = input_version where user_id = pg_temp.aa();
select th.assert(pg_temp.fresh(pg_temp.aa()), '17: made fresh by a path that does not clear the marker');
select pg_temp.pay('a14-p-2');
select th.assert(not pg_temp.fresh(pg_temp.aa()), '17: the next input write still invalidates (a skip requires a stale row)');
commit;
select th.assert(not pg_temp.fresh(pg_temp.aa()), '17: stale after commit');
select public.evaluate_card_payments(pg_temp.aa());
select th.assert(pg_temp.has_leg(pg_temp.aa(), 'a14-p-1') and pg_temp.has_leg(pg_temp.aa(), 'a14-p-2'), '17: re-evaluation includes both writes');
