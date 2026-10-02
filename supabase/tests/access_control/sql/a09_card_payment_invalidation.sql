-- Card-payment input invalidation (CARD_PAYMENT_PAIRING_DESIGN.md §3.7; acceptance tests 13 and 16d):
-- every input change advances the owner's input_version IN THE WRITER'S OWN TRANSACTION; non-input
-- changes and same-value updates do not; cascades are covered level by level; a decision naming
-- another user's account is refused at write time (§3.5).
set role service_role;

insert into public.accounts (id, item_id, plaid_account_id, name, type) values
  ('00000000-0000-0000-0000-0000000009a1', '00000000-0000-0000-0000-000000000001', 'inv-c', 'Checking', 'depository'),
  ('00000000-0000-0000-0000-0000000009a2', '00000000-0000-0000-0000-000000000001', 'inv-x', 'Card', 'credit'),
  ('00000000-0000-0000-0000-0000000009b1', '00000000-0000-0000-0000-000000000002', 'inv-b', 'BB Checking', 'depository');

create function pg_temp.v(p_user text) returns bigint
language sql as $$ select coalesce((select input_version from public.card_payment_eval_versions where user_id = p_user::uuid), 0) $$;
create function pg_temp.check_bump(p_label text, p_sql text, p_aa int, p_bb int default 0) returns void
language plpgsql as $$
declare
  a0 bigint := pg_temp.v('00000000-0000-0000-0000-0000000000aa');
  b0 bigint := pg_temp.v('00000000-0000-0000-0000-0000000000bb');
begin
  execute p_sql;
  perform th.assert(pg_temp.v('00000000-0000-0000-0000-0000000000aa') - a0 = p_aa,
    format('%s: aa bumped by %s (expected %s)', p_label, pg_temp.v('00000000-0000-0000-0000-0000000000aa') - a0, p_aa));
  perform th.assert(pg_temp.v('00000000-0000-0000-0000-0000000000bb') - b0 = p_bb,
    format('%s: bb bumped by %s (expected %s)', p_label, pg_temp.v('00000000-0000-0000-0000-0000000000bb') - b0, p_bb));
end $$;

-- Account inserts bumped already (three of them: aa twice, bb once).
select th.assert(pg_temp.v('00000000-0000-0000-0000-0000000000aa') = 2 and pg_temp.v('00000000-0000-0000-0000-0000000000bb') = 1,
  'account inserts bumped their owners');

-- ---- transactions: insert, delete, every listed column; nothing else -----------------------------------
select pg_temp.check_bump('transaction insert', $q$
  insert into public.transactions (id, account_id, plaid_transaction_id, amount, date, user_role_override) values
    ('00000000-0000-0000-0000-0000000009d1', '00000000-0000-0000-0000-0000000009a1', 'inv-t1', 100, '2026-09-01', 'credit_card_payment') $q$, 1);
select pg_temp.check_bump('amount', $q$ update public.transactions set amount = 98 where plaid_transaction_id = 'inv-t1' $q$, 1);
select pg_temp.check_bump('date', $q$ update public.transactions set date = '2026-09-02' where plaid_transaction_id = 'inv-t1' $q$, 1);
select pg_temp.check_bump('pending', $q$ update public.transactions set pending = true where plaid_transaction_id = 'inv-t1' $q$, 1);
select pg_temp.check_bump('pending_transaction_id', $q$ update public.transactions set pending_transaction_id = 'inv-p' where plaid_transaction_id = 'inv-t1' $q$, 1);
select pg_temp.check_bump('user_role_override', $q$ update public.transactions set user_role_override = 'expense' where plaid_transaction_id = 'inv-t1' $q$, 1);
select pg_temp.check_bump('auto_role', $q$ update public.transactions set auto_role = 'credit_card_payment', role_source = 'category_detailed', role_confidence = 'high'
                                            where plaid_transaction_id = 'inv-t1' $q$, 1);
select pg_temp.check_bump('plaid_transaction_id', $q$ update public.transactions set plaid_transaction_id = 'inv-t1b' where plaid_transaction_id = 'inv-t1' $q$, 1);
select pg_temp.check_bump('account_id within the user', $q$ update public.transactions set account_id = '00000000-0000-0000-0000-0000000009a2' where plaid_transaction_id = 'inv-t1b' $q$, 1);
select pg_temp.check_bump('account_id to another user (both users)', $q$ update public.transactions set account_id = '00000000-0000-0000-0000-0000000009b1' where plaid_transaction_id = 'inv-t1b' $q$, 1, 1);
select pg_temp.check_bump('back to aa', $q$ update public.transactions set account_id = '00000000-0000-0000-0000-0000000009a1' where plaid_transaction_id = 'inv-t1b' $q$, 1, 1);
-- Non-input columns and same-value updates do not bump (16d-style scope for transactions).
select pg_temp.check_bump('name / merchant / needs_review / review_note', $q$
  update public.transactions set name = 'x', merchant_name = 'y', needs_review = true, review_note = 'z' where plaid_transaction_id = 'inv-t1b' $q$, 0);
select pg_temp.check_bump('amount to its current value', $q$ update public.transactions set amount = amount where plaid_transaction_id = 'inv-t1b' $q$, 0);
select pg_temp.check_bump('transaction delete', $q$ delete from public.transactions where plaid_transaction_id = 'inv-t1b' $q$, 1);

-- ---- accounts: type, exclusion, item; not cosmetic columns (16d) ---------------------------------------
select pg_temp.check_bump('account type', $q$ update public.accounts set type = 'loan' where id = '00000000-0000-0000-0000-0000000009a1' $q$, 1);
select pg_temp.check_bump('account type NULL', $q$ update public.accounts set type = null where id = '00000000-0000-0000-0000-0000000009a1' $q$, 1);
select pg_temp.check_bump('exclude_from_cash_flow', $q$ update public.accounts set exclude_from_cash_flow = true where id = '00000000-0000-0000-0000-0000000009a1' $q$, 1);
select pg_temp.check_bump('exclude_from_cash_flow to its current value', $q$ update public.accounts set exclude_from_cash_flow = true where id = '00000000-0000-0000-0000-0000000009a1' $q$, 0);
select pg_temp.check_bump('nickname / color / sort_order', $q$ update public.accounts set nickname = 'n', color = 'blue', sort_order = 3 where id = '00000000-0000-0000-0000-0000000009a1' $q$, 0);
select pg_temp.check_bump('item_id to another user (both)', $q$ update public.accounts set item_id = '00000000-0000-0000-0000-000000000002' where id = '00000000-0000-0000-0000-0000000009a1' $q$, 1, 1);
select pg_temp.check_bump('item_id back', $q$ update public.accounts set item_id = '00000000-0000-0000-0000-000000000001', exclude_from_cash_flow = false, type = 'depository' where id = '00000000-0000-0000-0000-0000000009a1' $q$, 1, 1);

-- ---- decisions: any change; ownership refused at write time --------------------------------------------
select pg_temp.check_bump('decision insert', $q$
  insert into public.card_payment_decisions (id, user_id, kind, a_account_id, a_plaid_transaction_id, a_cents) values
    ('00000000-0000-0000-0000-0000000009e1', '00000000-0000-0000-0000-0000000000aa', 'destination_unlinked', '00000000-0000-0000-0000-0000000009a1', 'inv-x1', 100) $q$, 1);
select pg_temp.check_bump('decision update (undo)', $q$ update public.card_payment_decisions set superseded_by = gen_random_uuid() where id = '00000000-0000-0000-0000-0000000009e1' $q$, 1);
select pg_temp.check_bump('decision delete', $q$ delete from public.card_payment_decisions where id = '00000000-0000-0000-0000-0000000009e1' $q$, 1);
select th.expect_error($q$
  insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents) values
    ('00000000-0000-0000-0000-0000000000aa', 'destination_unlinked', '00000000-0000-0000-0000-0000000009b1', 'inv-x2', 100) $q$,
  '%card_payment_decision_foreign_account%');
select th.expect_error($q$
  insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, b_account_id, b_plaid_transaction_id, b_cents, accepted_difference_cents) values
    ('00000000-0000-0000-0000-0000000000aa', 'pair', '00000000-0000-0000-0000-0000000009a1', 'inv-x3', 100, '00000000-0000-0000-0000-0000000009b1', 'inv-x4', -100, 0) $q$,
  '%card_payment_decision_foreign_account%');
select th.expect_error($q$
  insert into public.card_payment_decisions (user_id, kind, a_account_id, a_plaid_transaction_id, a_cents, accepted_difference_cents) values
    ('00000000-0000-0000-0000-0000000000aa', 'pair', '00000000-0000-0000-0000-0000000009a1', 'inv-x5', 100, 0) $q$,
  '%card_payment_decisions_legs_check%');

-- ---- carry-overs: insert, consumed/expiry changes, delete; not other columns ---------------------------
select pg_temp.check_bump('carry-over insert', $q$
  insert into public.transaction_carryovers (user_id, account_id, pending_plaid_transaction_id, pending_transaction_row_id,
                                             pending_amount, pending_date, needs_review, expires_at) values
    ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-0000000009a1', 'inv-pend', gen_random_uuid(), 100, '2026-09-01', false, now() + interval '30 days') $q$, 1);
select pg_temp.check_bump('carry-over expiry', $q$ update public.transaction_carryovers set expires_at = now() + interval '1 day' where pending_plaid_transaction_id = 'inv-pend' $q$, 1);
select pg_temp.check_bump('carry-over needs_review (not an input)', $q$ update public.transaction_carryovers set needs_review = true where pending_plaid_transaction_id = 'inv-pend' $q$, 0);
select pg_temp.check_bump('carry-over delete', $q$ delete from public.transaction_carryovers where pending_plaid_transaction_id = 'inv-pend' $q$, 1);

-- ---- the bump lives and dies with the writer's transaction ----------------------------------------------
select th.assert(true, 'marker');
create temp table rollback_probe as select pg_temp.v('00000000-0000-0000-0000-0000000000aa') as before;
begin;
insert into public.transactions (account_id, plaid_transaction_id, amount, date) values ('00000000-0000-0000-0000-0000000009a1', 'inv-rb', 5, '2026-09-01');
select th.assert(pg_temp.v('00000000-0000-0000-0000-0000000000aa') = (select before from rollback_probe) + 1, 'the bump is visible inside the writer transaction');
rollback;
select th.assert(pg_temp.v('00000000-0000-0000-0000-0000000000aa') = (select before from rollback_probe), 'a rolled-back write leaves no bump');

-- ---- cascades: LIM-style item removal and account deletion bump the owner; user deletion succeeds ------
insert into public.transactions (account_id, plaid_transaction_id, amount, date) values
  ('00000000-0000-0000-0000-0000000009a2', 'inv-casc', 7, '2026-09-01');
select pg_temp.check_bump('account delete (cascades its transactions)', $q$ delete from public.accounts where id = '00000000-0000-0000-0000-0000000009a2' $q$, 1);
reset role;
select th.assert(pg_temp.v('00000000-0000-0000-0000-0000000000aa') > 0, 'aa has a version row');
do $$
declare
  a0 bigint := (select input_version from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa');
begin
  delete from public.plaid_items where id = '00000000-0000-0000-0000-000000000001';
  perform th.assert((select input_version from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000aa') > a0,
    'deleting an item (cascading its accounts and transactions) bumps its owner');
end $$;
-- Deleting a user whose cascade fires a bump must not fail on the vanishing user. (The pre-existing
-- plaid_items → auth.users foreign key does not cascade, so a user with items cannot be deleted at all;
-- a carry-over does cascade, which exercises the bump's guard: no version row exists, the cascade's
-- bump tries to create one for a user being deleted, and that is tolerated.)
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000cc', 'cc@example.test');
insert into public.transaction_carryovers (user_id, account_id, pending_plaid_transaction_id, pending_transaction_row_id,
                                           pending_amount, pending_date, needs_review, expires_at) values
  ('00000000-0000-0000-0000-0000000000cc', '00000000-0000-0000-0000-0000000009b1', 'inv-cc', gen_random_uuid(), 1, '2026-09-01', false, now());
delete from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000cc';
delete from auth.users where id = '00000000-0000-0000-0000-0000000000cc';
select th.assert(not exists (select 1 from public.card_payment_eval_versions where user_id = '00000000-0000-0000-0000-0000000000cc'),
  'a deleted user leaves no version row, and its cascade did not fail');
