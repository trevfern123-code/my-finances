-- Bump coalescing (20261002120000): IMPLEMENTATION PROPERTIES, kept separate from the freshness contract
-- (a14). How many version-row increments a transaction makes, and where the transaction-local marker
-- stands. The uncoalesced 20260930120000 bump fails this file by design. None of it is a financial or
-- freshness contract; input_version's exact value never was one.
insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000c1e01', '00000000-0000-0000-0000-000000000001', 'a15-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000c1e02', '00000000-0000-0000-0000-000000000002', 'a15-b', 'BB Checking', 'depository');
create function pg_temp.iv(p uuid) returns bigint language sql as $$
  select input_version from public.card_payment_eval_versions where user_id = p $$;
create temporary table base (u uuid primary key, v bigint);
grant all on pg_temp.base to service_role;
create function pg_temp.mark() returns void language sql as $$
  delete from pg_temp.base;
  insert into pg_temp.base select user_id, input_version from public.card_payment_eval_versions $$;
create function pg_temp.delta(p uuid) returns bigint language sql as $$
  select pg_temp.iv(p) - (select v from pg_temp.base where u = p) $$;
create function pg_temp.check(p_label text, p_aa bigint, p_bb bigint default 0) returns void language plpgsql as $$
begin
  perform th.assert(pg_temp.delta('00000000-0000-0000-0000-0000000000aa') = p_aa and pg_temp.delta('00000000-0000-0000-0000-0000000000bb') = p_bb,
    format('%s: deltas aa=%s bb=%s (expected %s, %s)', p_label, pg_temp.delta('00000000-0000-0000-0000-0000000000aa'),
           pg_temp.delta('00000000-0000-0000-0000-0000000000bb'), p_aa, p_bb));
end $$;
set role service_role;
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000bb');

select pg_temp.mark();
insert into public.transactions (account_id, plaid_transaction_id, amount, date, user_role_override)
select '00000000-0000-0000-0000-0000000c1e01', 'a15-' || g, g, date '2025-01-01' + g, 'credit_card_payment' from generate_series(1, 300) g;
select pg_temp.check('one 300-row statement', 1);

select pg_temp.mark();
begin;
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-1';
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-2';
delete from public.transactions where plaid_transaction_id = 'a15-3';
commit;
select pg_temp.check('three statements in one transaction', 1);

select pg_temp.mark();
begin;
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-4';
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-5';
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-6';
commit;
select pg_temp.check('write, evaluate, two writes', 2);

select pg_temp.mark();
begin;
update public.transactions set amount = amount + 1 where account_id = '00000000-0000-0000-0000-0000000c1e01' and amount < 50;
insert into public.transactions (account_id, plaid_transaction_id, amount, date) values
  ('00000000-0000-0000-0000-0000000c1e02', 'a15-b1', 1, '2025-02-01'), ('00000000-0000-0000-0000-0000000c1e02', 'a15-b2', 2, '2025-02-02');
update public.transactions set amount = amount + 1 where account_id = '00000000-0000-0000-0000-0000000c1e01' and amount >= 50;
commit;
select pg_temp.check('two users in one transaction', 1, 1);

select pg_temp.mark();
begin;
savepoint s;
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-7';
rollback to savepoint s;
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-8';
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-9';
commit;
select pg_temp.check('a rolled-back savepoint bump, then two writes', 1);

-- The marker is transaction-local: nothing is left after a commit or a rollback (so a pooled
-- connection starts clean even before the transaction-id binding is consulted).
create function pg_temp.marker() returns text language sql as $$
  select coalesce(current_setting('card_payment.bumped_' || replace('00000000-0000-0000-0000-0000000000aa', '-', ''), true), '') $$;
begin;
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-10';
select th.assert(pg_temp.marker() = pg_current_xact_id()::text, 'inside the transaction the marker is bound to it');
commit;
select th.assert(pg_temp.marker() = '', 'no marker after commit');
begin;
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-11';
rollback;
select th.assert(pg_temp.marker() = '', 'no marker after rollback');

-- The evaluator clears the marker at version capture (step 3a), and the clearing is transactional like the
-- marker itself: a rolled-back savepoint, or a failed (caught) evaluation, restores the earlier marker
-- together with the earlier bump it records.
begin;
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-12';
select th.assert(pg_temp.marker() = pg_current_xact_id()::text, 'marker set by the bump');
savepoint s;
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(pg_temp.marker() = '', 'the evaluation cleared the marker');
rollback to savepoint s;
select th.assert(pg_temp.marker() = pg_current_xact_id()::text, 'rolling the savepoint back restores the marker');
create temporary table cpe_txn (x integer);
select th.assert(not public.try_evaluate_card_payments('00000000-0000-0000-0000-0000000000aa'), 'the evaluation fails and is caught');
select th.assert(pg_temp.marker() = pg_current_xact_id()::text, 'a failed evaluation leaves the marker as it was');
drop table pg_temp.cpe_txn;
select public.evaluate_card_payments('00000000-0000-0000-0000-0000000000aa');
select th.assert(pg_temp.marker() = '', 'a successful evaluation clears it');
update public.transactions set amount = amount + 1 where plaid_transaction_id = 'a15-13';
select th.assert(pg_temp.marker() = pg_current_xact_id()::text, 'the next write bumps and sets it again');
commit;
